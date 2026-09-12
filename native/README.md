# Local image generation

## Build and run

From the project root:

```powershell
npm run native:build
npm run dev
```

The build script clones pinned revisions of stable-diffusion.cpp, vision.cpp, and IXWebSocket into `third_party/`, initializes their submodules, and runs the `clang-vulkan` CMake configure/build presets. Existing dependency checkouts are retained. Models and native build output are ignored by Git.

Windows prerequisites: CMake 3.28+, Ninja, LLVM/Clang with clang-cl and lld-link, Visual Studio C++ build tools, a Windows SDK, and the Vulkan SDK for the Vulkan preset. CMake, Ninja, and LLVM must be on PATH. The toolchain discovers the MSVC/Windows SDK headers and libraries itself; a developer shell or vcvars is not needed.

Equivalent direct commands, after `npm run native:setup`:

```powershell
cd native
cmake --preset clang-vulkan
cmake --build --preset clang-vulkan
```

The editor remains usable when the backend is missing or unavailable. The Generate tool reports the connection error. Restart Electron after building the backend or changing its configuration.

## Packaged application

`npm run dist` builds the `clang-vulkan-release` preset and packages the native process with Electron. `npm run dist -- --preset clang-cpu-release` selects CPU inference. See the [production packaging instructions](../README.md#windows-production-package).

In an installed app, the executable and its runtime DLLs live in `resources/native/` outside the ASAR archive. Logs and editable model definitions live under Electron's writable user-data directory. Set `TEXEL_MODELS_DIR` to reuse an existing models folder and `TEXEL_MODELS_CONFIG` to use custom definitions. The default development paths below still apply when running from source.

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

The UI lists it as `local/miaomiaoHarem_anima16`. The diffusion model is advertised only when all three configured files exist. The model context is loaded on demand and retained between requests. Switching between diffusion and removal releases the previous model context.

### MI-GAN removal

The toolbar's **Remove selection** action uses [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) through [vision.cpp](https://github.com/Acly/vision.cpp), inside the existing `imged-native` process. It uses Vulkan with the Vulkan preset and CPU with the CPU preset; `IMGED_INFERENCE_BACKEND=CPU` also forces CPU removal. No Python runtime or separate command-line program is involved.

The model definition in `native/models.json` points to `models/inpaint/MIGAN-512-places2-F16.gguf`. Download the [converted weights](https://huggingface.co/Acly/MIGAN-GGUF/resolve/6c410de2373fe94080e739642339b3e9f748b034/MIGAN-512-places2-F16.gguf) from Acly's model repository into that location (14,758,080 bytes). SHA-256: `3e47592bf716d0dc306f8dc02d4476cfcdaf2c055fa3c3c8e0ced4db775eb64b`. These weights and MI-GAN are MIT licensed. For an existing installed app, also copy the removal entry from `native/models.json` into its editable model definitions. Rebuild the native backend and restart Electron after adding this integration.

Removal requires an active selection. It measures that selection on the GPU and takes a crop of the visible composition with surrounding context, independent of generation prompts, lens placement, scale, and feather settings. The native adapter pads rectangular crops without stretching them, resizes to the model's 512 × 512 resolution, and uses white mask coverage for removal. Max coverage during mask reduction keeps thin selections in the model input. Large crops are reduced to at most 2048 pixels per side for transport; the full-resolution soft selection stays on the GPU and is applied once to the result.

Completion adds a **Removed selection** layer above the existing root children and records one **Remove selection** undo operation. The top bar and Escape support cancellation. Input and selection are frozen when captured; replacing the document cancels the operation. MI-GAN inference has no intermediate previews or interrupt callback, so cancellation discards the result; the existing timeout restarts the native process if necessary.

`native/vision/` adds a small C adapter to the vision.cpp library. CMake builds it as `texel-vision` with its own statically linked GGML, isolated from stable-diffusion.cpp's GGML revision. Only the library target is built. The existing native packaging step includes its DLL and dependency licenses.

## Using generation

1. Press **G** or choose **Tools → Generate image**. The generation lens initially covers the canvas.
2. Drag the lens to move it, use its bounds handles to resize, and use the round handle to rotate. Width, height, X, and Y use canonical canvas units. **Fit canvas** restores the full canvas frame. Lens transforms support undo.
3. Choose **Scale** to set output resolution independently of the lens. A 1000 × 1000 lens at 0.5× generates 500 × 500 pixels. The resulting layer is scaled and rotated to fit that lens exactly.
4. Enter a prompt, choose the model/settings, optionally set **Feather**, and click **Generate**.
5. Watch the step counter and small latent preview. The canvas shows a temporary preview layer with an animated overlay. Click **Cancel**, the top-bar cancel button, or press **Escape** to stop.

Denoise controls how much the input is replaced; 100% starts with full noise. Seed -1 chooses a new random seed. This first local backend uses Euler sampling and the model's default schedule. Local generation accepts dimensions from 1 to 2048 per side. Inputs are edge-padded to at least 64 pixels and multiples of 16, and final PNGs are cropped to the requested pixel dimensions.

The input is the full visible composition, including layers above the selected layer, sampled through the lens's position, rotation, and size. Transparent reference pixels are flattened over white for inference. The lens, reference image, and selection are frozen for each request.

An active selection is sampled into the same coordinates and sent as an inpainting mask. White means regenerate, black means preserve, and gray gives partial final coverage. **Feather** adds a smooth black fade at the lens edges, measured in canonical canvas units; it multiplies the selection when one exists, or creates an edge mask otherwise. The native adapter converts nonzero coverage to binary support for the sampler, while the editor retains the soft mask and applies it once to the generated layer's alpha. An empty mask is rejected before inference.

Completion adds a new **Generated image** layer at the top of the root group and records one **Generate image** undo operation. Existing layer pixels remain unchanged. Cancellation removes the temporary preview and adds no history entry. Replacing the document cancels its request. Changing the lens or selection later does not change a running request's frozen inputs.

**Layer → New sized layer…** remains available independently of generation. **New layer** creates a full-canvas layer directly.

## Architecture and protocol

`GenerationProvider` in `src/generation/provider.ts` defines model discovery, generation settings/image inputs, progress/preview events, and an AbortSignal. Providers register by source prefix; model IDs may contain further slashes, allowing future IDs such as `openrouter/openai/...`. Only the local provider is implemented.

Electron starts the native process when the app opens. The binary binds an available port on 127.0.0.1 and writes a JSON `ready` record containing the port and protocol version to stdout. Electron passes the URL and a random per-launch token through the sandboxed preload bridge. The renderer opens a WebSocket and authenticates with `{type: "hello", token}`. The native process then sends model discovery. Diagnostic logs go to `native/backend.log`.

Binary messages begin with a four-byte little-endian JSON header length, followed by the UTF-8 JSON header and payload:

- Request: `type: generate`, request ID, model ID, prompt/negativePrompt, width/height, steps/guidance/strength/seed, inputBytes/maskBytes. Payload: tightly packed sRGB RGBA8 input, then optional linear grayscale RGBA8 selection/feather mask data.
- Removal uses the same packet layout with `type: remove`, a removal model ID, an empty prompt, and a required mask. Discovery entries carry `task: generate | remove`; removal models stay out of the prompt-generation model selector.
- Preview/result: `type: preview | result`, request ID, width/height, and step. Payload: PNG bytes.
- Text messages: progress phase/step/steps, errors, cancel requests, and cancellation acknowledgements.

Each process handles one generation at a time. Requests use configured model IDs rather than supplied model paths. Disconnects cancel their running request. Cancellation calls the library cancellation API; if it cannot acknowledge promptly (for example, during model loading), Electron restarts the process. App shutdown asks the child to exit, then terminates it if necessary.

Pixel editing, input composition, mask alignment, preview blending, and undo snapshots stay on the GPU. Full image readback occurs only at the inference boundary. PNG decoding uploads the result immediately; CPU arrays are transport data, not an editor pixel store. Low-resolution previews are coalesced and do not trigger layer-thumbnail DOM refreshes.

## Validation

`npm run native:smoke` launches the binary, authenticates, generates a deterministic 512 × 512 image, checks PNG dimensions/previews, and cancels a masked request. It saves `native/build/smoke-result.png`. Optional `IMGED_SMOKE_WIDTH`, `IMGED_SMOKE_HEIGHT`, and `IMGED_SMOKE_STRENGTH` exercise other dimensions/denoise settings.

An Electron integration run checked white selection painting outside mask edit mode, brightness painting inside mask edit mode, automatic empty-selection deactivation and undo, lens dragging/resizing/rotation, inclusion of upper layers in the reference image, and feather-mask transfer. It generated a 500 × 500 layer for a rotated 1000 × 1000 lens at 0.5×, verified live previews without source mutation, soft output alpha, exact placement, and one-step layer creation undo/redo. Cancellation followed by another request and forced backend recovery were also exercised. Native checks have covered both 512 × 512 generation and 500 × 333 padded generation with the supplied model.
