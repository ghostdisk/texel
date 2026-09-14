import type { Editor } from '../editor';
import { ImageLayer } from '../model/layers';
import { maxScale } from '../model/geometry';
import type { Point } from '../model/geometry';
import { BrushLikeTool } from './brush-like-tool';
import type { ToolPointer } from './tool';

export class BrushTool extends BrushLikeTool {
  readonly id = 'brush';
  readonly label = 'Brush';
  readonly cursor = 'crosshair';
  readonly hint = 'Paint on a pixel layer · Shift-click to draw a line · Hold Space to pan · Scroll to zoom';

  constructor(editor: Editor) { super(editor, { size: 36, hardness: 1, flow: 1 }); }

  pointerDown(pointer: ToolPointer): void {
    const layer = this.beginDrawing();
    if (!layer) return;
    this.startStroke(pointer);
  }

  protected stamp(point: Point, pressure: number): void {
    const layer = this.drawing!.layer;
    this.paint({
      x: point.x, y: point.y, radius: this.size * Math.max(0.05, pressure) / 2, hardness: this.hardness,
      color: this.editor.drawingColor(layer, this.flow),
    });
  }

  hover(pointer: ToolPointer | null): void {
    const cursor = this.editor.brushCursor;
    const layer = this.editor.paintTarget;
    cursor.hidden = !pointer || !(layer instanceof ImageLayer) || this.editor.panHeld;
    if (cursor.hidden || !pointer || !layer) return;
    const diameter = this.size * maxScale(layer.worldTransform()) * this.editor.viewport.scale;
    cursor.style.left = `${pointer.screen.x}px`;
    cursor.style.top = `${pointer.screen.y}px`;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
  }

  drawUI(container: HTMLElement): void { this.drawBrushControls(container); }
}
