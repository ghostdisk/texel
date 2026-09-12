# Texel

Texel is an Electron + TypeScript image editor. Pixel sources, brush operations, filter intermediates, snapshots, and composition live on the GPU.

## Running

Use Node.js 22.12 or newer:

```sh
npm install
npm run dev
```

Closing Electron stops the development server. `npm run build` followed by `npm start` opens the production renderer. Changes to the Electron main process or preload require restarting the Electron application.

## Windows production package

On an x64 Windows machine, install the dependencies with `npm ci`, then run:

```powershell
npm run dist
```

This builds the production renderer and the native C++ backend, stages native runtime dependencies, and packages Electron, Chromium, Node.js, and the application into:

- `release/Texel-0.1.0-Setup.exe`: an assisted installer with shortcuts, an uninstaller, and the .txl file association.
- `release/win-unpacked/Texel.exe`: the runnable app. Distribute the **whole win-unpacked folder**, including resources and DLLs.

`npm run package:dir` produces just the app folder. Build outputs go in `release/`; the native staging directory is `.packaging/native/`. Both are ignored by Git. The version and installer filename follow `package.json`.

The build machine needs the [native build prerequisites](native/README.md#build-and-run), including the Vulkan SDK for the default preset. The app includes its runtime; end users need no Node.js, CMake, Visual Studio tools, or Vulkan SDK. Vulkan inference uses the installed GPU driver. To package the CPU backend instead:

```powershell
npm run dist -- --preset clang-cpu-release
```

The distribution presets use a static C/C++ runtime and a baseline x64 CPU target, avoiding build-machine-specific instruction sets. Development presets retain their current optimization settings. The Electron Vulkan loader is also copied beside the native executable. Backend selection stays outside the renderer protocol.

Double-clicking a .txl file opens it in Texel. If Texel is already running, that window is restored and receives the file. Requests arriving during startup or another file operation wait until the editor is ready, and unsaved changes use the usual Save / Discard / Cancel prompt. The unpacked executable also accepts file paths, for example `Texel.exe "D:\Art\painting.txl"`.

Model weights are external. Packaged Texel uses `TEXEL_MODELS_DIR` when set, then a `models/` directory next to Texel.exe if present, otherwise `%APPDATA%/Texel/models/`. To use this checkout's models:

```powershell
$env:TEXEL_MODELS_DIR = 'D:\texel\models'
& '.\release\win-unpacked\Texel.exe'
```

The first packaged launch seeds editable model definitions at `%APPDATA%/Texel/models.json`. Paths in that file are relative to the selected models directory. `TEXEL_MODELS_CONFIG` overrides the definitions file; `TEXEL_NATIVE_BINARY` can override the executable. Logs go to `%APPDATA%/Texel/logs/native-backend.log`. App updates and uninstallation preserve user data and external model files.

The packaging script does not publish artifacts. Signing is optional and can be configured through electron-builder's usual certificate environment settings.

## Documents

**Ctrl+N** creates a document, **Ctrl+O** opens a Texel .txl file, **Ctrl+S** saves, and **Ctrl+Shift+S** saves under a new name. **File → Export** writes the full-resolution visible composition as a transparent PNG or WebP, separately from the editable .txl project. **Add image… / Ctrl+Shift+O** imports an image as a layer. New, Open, and closing the window offer Save / Discard / Cancel when the document has unsaved edits.

TXL version 1 uses a small binary header, a JSON metadata chunk, and a binary chunk of lossless half-float source pixels. It retains canonical dimensions, layer/group structure, transforms, filters, masks, selections, and the generation lens. See [the format specification](docs/txl-format.md).

## Local image generation

Build the native backend with `npm run native:build`, then restart Electron. Press **G** to position, resize, and rotate a generation lens. Scale sets the output resolution independently of the lens; completion creates a new layer fitted to it. Generation supports live previews, selection inpainting, edge feathering, cancellation, and undo. **Layer → New sized layer…** creates a separate layer at the desired resolution. See [native/README.md](native/README.md) for models, Clang/CMake setup, backend selection, and the provider protocol.

With a selection active, click **Remove selection** in the left toolbar (or **Edit → Remove selection**) to fill it using MI-GAN. Removal samples the visible composition around the selection and adds a **Removed selection** layer with the original soft selection coverage and one undo entry. It needs no prompt or generation lens. **Cancel removal** or **Escape** cancels it. MI-GAN runs through vision.cpp inside the existing native backend; see [weight installation](native/README.md#mi-gan-removal).

## Navigation and tools

- Scroll to zoom around the cursor. Hold Space and drag to pan with either tool; middle-button dragging also pans. Click the zoom percentage or View → Fit image to fit the frame.
- **B** selects Brush. Size, hardness, and flow appear in the horizontal tool-options bar. Size is a diameter in the layer's native pixels; pen pressure changes that diameter.
- **V** selects Move / transform. Ctrl-click visible pixels to select their layer; transparent areas pass through to layers below. Drag the selected layer to move it, drag its eight bounds handles to resize, and drag the round handle to rotate. Shift constrains movement, corner resizing, or rotation. Position, scale, and rotation fields appear only in this tool.
- **I** selects Eyedropper. Hold **Alt** with Brush to sample temporarily; releasing Alt restores Brush. Samples come from the filtered composition, excluding the checkerboard, and update the foreground color.
- **Delete** deletes the selected layer or group. **Ctrl+J** duplicates it, including independent source pixels, descendants, and filters.
- **F2** or a double-click on a layer label starts inline renaming. Enter commits; Escape cancels.
- Drag a layer near the top/bottom of a row to reorder it. Drop in the middle of a group to reparent it. Dropping on Document moves it into the root. Reparenting preserves placement in document coordinates and rejects cycles.
- **Ctrl+Z** undoes; **Ctrl+Shift+Z** or **Ctrl+Y** redoes. The **History** tab beside **Layers** lists retained states; clicking a row returns to that state. Text input keeps its ordinary editing shortcuts.
- File provides document/layer creation and native image import. Images can also be pasted or dropped. Filter is populated from registered filter classes and applies to the selected layer, including Document.

The custom titlebar contains the application menus and native window controls. **F10** focuses the menu bar; arrow keys navigate its buttons. Layers and History share the upper sidebar, with Filters below. Layer visibility uses the eye button; layer opacity supports numeric entry and a dropdown slider. Generate keeps its model and prompt in the tool-options bar, with additional settings and its preview in popovers.

## Selection painting

**S** toggles selection painting. Outside mask edit mode, drawing paints white coverage regardless of the foreground color; erase paints black. Making a mask visible enters mask edit mode, where drawing uses the foreground color's linear brightness instead.

After a committed selection edit, a GPU reduction checks whether its output is empty and reads back one four-byte flag. Empty selections deactivate automatically. The temporary source remains available to history, so undoing the edit restores the selection without an additional undo step.

## Layer reframing

Layer → Reframe operates on the selected pixel layer:

- **Normalize to Canvas — Ctrl+Shift+N**: resample the source with linear filtering into the canonical canvas dimensions, baking its current world placement into the pixels. Content outside the canvas is cropped; uncovered pixels are transparent. The resulting source is aligned one-to-one with the canvas. In a transformed group, the local matrix cancels the ancestor transform to maintain that alignment.
- **Trim Transparent Borders**: crop to the smallest integer rectangle containing all source pixels with nonzero alpha. Pixels are copied exactly, and the local origin shifts with the transform to keep their placement. An entirely transparent layer becomes 1 × 1.
- **Extend to Canvas**: first discard empty borders, then expand the source rectangle to contain both its remaining content and all four canvas corners transformed into layer coordinates. Bounds round outward to whole native pixels. Rotation, scale, shear, and reflections are retained; existing pixels are copied exactly and padding is transparent. An empty layer uses the canvas bounds in its local coordinate system.

These operations affect source pixels and leave filter stacks editable. Normalize changes the source resolution, so filters expressed in local pixels operate at the new resolution. Trim and Extend measure source alpha before filters. Groups keep their bounds derived from children and do not expose these pixel-buffer commands.

Each command produces one undo entry with full before/after GPU source snapshots and transform matrices. GPU alpha reduction reads back only four bounds coordinates. Briefly pausing edits during that readback prevents painting or history changes from invalidating the measurement. Layer dimensions remain subject to the GPU's texture size limit; an oversized extension fails before changing the layer.

## Editing model

`Layer` is the common base for transforms, opacity, visibility, blending, and ordered filters. `ImageLayer` owns its editable `sourceTexture`. Every layer has a derived `outputTexture` owned by the compositor. `GroupLayer` contains children in bottom-to-top order. The root group represents the whole composition, so its filters replace the need for adjustment layers.

The document has canonical pixel dimensions fixed at creation, exposed as "width" and "height" on ImageDocument. These dimensions define the canvas rectangle and initial layer size. Each image layer still has its own native resolution and affine transform into its parent. A 2000 × 2000 source stays at that resolution when transformed onto a 500 × 500 canvas. Groups rasterize their transformed children at a density chosen for the current view. Presentation clips to the canvas; layer pixels outside it remain available.

Working textures contain premultiplied linear-light `rgba16float` pixels. Imports upload a temporary `ImageBitmap` into an sRGB texture, then convert and premultiply on the GPU. Presentation converts back to sRGB over a checkerboard. CPU-side arrays contain commands, parameters, and metadata. Readbacks include sampled colors, histograms, bounds, 64 × 64 layer previews, project-file transport, and explicit image-generation inputs; editable pixels remain on the GPU.

Content edits invalidate their layer and ancestors. Placement edits invalidate the parent composite. The compositor processes children before parents and reuses clean results; panning only changes presentation. Pending paint, filters, and composition are submitted in order. Snapshot boundaries flush pending painting before copying pixels, without waiting for GPU completion on the CPU.

Normal uses premultiplied source-over. Add uses additive RGB with source-over alpha. Groups are isolated before their own filters, opacity, and parent blending.

## Actions and tools

`src/actions.ts` contains `ActionRegistry`. An action has an ID, label, handler, optional enabled predicate, and optional menu group. Buttons, native menu clicks, and keybindings dispatch those same IDs. Initial bindings are assigned in `Editor.registerActions()`; there is no rebinding UI. Hold actions have a release handler, used for temporary Space-panning. Key handling skips editable controls, open dialogs, and popovers, and clears held actions on focus loss.

`src/tools/tool.ts` defines the `Tool` base class: pointer gestures, completion/cancellation, options UI, overlay rendering, and `applyUndo`. Brush and transform implementations live beside it. The editor owns camera gestures above the active tool, so Space works regardless of tool selection. Switching tools or invoking a document action finishes the current gesture first.

## Filters

`Filter` in `src/filters/filter.ts` owns rendering, output bounds, serialization/deserialization, undo application, and UI drawing. The common UI supplies enable/remove controls; subclasses implement parameter controls and parameter serialization.

To add a filter, subclass `Filter` and register a `FilterDefinition`. The registry recreates serialized filters and supplies their menu entries. The layer model and compositor contain no blur-specific dispatch. The compositor calls `filter.render(context, input)`; the context gives the filter a frame encoder, quad renderer, and reusable intermediate surfaces scoped to that filter's ID.

`BlurFilter` uses a separable Gaussian compute shader with shared-memory tiles and padding. Broad raster kernels use a lower-resolution working surface before resampling. Sigma is expressed in the layer/group's local units. Filter stack order is preserved by serialization, duplication, and undo.

## Undo

`UndoOperation` holds a label, an undo JSON payload, a redo JSON payload, and any GPU snapshots referenced by those payloads. Payloads contain `type`, `targetId`, `action`, and `data`. The types currently dispatched are:

- `image`: add/delete layers and groups, or reorder/regroup existing layers.
- `layer`: properties, pixel restoration, reframing (source dimensions and transform), and add/remove filter operations with serialized filter data.
- `filter`: restore that filter's serialized state.
- `tool`: brush pixel restoration and transform gesture matrices.

Each target class accepts `applyUndo(operation, direction)`. JSON describes an operation; GPU textures are held separately under snapshot IDs. `serialize()` and `deserialize()` round-trip metadata with an accompanying GPU snapshot map. This is in-memory history, not an on-disk project format.

Brush strokes keep complete before/after source snapshots. Transform drags and filter slider gestures store before/after values as a single entry. Layer/group deletion stores serialized structure and source snapshots; restoration preserves IDs. Duplication creates new IDs and independent pixel textures.

New edits discard redo entries. Evicted entries destroy their snapshots. History keeps at most 100 entries and approximately 256 MiB of snapshots, retaining the latest operation even when that operation alone exceeds the budget. Creating a new document clears its previous history.

## Source map and current boundaries

- `src/editor.ts`: coordination, action setup, input routing, and history dispatch.
- `src/ui/editor-view.ts`: layer dragging, inline renaming, inspector, and filter UI contexts.
- `src/ui/tabs.ts`, `src/ui/popover.ts`: reusable panel navigation and compact control popovers.
- `src/ui/history-panel.ts`, `src/ui/titlebar.ts`: history navigation and custom titlebar menus.
- `src/assets/icons.svg`: shared tool and interface SVG symbols, including gradient AI icons.
- `assets/branding/`: app and TXL file icons, plus the titlebar mark; packaging uses this resource directory.
- `src/model/`: image structure, layer types, serialization, and affine geometry.
- `src/history/`, `src/tools/`, `src/filters/`: operation history and extensible editing classes.
- `src/gpu/`, `src/shaders/`: GPU allocation, painting, composition, blur, and presentation.
- `electron/`: native menus, image dialog, and sandboxed preload bridge.

Textures remain monolithic. Group rasterization is capped to GPU texture limits and roughly 16 megapixels per group so zooming can magnify cached output without unbounded allocations. There is no tiled backing store, dirty-region evaluation, or complete GPU memory manager. Render statistics remain available internally; the status bar shows zoom.

TXL project files persist editable source pixels and document structure. Undo history remains session-local. Device-loss recovery and remote AI providers are still future work.

## Additional filters

- **Smart blur**: radius 0–32 local pixels and threshold 0–100%. Visits a circular 2D neighborhood, accepts neighbors within the threshold, and averages their premultiplied pixels with Gaussian spatial weights. Similarity uses normalized RMS distance between unpremultiplied sRGB colors, with alpha differences also treated as edges. Out-of-image neighbors are omitted and weights renormalized; layer bounds stay unchanged. Shared-memory tiles reuse neighborhood reads without a separable approximation.
- **Brightness / contrast**: independent −100 to +100 controls, with contrast centered on sRGB mid-gray. Neutral settings bypass the adjustment.
- **Levels**: input black/white points, gamma, and output black/white points. Endpoints use a 0–255 display scale. Input black stays below input white; gamma above 1 brightens midtones. Output endpoints can be reversed for inversion. Neutral settings bypass the adjustment.
- **Posterize**: 2–256 levels per RGB channel, rounded to the nearest level including black and white.

The three color adjustments operate on unpremultiplied sRGB values, preserve alpha, then convert back to the linear premultiplied working format. All four filters use the existing filter registry, serialized state, duplication, and gesture-based undo/redo. Their controls appear on layers and groups, including the root.

## Picking, previews, and filter controls

Magnified layer composition and zoomed presentation use point sampling. The selected layer frame stays dimly visible with editing tools; Move / transform adds resize and rotation handles. Generate shows its independent lens with the same controls.

`GpuReadback` provides batched pixel samples, GPU histogram reduction, and thumbnail conversion. Ctrl-click picking traverses visible layers from front to back using sampled alpha, accumulated group opacity, and filtered group coverage. Visible group effects can select the group when no child covers the sample. The eyedropper uses the same sampling service and coalesces moves while a readback is in flight.

Layer previews replace icons for images and groups. History commits, undo/redo, and document creation queue one batched refresh of changed revisions. The GPU renders 64 × 64 sRGB thumbnails, and the DOM receives only these small images. Live gestures defer preview work; stale results cannot overwrite a newer revision. These are disposable UI caches, separate from authoritative sources and undo snapshots.

Levels displays a histogram of its input before the filter, with black, midtone, and white markers, input numeric fields, and output gradient markers. Dragging a marker or editing values remains one undo gesture. Histograms refresh when the controls are shown or a change is committed.

- **Border** builds a rounded outer stroke from alpha, with width, color, and opacity controls. Wide raster strokes use a reduced-resolution dilation mask, then combine that mask with the full-resolution source.
- **Drop shadow** blurs and offsets alpha behind the source, with color, opacity, angle, distance, and softness controls. The source remains sharp.

Both effects expand their output bounds, remain editable on layers/groups/root, and use the existing serialization and undo paths.
## Opacity, Mix, and filter order

Opacity controls share a slider with a numeric input; layer opacity puts the slider in a dropdown to keep the blend controls compact. This widget also provides precise brush size, hardness, and flow editing. Layer opacity and effect opacity update live and record one undo entry when the edit is committed.

Every filter has Mix, defaulting to 100%, with a slider and numeric input in its card. During compositing, a filter at 100% adds no mixing pass. Below 100%, the compositor runs a pass that reapplies that filter's input at strength 1 - Mix, interpolating premultiplied color and alpha. The result feeds the next filter, so 0% restores the input immediately before this filter. Mix serializes with the filter and uses filter undo/redo and ordinary layer invalidation.

Drag a filter header above or below another card to reorder the stack. Filters run from top to bottom. Reordering preserves filter identities and settings and records one layer undo operation.
