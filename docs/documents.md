# Documents and layers

Texel can keep multiple documents open in tabs. Each document has independent layers, history, viewport, guides, selections, and unsaved state.

## Files

- **New** creates an empty document.
- **Open** reads a Texel `.txl` project or opens a supported image as a new document.
- **Save** and **Save as** write an editable `.txl` project.
- **Export** writes the visible full-resolution composition as PNG or WebP.
- **Add image** imports an image as a new layer in the current document.

Images can also be pasted or dropped into the editor. New, Open, closing a tab, and closing the window prompt before discarding unsaved work. Project saves use a temporary file and replacement so a failed write does not destroy the previous file.

The [TXL format specification](txl-format.md) describes what is stored. Undo history and running generator jobs are session-only.

## Layer model

A document is a tree with an isolated root group. It can contain:

- Pixel layers with their own native resolution
- Text layers with editable typography and cached raster pixels
- Groups containing other layers and groups
- Single-channel layers used as masks or temporary selections

Every layer supports a name, affine transform, opacity, visibility, blend mode, and ordered filter stack. Groups derive their bounds from their children. Reordering or reparenting a layer preserves its document-space placement and rejects circular relationships.

The document width and height define the canvas, not the dimensions of every layer. Content outside the canvas remains available but is clipped during presentation and export.

## Layer operations

You can create, delete, duplicate, rename, group, reorder, reparent, align, distribute, rotate, flip, and merge layers. Multiple selected layers can be moved or transformed together. A group or the document root can carry filters, making root filters useful for whole-document adjustments.

With an active selection, **Layer via Copy** creates a trimmed pixel layer from the selected content. **Layer via Cut** also removes the same soft coverage from the source. Text is copied as pixels by this operation.

## Selections and masks

Selections are GPU-backed soft masks. Selection painting writes coverage rather than the foreground color; erasing removes coverage. An empty selection deactivates automatically after a small GPU reduction and one flag readback.

A selection can restrict painting, clearing, generation, inpainting, and layer-via-copy operations. It can also be promoted into a persistent layer mask. When editing a visible mask directly, drawing uses the foreground color's linear brightness.

## Grid, guides, and snapping

The View menu controls the grid, guides, and snapping. Grid density adapts visually to zoom. Snapping considers the canvas, visible grid lines, guides, and other visible layer edges and centers using a screen-space threshold.

## Reframing pixel layers

Reframing changes an individual pixel layer without flattening its editable filter stack:

- **Normalize to Canvas** resamples the layer into the canvas dimensions and bakes its world placement into the new pixels.
- **Trim Transparent Borders** crops the source to its non-transparent bounds while preserving placement.
- **Extend to Canvas** retains the source pixels and adds transparent space sufficient to cover the canvas in layer coordinates.

These commands preserve transforms where possible and create one undo entry containing before-and-after GPU snapshots. They inspect source alpha before filters.
