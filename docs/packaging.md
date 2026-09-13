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

Distribute the entire `win-unpacked` directory, not only the executable. `npm run package:dir` creates only that directory. Build output is written under `release/`, and native staging uses `.packaging/native/` before electron-builder places it in `resources/packages/texel-editor/local-ai-vulkan/native/`.

The assisted installer selects the OpenRouter, Fal.ai, and Local AI Vulkan packages by default. The user can omit any of them; omitting Local AI Vulkan also omits its base dependency. Use `npm run dist -- --preset clang-cpu-release` for a CPU build. End users do not need Node.js, CMake, compiler tools, or the Vulkan SDK.

Signing is optional and uses the standard electron-builder certificate environment settings. Packaging does not publish artifacts.

External model weights are not bundled. A packaged application searches `TEXEL_MODELS_DIR`, then a `models/` directory beside `Texel.exe`, then its user-data models directory. See [Backend integrations](backend-integrations.md) for all model and backend overrides.

## Local AI runtime package

The local inference runtime is owned by `texel-editor/local-ai-vulkan` and depends on `texel-editor/local-ai-base`. The Vulkan build embeds two large shader sets:

- stable-diffusion.cpp / GGML Vulkan shaders: approximately 46 MiB
- MI-GAN vision runtime / GGML Vulkan shaders: approximately 52.5 MiB

Together they account for roughly 99 MiB. The package keeps the native host, Volk loader, shader kernels, licenses, and model registry versioned together and can be omitted during installation. Model weights remain external until distributed as separate model packages.
