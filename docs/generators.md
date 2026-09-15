# Generators

Texel treats AI operations as editing workflows rather than a separate export step. Generator inputs come from the visible filtered composition, previews appear directly on the canvas, and accepted results become ordinary layers with one undo entry.

Available workflows are:

- **Image generator** for prompted generation or image-to-image editing inside a generation lens
- **Inpaint** for replacing an active selection
- **Object removal** for removing selected content with a compatible model
- **Remove background** for isolating the foreground into a transparent result layer

Models can come from the local backend, OpenRouter, or fal. See [Backend integrations](backend-integrations.md) for configuration and provider details.

## Generation lens

The generation lens defines the document-space area sent to the model and where the result will be placed. Drag it to move, resize it with the bounds handles, and rotate it with the round handle. **Fit canvas** restores it to the full canvas.

Scale controls output resolution independently of lens size. For example, a 1000 × 1000 lens at 0.5× requests a 500 × 500 image, then transforms that result to fit the lens. Lens placement is stored in `.txl` documents and supports undo where the workflow exposes lens editing.

## Running a generator

1. Open a generator from the Tools menu. Press **G** for the image generator.
2. Position the lens and choose a compatible model.
3. Enter the prompt and adjust the settings supported by that model.
4. Optionally select the region to edit and set edge feathering.
5. Start generation, inspect progress and previews, then apply the result.

The model determines which controls are available, including negative prompt, steps, guidance, seed, denoise strength, input images, masks, dimension multiples, and size limits.

The request freezes its input composition, selection, and lens. Later canvas edits do not alter a running request. **Escape** or the cancel button aborts the request. Cancellation removes transient previews and adds no history entry.

## Inputs, masks, and feathering

The input is the visible filtered composition sampled through the lens. Transparent reference pixels are flattened for providers that require an opaque image.

An active selection is aligned to the same coordinates. White coverage marks pixels to regenerate, black preserves them, and gray produces partial final coverage. Feathering multiplies the selection by a smooth fade at the lens edge, or creates an edge mask when there is no selection.

The editor keeps the full soft mask for final blending even when a backend requires binary mask support. Empty required masks are rejected before a request is sent.

## Results and previews

Partial provider previews are decoded into a transient layer and coalesced so slow previews do not queue indefinitely. They are visible in the canvas composition but are not part of the document or layer thumbnail history.

Applying a completed result creates a pixel layer fitted to the lens. The source layers remain unchanged. If the document is replaced or the generator is closed, its transient resources and running request are discarded.

## Data boundary

Composition, selection alignment, feathering, preview blending, and undo snapshots remain on the GPU. A full image readback happens only when encoding input for an external provider. Returned images are decoded and uploaded back to the GPU immediately.
