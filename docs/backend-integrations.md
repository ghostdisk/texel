# Backend integrations

Generators use a common provider interface for model discovery, capability metadata, generation requests, progress, previews, cancellation, and final images. The current providers are Local, OpenRouter, and fal.

Provider model IDs are namespaced by platform. The model registry merges provider results and exposes only the controls supported by each model. One provider failing to load does not hide models returned by the others.

## Hosted providers

OpenRouter and fal run through Electron rather than directly from the renderer. Their API keys are stored with Electron's safe storage, requests are validated by the main process, and progress events return through the sandboxed preload bridge.

Add or update keys from Texel's settings, then refresh AI models. Hosted providers may expose different dimensions, input requirements, masks, or generation controls; the generator UI follows the capabilities returned for the selected model.

Cancellation is forwarded to the provider integration. Provider errors appear in the generator without changing the document.

## Local provider

Electron starts the optional `imged-native` C++ process and reads a single JSON readiness message from its standard output. The process listens only on `127.0.0.1`. Electron gives the renderer its WebSocket URL and a random per-launch authentication token through the preload bridge.

After authentication, the backend advertises models whose configured files exist. It handles one request at a time and keeps the active model context loaded between compatible requests. The current native runtime integrates stable-diffusion.cpp for image generation and vision.cpp/MI-GAN for object removal.

The editor remains usable when the native backend or model weights are missing. Only local generation is unavailable.

## Building the local backend

Windows development requires CMake 3.28 or newer, Ninja, LLVM/Clang with `clang-cl` and `lld-link`, Visual Studio C++ build tools, a Windows SDK, and the Vulkan SDK for the default preset. CMake, Ninja, and LLVM must be on `PATH`.

From the project root:

```powershell
npm run native:build
npm run dev
```

The setup step clones pinned revisions of stable-diffusion.cpp, vision.cpp, and IXWebSocket and initializes their submodules. Existing dependency checkouts are retained. Restart Electron after building or changing native configuration.

To configure and build directly after `npm run native:setup`:

```powershell
cd native
cmake --preset clang-vulkan
cmake --build --preset clang-vulkan
```

## Backend selection

Vulkan is the default development preset. A CPU preset is also included:

```powershell
npm run native:build -- clang-cpu
$env:IMGED_NATIVE_PRESET = 'clang-cpu'
npm run dev
```

| Setting | Purpose |
| --- | --- |
| `IMGED_NATIVE_PRESET` | Select the native development build directory; defaults to `clang-vulkan` |
| `TEXEL_NATIVE_BINARY` | Override the native executable path |
| `IMGED_NATIVE_BINARY` | Legacy development executable override |
| `IMGED_INFERENCE_BACKEND` | Override the inference device; `CPU` forces CPU inference |
| `IMGED_MAX_VRAM` | Set the stable-diffusion.cpp managed VRAM budget in GiB |
| `TEXEL_MODELS_DIR` | Override the model-weights directory |
| `TEXEL_MODELS_CONFIG` | Override the model registry JSON file |

CMake also exposes `IMGED_VULKAN` and `IMGED_CUDA`. Additional combinations can be kept in a local `CMakeUserPresets.json`.

## Local models

`native/models.json` describes local model bundles. Paths are relative to the selected models directory. Diffusion entries specify their diffusion model, text encoder, and VAE. A model is advertised only when all required files are present.

For a development checkout, weights normally live in `models/`. A packaged application uses `TEXEL_MODELS_DIR` when set, then a `models/` directory beside `Texel.exe`, then the application's user-data models directory. Packaged model definitions are copied to the user-data directory so they can be edited.

### MI-GAN object removal

The bundled removal definition expects `models/inpaint/MIGAN-512-places2-F16.gguf`. The converted weights are available from the [Acly MI-GAN GGUF repository](https://huggingface.co/Acly/MIGAN-GGUF/resolve/6c410de2373fe94080e739642339b3e9f748b034/MIGAN-512-places2-F16.gguf).

Expected size: 14,758,080 bytes. SHA-256:

```text
3e47592bf716d0dc306f8dc02d4476cfcdaf2c055fa3c3c8e0ced4db775eb64b
```

Object removal captures the selected area with surrounding visible context, limits transport dimensions to 2048 pixels per side, and retains the full-resolution soft selection for final GPU blending. MI-GAN itself has no intermediate preview or interrupt callback, so cancellation discards its output and may restart the local process after a timeout.

## Local protocol

WebSocket binary packets start with a four-byte little-endian JSON-header length, followed by the UTF-8 header and binary payload.

- A generation request contains its request and model IDs, dimensions, settings, and byte lengths, followed by tightly packed sRGB RGBA8 input and optional mask pixels.
- An object-removal request uses the same layout with `type: remove` and requires an input and mask.
- Preview and result packets contain a JSON header followed by PNG bytes.
- Progress, errors, cancellation, and authentication use text JSON messages.

Requests specify registered model IDs, never arbitrary model paths. Disconnecting cancels the active request. Application shutdown asks the child process to stop and terminates it if it does not exit promptly. Diagnostic output goes to `native/backend.log` in development and the application user-data log directory when packaged.

## Validation

`npm run native:smoke` launches the local process, authenticates, generates an image, checks its PNG dimensions and previews, and exercises cancellation. It writes its result under `native/build/`.
