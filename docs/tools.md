# Tools

Tools operate on the active document and selected layer. The options bar changes with the active tool. Switching tools finishes the current gesture; **Escape** cancels tools that have an in-progress operation.

## Navigation

- Scroll to zoom around the pointer.
- Hold **Space** and drag, or drag with the middle mouse button, to pan.
- Click the zoom percentage or use **View → Fit image** to fit the canvas.
- The grid, guides, and snapping controls live in the View menu.

## Brush

Press **B** to paint on an editable pixel layer or mask. Size, hardness, and flow are set in native layer pixels, and pen pressure changes brush diameter. Hold **Alt** to sample a color temporarily. Press **E** to toggle erase mode.

When selection mode is active, drawing edits selection coverage instead of layer color. A visible mask can also be selected and painted directly.

## Rectangle and ellipse

Press **R** for Rectangle or **O** for Ellipse. Drag to paint a filled shape with the current drawing settings. Hold **Shift** while drawing an ellipse to constrain it to a circle. Both tools support opacity, erase mode, masks, and active-selection clipping.

## Fill

Press **F** to fill pixels matching the clicked source color and alpha. Tolerance controls the match. Contiguous mode fills only the connected region; disabling it fills every matching pixel in the layer.

Fill honors opacity, erase mode, and the active selection. The operation runs as GPU scanline spans and is committed as one history entry. Press **Escape** to cancel a pending fill.

## Lasso tools

Press **L** for Freehand Lasso and drag a closed shape. Press **P** for Polygon Lasso and click to place vertices. Finish a polygon with **Enter**, a double-click, or a click on the first point. **Backspace** removes the last point and **Escape** cancels the path.

These tools use the current drawing mode: they can paint pixels, erase, or build a selection.

## Clone Stamp and Healing Brush

Press **K** for Clone Stamp or **H** for Healing Brush. **Alt-click** a visible point in the selected color image or text layer to set the source, then paint on an editable RGBA pixel layer.

Clone Stamp copies premultiplied source pixels from a frozen snapshot of the stroke source. Healing Brush transfers source detail over the destination's local color. Both provide size, hardness, flow, and aligned-source controls, and both honor erase mode and active selections. They do not edit masks.

## Text

Press **T**, then click the canvas to create text or click selected text to edit it. The options bar controls font, size, style, color, and alignment; the text editor also supports multiline content and line height. Press **Ctrl+Enter** to finish editing.

Text remains editable and supports transforms and filters. Pixel-only operations do not modify its text properties. **Layer via Copy** creates a pixel copy of selected text.

## Move and transform

Press **V** to move or transform selected layers. **Ctrl-click** visible pixels to select the layer under the pointer; transparent areas pass through to lower layers.

- Drag inside the bounds to move.
- Drag one of the eight handles to resize.
- Drag the round handle to rotate.
- Hold **Shift** to constrain movement, corner resizing, or rotation.
- Hold **Alt** to bypass snapping.
- Use the arrow keys to nudge by one document pixel, or **Shift+Arrow** for ten.

The options bar also provides numeric position, scale, and rotation plus alignment, distribution, 90-degree rotation, and flipping. One layer aligns to the canvas; multiple layers align to their combined bounds.

## Crop

Press **C** and drag a rectangle, or adjust its handles. Choose a free, original, or common aspect ratio and press **Enter** or **Apply**. **Escape** cancels.

Cropping changes the canvas bounds without resampling layers. Pixels outside the new canvas remain in their layers.

## Eyedropper

Press **I** to sample from the filtered visible composition. The checkerboard is excluded. Holding **Alt** while using a compatible painting tool temporarily activates the eyedropper and returns to the previous tool when released.

## Common shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Ctrl+A` | Select all |
| `Ctrl+D` | Deselect |
| `Ctrl+J` | Duplicate, or Layer via Copy with a selection |
| `Ctrl+Shift+J` | Layer via Cut |
| `Ctrl+G` | Group selected layers |
| `Ctrl+E` | Merge selected layers |
| `Delete` | Clear selected pixels or delete selected layers |
| `F2` | Rename the selected layer |
| `Ctrl+P` | Open the command palette |
