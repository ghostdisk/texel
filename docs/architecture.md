# Architecture

Texel is an Electron application with a TypeScript renderer and a small optional C++ process for local AI inference. The renderer is sandboxed: operating-system features are exposed through the preload bridge rather than direct Node.js access.

## Application structure

`src/main.ts` creates the GPU device, editor, settings, title bar, and main view. `Editor` is the coordinator for documents, actions, input, tools, rendering, files, and generators.

Each open tab owns an `EditorDocument`, which keeps its own `ImageDocument`, viewport, undo stack, save state, selection state, and generation lens. UI code observes the editor and renders controls; editing behavior lives in the model, tool, filter, and generator classes rather than in DOM handlers.

Electron owns windows, native menus, file dialogs, safe document writes, clipboard access, encrypted provider keys, and the lifecycle of the local inference process. The preload script exposes a narrow `window.desktop` API to the renderer.

## GPU-first editing

Working images use premultiplied, linear-light `rgba16float` textures. Masks use single-channel half-float textures. Imports are converted from sRGB and premultiplied on the GPU; presentation converts back to sRGB over the configured canvas background.

Editable source pixels, paint operations, filter intermediates, layer composites, and undo snapshots remain on the GPU. CPU readback is limited to operations that need it, such as color sampling, histograms, bounds, thumbnails, project files, exports, and AI provider input.

Painting is queued and encoded with the next frame. Snapshot boundaries flush queued paint before copying textures, but do not normally wait for GPU completion on the CPU.

## Layers and composition

`Layer` provides transforms, opacity, visibility, blending, selection state, and an ordered filter stack. `ImageLayer` owns an editable source texture. `TextLayer` adds editable text properties and a rasterized source. `GroupLayer` contains children in bottom-to-top order and isolates their composition.

The root group represents the document and can have filters of its own. Image layers retain their native resolution and use affine transforms into their parent. Cropping changes the canonical canvas rectangle without destructively resampling layer pixels.

Changes increment layer revisions and invalidate ancestors. The compositor evaluates dependencies before consumers, applies filter stacks, and caches clean outputs. Group textures are rasterized at a density appropriate for the current view, subject to texture-size and raster-area limits. Panning changes only presentation and does not rebuild layer content.

Most blend modes are evaluated in premultiplied linear light. Groups are isolated before their own filters, opacity, and parent blend are applied.

## Rendering a frame

At a high level, a frame does the following:

1. Validate and index the layer dependency graph.
2. Encode pending paint operations into source textures.
3. Recursively evaluate changed layers and filter dependencies.
4. Reuse cached outputs for clean branches.
5. Composite the root or the currently edited mask.
6. Present through the viewport and canvas bounds.
7. Draw selection, generation, guide, and tool overlays.

The current backing store is monolithic rather than tiled. There is no general GPU memory manager or device-loss recovery yet.
