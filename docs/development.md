# Building and development

## Requirements

- Node.js 22.12 or newer
- A WebGPU-capable GPU and driver
- npm

Local AI inference has additional native build requirements described in [Backend integrations](backend-integrations.md#building-the-local-backend).

## Start the application

```sh
npm install
npm run dev
```

The development script starts Vite and Electron together. Closing Electron stops the development server. Changes to the Electron main process or preload script require an application restart.

For a production renderer build:

```sh
npm run build
npm start
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and Electron for development |
| `npm run build` | Build the renderer into `dist/` |
| `npm start` | Run Electron with the built renderer |
| `npm run native:build` | Configure and build the local inference backend |
| `npm run native:smoke` | Exercise the native generation protocol |
| `npm run package:dir` | Create an unpacked application directory |
| `npm run dist` | Create the Windows installer and unpacked application |

## Source map

| Path | Responsibility |
| --- | --- |
| `src/editor.ts` | Application coordination, input routing, actions, and history dispatch |
| `src/editor-document.ts` | Per-tab document state |
| `src/model/` | Documents, layers, text, geometry, and layer commands |
| `src/gpu/` | WebGPU resources, painting, composition, masks, readback, and presentation |
| `src/shaders/` | WGSL rendering and compute shaders |
| `src/tools/` | Interactive canvas tools |
| `src/filters/` | Non-destructive filter implementations and controls |
| `src/generators/` | Generator workflows and their UI state |
| `src/generation/` | Provider registry, codecs, and local/hosted providers |
| `src/files/` | Document workflow and TXL encoding |
| `src/ui/` | DOM views and reusable controls |
| `electron/` | Window lifecycle and privileged operating-system integrations |
| `native/` | Optional C++ inference backend |

## Extension points

To add a tool, subclass `Tool`, register it with `Editor`, add its actions and keybindings, and provide any UI or overlay rendering it needs.

To add a filter, subclass `Filter` and register a `FilterDefinition`. A filter owns its serialization, output bounds, GPU rendering, dependency links, and parameter controls. The compositor does not contain filter-specific branches.

To add an AI source, implement `GenerationProvider` and register it in `AIRequestService`. Provider model IDs must begin with the provider platform followed by `/`.

Keep renderer code compatible with Electron's sandbox. New filesystem, secret-storage, or process operations belong behind a validated IPC handler and the preload bridge.

## Related documentation

- [Architecture](architecture.md)
- [Undo and history](undo.md)
- [Backend integrations](backend-integrations.md)
- [Packaging](packaging.md)
- [TXL file format](txl-format.md)
