# Texel packages

Texel packages are directories with a `texel-package.json` manifest. Bundled packages live under `packages/<publisher>/<name>` in development and `resources/packages/<publisher>/<name>` in an installed application.

```json
{
  "schemaVersion": 1,
  "name": "texel-editor/example",
  "displayName": "Example",
  "version": "0.1.0",
  "description": "Example package.",
  "dependencies": ["texel-editor/local-ai-base"],
  "node": "node.cjs",
  "renderer": "renderer.js",
  "files": ["models/**/*", "native/**/*"]
}
```

Dependencies are loaded and initialized before dependents. A missing dependency or dependency cycle prevents application startup. Node and renderer entry points export a package class with optional `onLoad()` and `onUnload()` hooks. The instance is stored at `texel.packages[manifest.name]` in its runtime.

Node package APIs provide:

- `api.messages.handle(name, handler)` and `api.messages.emit(name, value, target)` for scoped renderer communication.
- `api.settings.register(fields)`, `get(key)`, and `set(key, value)` for package-owned settings. Secret fields use Electron secure storage and are never returned to the renderer.
- `api.files.resolve(path)` for files owned by the package.
- `api.packages.get(name)` for initialized dependencies.
- `api.core` and the process-global `texel.core` for core host APIs.

Renderer package APIs provide:

- `api.core.models.registerProvider(provider)` to advertise a model provider to every generator.
- `api.core.models.registerModel(model)` so a separate model package can contribute model metadata to an initialized provider.
- `api.messages.invoke(name, ...args)` and `api.messages.on(name, listener)` for scoped Node communication.
- `api.files.url(path)` for package resources exposed through the package protocol.
- `api.settings.set(key, value)` and `api.core.settings` for package settings.
- `api.packages.get(name)` for initialized renderer dependencies.

The initial local inference split is:

- `texel-editor/local-ai-base`: shared renderer provider, runtime selection, messaging, and lifecycle.
- `texel-editor/local-ai-vulkan`: current stable-diffusion.cpp and vision.cpp executables, generated Vulkan kernels, and the statically linked Volk loader.
- Future runtime packages such as `texel-editor/local-ai-cuda` depend on `local-ai-base` and register another runtime implementation.
- Model packages can depend on `local-ai-base` and carry weights, metadata, tokenizer data, and arbitrary supporting files.

A local model package registers its absolute weight paths with the Node-side `local-ai-base` package through `registerModel()`, and registers its public generator metadata through `texel.core.models.registerModel()` in the renderer. The base writes a combined runtime manifest before starting the selected Vulkan, CUDA, or future local runtime.

OpenRouter and Fal.ai are packages with their own Node request handlers, renderer providers, catalog caches, and namespaced API-key settings.
