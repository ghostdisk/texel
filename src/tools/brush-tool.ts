import type { Editor } from '../editor';
import { ImageLayer } from '../model/layers';
import { inverse, maxScale, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { BrushLikeTool } from './brush-like-tool';
import type { ToolPointer } from './tool';

export class BrushTool extends BrushLikeTool {
  readonly id = 'brush';
  readonly label = 'Brush';
  readonly cursor = 'crosshair';
  readonly hint = 'Paint on a pixel layer · Hold Space to pan · Scroll to zoom';
  private last: Point = { x: 0, y: 0 };

  constructor(editor: Editor) { super(editor, { size: 36, hardness: 1, flow: 1 }); }

  pointerDown(pointer: ToolPointer): void {
    const layer = this.beginDrawing();
    if (!layer) return;
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    this.last = point;
    this.stamp(point, pointer.pressure);
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.drawing;
    if (!gesture) return;
    const point = transformPoint(inverse(gesture.layer.worldTransform()), pointer.world);
    const spacing = Math.max(0.25, this.size * Math.max(0.05, pointer.pressure) * 0.1);
    let distance = Math.hypot(point.x - this.last.x, point.y - this.last.y);
    while (distance >= spacing) {
      const amount = spacing / distance;
      this.last = { x: this.last.x + (point.x - this.last.x) * amount, y: this.last.y + (point.y - this.last.y) * amount };
      this.stamp(this.last, pointer.pressure);
      distance = Math.hypot(point.x - this.last.x, point.y - this.last.y);
    }
  }

  private stamp(point: Point, pressure: number): void {
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
