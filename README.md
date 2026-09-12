# imged

An Electron image editor with a TypeScript renderer and WebGPU painting, composition, and filters.

## Running

Use Node.js 22.12 or newer:

```sh
npm install
npm run dev
```

`dev` starts Vite and Electron together. Closing Electron stops the development server. For a local production bundle, use `npm run build`, then `npm start`. The first install creates the dependency lockfile; Electron currently resolves from its stable `latest` tag.

## The editing model

`Layer` is the common base for content that can have a transform, opacity, visibility, blend mode, and ordered filter stack. `ImageLayer` adds editable pixels. `GroupLayer` contains children in bottom-to-top order. Every document has a root group; its filters process the complete composition.

- `sourceTexture` is an image layer's authoritative, editable GPU texture. Painting targets this texture. Its pixel dimensions belong to the layer.
- `outputTexture` is a derived texture owned by the compositor. It contains the layer's latest evaluated content and filters. Even an image without filters has a separate output texture.
- Filter input and scratch textures are compositor-owned intermediates. Their allocations are reused while their bounds and resolution stay the same.

All working textures are premultiplied, linear-light `rgba16float`. Imported images are decoded into a temporary `ImageBitmap`, uploaded to an sRGB GPU texture, then converted and premultiplied by a fragment shader. The temporary import is released. Brush colors are converted from sRGB to linear values; these are command parameters, not pixel arrays. Presentation converts the composition back to sRGB over a checkerboard. There is no CPU pixel store, pixel readback, or Canvas 2D editing path.

## Framing and coordinates

The document has a **framing rectangle**, not an editable document bitmap. New-document dimensions establish its aspect, logical coordinate system, and the initial image layer's resolution. Layer pixels can be larger or smaller than that frame.

Each layer maps its own coordinates into its parent with a six-component affine matrix `[a, b, c, d, tx, ty]`. A 2000 × 2000 source remains 2000 × 2000 when scaled onto a 500 × 500 frame. Changing its transform does not resample the source.

An evaluated surface records a texture, its local-space bounds, and its rasterization scale. Groups cover the transformed bounds of their visible children. Their resolution follows the presentation density and accumulated transforms, rounded up to power-of-two scale steps to reduce allocation churn. Changing the window's display density can therefore re-evaluate group textures. Image filters operate at the source's native resolution.

Only presentation crops to the framing rectangle. Layers and groups can extend beyond it, including filter padding; pixels outside the frame can contribute to a blur inside it. The first UI fits the frame to the window. View navigation and independently editable framing controls can be added over this coordinate model.

## GPU update path

1. Brush input becomes stamp metadata. A `RenderOperation` encodes commands into an already-open render pass targeting an image's source texture.
2. Content or filter edits invalidate that layer and propagate to the root. Transform, visibility, opacity, and blend changes invalidate the parent composite, preserving the layer's existing effects.
3. Updates are coalesced into one requested animation frame. There is no continuously running render loop while idle.
4. Pending painting is encoded first. The compositor evaluates the tree from children to parents, reusing clean cached outputs.
5. Image evaluation starts from the source texture. Group evaluation first composites the evaluated children. Each enabled filter consumes the previous stage and writes a distinct output.
6. The final root output is presented. Painting, composition, and filter commands share a command submission, without a CPU wait for each pass.

Blur is a separable Gaussian compute shader with shared-memory tiles. The compositor supplies padded input, scratch, and output textures. Kernels wider than 32 raster pixels use a lower-resolution working surface before resampling the result; that broad-blur path is an approximation. The UI exposes sigma from 0 to 32 local pixels. Filters apply in array order and never overwrite source pixels.

Groups are isolated: child blending happens inside the group before group filters, opacity, and blending into the parent. The initial fixed-function blend modes are Normal (premultiplied source-over) and Add (additive RGB with source-over alpha). Add is a defined GPU blend operation, not a claim of Photoshop blend-mode compatibility.

## Controls

- Paint on the selected pixel layer. Size is a diameter in that layer's native pixels; pen pressure affects diameter.
- Add images through the native file dialog, clipboard paste, or file drop. Import preserves native pixel dimensions and uses a transform to fit the frame.
- Create pixel layers at independent resolutions. Create a group while a group is selected to nest it inside that group.
- The Group selector reparents an existing layer while preserving its placement in document coordinates. Arrows change sibling stacking order.
- Edit position, uniform scale, rotation, opacity, and blend mode in Properties. The model itself supports general affine matrices.
- Add, disable, tune, or remove blur filters on any layer. Select Document to edit the root filter stack.

## Source map

- `electron/`: main process, sandboxed preload, and native image dialog.
- `src/model/`: affine geometry and the layer tree.
- `src/gpu/`: GPU resources, command encoding, source image upload, brush operations, compositor, and blur dispatch.
- `src/shaders/`: WGSL brush, composition, blur, and presentation shaders.
- `src/main.ts`: the initial editor controls and pointer input.

## Current boundaries

This is the initial editing implementation. Runtime behavior and GPU performance still need validation on the target machine. The status bar measures CPU command-encoding time, not GPU execution time.

Textures are currently monolithic and each dirty layer or ancestor is re-evaluated in full. GPU texture-size limits are enforced, but there is no tiled backing store, texture memory budget, dirty-region evaluation, mip pyramid, or device-loss recovery. Deep filtered trees and large sources can consume substantial GPU memory. A suitable tile and cache strategy is the next architectural step for very large images.

Undo/redo, project persistence, export, selection masks, further tools/filters, and AI providers are not implemented. Closing, reloading, or replacing the document discards its GPU-resident contents. Future generated or pattern layers can extend the base layer model with their own content evaluation; the parent composition and filter path can remain shared.

Reference documentation: [Electron application setup](https://www.electronjs.org/docs/latest/tutorial/tutorial-first-app), [Vite](https://vite.dev/guide/), and [WebGPU external image upload](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/copyExternalImageToTexture).

