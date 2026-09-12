# Local image generation

## Build and run

From the project root:

```powershell
npm run native:build
npm run dev
```

The build script clones pinned revisions of stable-diffusion.cpp and IXWebSocket into `third_party/`, initializes the diffusion submodules, and runs the `clang-vulkan` CMake configure/build presets. Existing dependency checkouts are retained. Models and native build output are ignored by Git.

Windows prerequisites: CMake 3.27+, Ninja, LLVM/Clang with clang-cl and lld-link, Visual Studio C++ build tools, a Windows SDK, and the Vulkan SDK for the Vulkan preset. CMake, Ninja, and LLVM must be on PATH. The toolchain discovers the MSVC/Windows SDK headers and libraries itself; a developer shell or vcvars is not needed.

Equivalent direct commands, after `npm run native:setup`:

```powershell
cd native
cmake --preset clang-vulkan
cmake --build --preset clang-vulkan
```

The editor remains usable when the backend is missing or unavailable. The Generate tool reports the connection error. Restart Electron after building the backend or changing its configuration.

## Backend selection

Vulkan is the default build preset, not part of the renderer/provider protocol. A CPU preset is included:

```powershell
npm run native:build -- clang-cpu
$env:IMGED_NATIVE_PRESET = 'clang-cpu'
npm run dev
```

| Setting | Purpose |
| --- | --- |
| `IMGED_NATIVE_PRESET` | Build/output preset used by the scripts and Electron; default `clang-vulkan`. |
| `IMGED_NATIVE_BINARY` | Override the executable path used by Electron and the native smoke check. |
| `IMGED_INFERENCE_BACKEND` | Passed to stable-diffusion.cpp's device selector. Unset lets the library choose a compiled backend; `CPU` selects CPU inference. |
| `IMGED_MAX_VRAM` | Optional managed VRAM budget in GiB, using stable-diffusion.cpp's budget syntax. |

CMake also exposes `IMGED_VULKAN` and `IMGED_CUDA`. Other build combinations can be defined in a local `CMakeUserPresets.json`; CUDA requires its toolkit and a compatible host compiler. CPU and CUDA inference have not been benchmarked here. The Vulkan configuration was built with Clang 21.1.8 and exercised on an RTX 3060.

## Models

`native/models.json` registers local model bundles. Paths are relative to `models/`. The included Anima entry uses:

- `diffusion_models/miaomiaoHarem_anima16.safetensors`
- `text_encoders/qwen_3_06b_base.safetensors`
- `vae/qwen_image_vae.safetensors`

The UI lists it as `local/miaomiaoHarem_anima16`. A model is advertised only when all three configured files exist. The provided files are sufficient; no additional model download is required. The model context is loaded on demand and retained between requests. Switching model bundles releases the old context.

## Using generation

1. Select a pixel layer, or use **Layer → New sized layer…** to create one (512 × 512 by default). **New layer** still creates a full-canvas layer directly.
2. Press **G** or choose **Tools → Generate image**.
3. Enter a prompt, choose the model/settings, and click **Generate**.
4. Watch the step counter and small latent preview. The canvas composites the live preview through the layer's filters, with an animated overlay while the request is running.
5. Click **Cancel**, the top-bar cancel button, or press **Escape** to stop.

Denoise controls how much the input is replaced; 100% starts with full noise. Seed -1 chooses a new random seed. This first local backend uses Euler sampling and the model's default schedule. Local generation accepts dimensions from 1 to 2048 per side. Inputs are edge-padded to at least 64 pixels and multiples of 16, and final PNGs are cropped to the requested layer size.

The input is the selected layer and the visible stack behind it, cropped/resampled in the selected layer's native coordinate system. Partial ancestor groups retain their transforms, filters, opacity, and blending. Layers above the target are excluded. Transparent reference pixels are flattened over white for inference.

An active selection is sampled into the same coordinates and sent as an inpainting mask. White means regenerate, black means preserve, and gray gives partial coverage. The final GPU pass blends generated pixels with the original target source through the frozen selection, preserving unselected pixels even when the model changes them. A selection outside the target therefore cannot alter the target.

The source remains unchanged while previews arrive. Completion replaces it and records one **Generate image** undo operation. Cancellation drops the preview and adds no history entry. Editing, transforming, deleting, or replacing the target during a request cancels that request. Changing the selection later does not change the frozen mask for the running generation.

## Architecture and protocol

`GenerationProvider` in `src/generation/provider.ts` defines model discovery, generation settings/image inputs, progress/preview events, and an AbortSignal. Providers register by source prefix; model IDs may contain further slashes, allowing future IDs such as `openrouter/openai/...`. Only the local provider is implemented.

Electron starts the native process when the app opens. The binary binds an available port on 127.0.0.1 and writes a JSON `ready` record containing the port and protocol version to stdout. Electron passes the URL and a random per-launch token through the sandboxed preload bridge. The renderer opens a WebSocket and authenticates with `{type: "hello", token}`. The native process then sends model discovery. Diagnostic logs go to `native/backend.log`.

Binary messages begin with a four-byte little-endian JSON header length, followed by the UTF-8 JSON header and payload:

- Request: `type: generate`, request ID, model ID, prompt/negativePrompt, width/height, steps/guidance/strength/seed, inputBytes/maskBytes. Payload: tightly packed sRGB RGBA8 input, then optional linear grayscale RGBA8 selection data.
- Preview/result: `type: preview | result`, request ID, width/height, and step. Payload: PNG bytes.
- Text messages: progress phase/step/steps, errors, cancel requests, and cancellation acknowledgements.

Each process handles one generation at a time. Requests use configured model IDs rather than supplied model paths. Disconnects cancel their running request. Cancellation calls the library cancellation API; if it cannot acknowledge promptly (for example, during model loading), Electron restarts the process. App shutdown asks the child to exit, then terminates it if necessary.

Pixel editing, input composition, mask alignment, preview blending, and undo snapshots stay on the GPU. Full image readback occurs only at the inference boundary. PNG decoding uploads the result immediately; CPU arrays are transport data, not an editor pixel store. Low-resolution previews are coalesced and do not trigger layer-thumbnail DOM refreshes.

## Validation

`npm run native:smoke` launches the binary, authenticates, generates a deterministic 512 × 512 image, checks PNG dimensions/previews, and cancels a masked request. It saves `native/build/smoke-result.png`. Optional `IMGED_SMOKE_WIDTH`, `IMGED_SMOKE_HEIGHT`, and `IMGED_SMOKE_STRENGTH` exercise other dimensions/denoise settings.

An Electron integration run also checked transformed input composition through group effects, exclusion of upper layers, soft-mask transfer/blending, normal compositor cache restoration, sized-layer creation, live previews without source mutation, completion, undo/redo, and cancellation. Both 512 × 512 generation and 500 × 333 padded generation have been exercised with the supplied model.