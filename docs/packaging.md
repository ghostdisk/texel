# Packaging

## Windows application

On an x64 Windows machine, install dependencies and run:

```powershell
npm ci
npm run dist
```

This builds the production renderer and native backend, stages runtime dependencies, and creates:

- `release/Texel-0.1.0-Setup.exe`, an installer with shortcuts, an uninstaller, and `.txl` file association
- `release/win-unpacked/Texel.exe`, a runnable unpacked application

Distribute the entire `win-unpacked` directory, not only the executable. `npm run package:dir` creates only that directory. Build output is written under `release/`, and native staging uses `.packaging/native/`.

The default package includes the Vulkan backend. Use `npm run dist -- --preset clang-cpu-release` for a CPU build. End users do not need Node.js, CMake, compiler tools, or the Vulkan SDK.

Signing is optional and uses the standard electron-builder certificate environment settings. Packaging does not publish artifacts.

External model weights are not bundled. A packaged application searches `TEXEL_MODELS_DIR`, then a `models/` directory beside `Texel.exe`, then its user-data models directory. See [Backend integrations](backend-integrations.md) for all model and backend overrides.

## Optional AI runtime package

The local inference runtime should move into an optional package or plugin when Texel gains package management. The current Vulkan build embeds two large shader sets:

- stable-diffusion.cpp / GGML Vulkan shaders: approximately 46 MiB
- MI-GAN vision runtime / GGML Vulkan shaders: approximately 52.5 MiB

Together they account for roughly 99 MiB of the unpacked core application. The split should keep the native host and its model registry versioned together with these runtime components, and install them only when a user enables local image generation or local object removal.
