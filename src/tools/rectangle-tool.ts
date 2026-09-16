import { inverse, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

export class RectangleTool extends DrawingTool {
  readonly id = 'rectangle';
  readonly label = 'Rectangle';
  readonly cursor = 'crosshair';
  readonly hint = '';
  override readonly coalescedPointerMoves = false;
  opacity = 1;
  private start: Point = { x: 0, y: 0 };

  pointerDown(pointer: ToolPointer): void {
    const layer = this.beginDrawing();
    if (!layer) return;
    this.start = transformPoint(inverse(layer.worldTransform()), pointer.world);
    this.pointerMove(pointer);
  }

  pointerMove(pointer: ToolPointer): void {
    const layer = this.drawing?.layer;
    if (!layer) return;
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    let dx = point.x - this.start.x;
    let dy = point.y - this.start.y;
    if (pointer.shift) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }
    this.restoreBeforePreview();
    this.paint({
      x: this.start.x + dx / 2, y: this.start.y + dy / 2,
      width: Math.max(1, Math.abs(dx)), height: Math.max(1, Math.abs(dy)),
      radius: 1, hardness: 1, rectangle: true, color: this.editor.drawingColor(layer, this.opacity),
    });
  }

  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }

  drawUI(container: HTMLElement): void {
    container.append(new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', get: () => this.opacity * 100,
      input: (value) => { this.opacity = value / 100; },
    }).element);
  }
}
