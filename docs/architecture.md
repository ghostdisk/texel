# Architecture

Texel is an Electron application with a TypeScript renderer and a small optional C++ process for local AI inference. The renderer is sandboxed: operating-system features are exposed through the preload bridge rather than direct Node.js access.

## Application structure

`src/main.ts` creates the single shared GPU device, editor, settings, title bar, and main view. `Editor` is the coordinator for documents, actions, input, tools, rendering, files, and generators.

Each open tab owns an `EditorDocument`, which keeps its own `ImageDocument`, viewport, undo stack, save state, selection state, and generation lens. UI code observes the editor and renders controls; editing behavior lives in the model, tool, filter, and generator classes rather than in DOM handlers.

Electron owns windows, native menus, file dialogs, safe document writes, clipboard access, encrypted provider keys, and the lifecycle of the local inference process. The preload script exposes a narrow `window.desktop` API to the renderer.

## GPU-first editing

Working images use sparse 256×256 logical chunks with premultiplied, linear-light `rgba16float` pixels. Masks use single-channel half-float textures. Imports are converted from sRGB and premultiplied on the GPU; presentation converts back to sRGB over the configured canvas background.

Editable source pixels, paint operations, filter intermediates, layer composites, and undo snapshots remain on the GPU. CPU readback is limited to operations that need it, such as color sampling, histograms, bounds, thumbnails, project files, exports, and AI provider input.

Chunk records are missing (zero), resident pixels, or an immutable solid color. Solid records share cached 1×1 textures by format and stored color. Normalized sampling works directly; integer loads use a common helper and logical image clipping. The global tile pool recycles resident allocations and bounds its idle caches.

Painting is queued and encoded per touched chunk with the next frame. A write expands a solid chunk or detaches a shared resident chunk; untouched chunks remain shared. Snapshot boundaries flush queued paint and retain chunk references, without a full-image copy. Select All creates white solid records, and Deselect removes the selection while undo retains shared records.

Bucket fill traverses chunk edges on the CPU. Solid chunks take a uniform-color fast path. Resident chunks perform matching and connected-component union on the GPU; reached-component coverage stays on the GPU, and a 148-byte edge/bounds/count summary drives traversal. One temporary workspace is reused across chunks. Full-chunk coverage and eligible bucket writes remain solid records.

## Layers and composition

`Layer` provides transforms, opacity, visibility, blending, selection state, and an ordered filter stack. `ImageLayer` owns an editable sparse source surface. `TextLayer` adds editable text properties and a rasterized source. `GroupLayer` contains children in bottom-to-top order and isolates their composition.

The root group represents the document and can have filters of its own. Image layers retain their native resolution and use affine transforms into their parent. Cropping changes the canonical canvas rectangle without destructively resampling layer pixels.

Changes increment layer revisions and invalidate ancestors. The compositor evaluates dependencies before consumers, applies filter stacks, and caches clean outputs. Group surfaces are rasterized into chunks at a density appropriate for the current view. Unfiltered image layers expose their source directly as output. Panning changes only presentation and does not rebuild layer content.

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

Local filters declare `supportRadius` and dispatch only affected chunks, using one input texture for pointwise filters or a 3×3 neighborhood for spatial filters. Pixel support bounds propagate through the chain without rounding out to whole chunks. Device-loss recovery is not implemented.
