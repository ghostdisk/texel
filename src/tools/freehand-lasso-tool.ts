import { transformPoint, inverse } from '../model/geometry';
import type { Point } from '../model/geometry';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

const MAX_POINTS = 2048;

export class FreehandLassoTool extends DrawingTool {
  readonly id = 'freehand-lasso';
  readonly label = 'Freehand Lasso';
  readonly cursor = 'crosshair';
  readonly hint = 'Drag a closed filled path';
  opacity = 1;
  private points: Point[] = [];
  private lastScreen: Point = { x: 0, y: 0 };

  pointerDown(pointer: ToolPointer): void {
    const layer = this.beginDrawing();
    if (!layer) return;
    this.points = [transformPoint(inverse(layer.worldTransform()), pointer.world)];
    this.lastScreen = pointer.screen;
    this.editor.requestRender();
  }

  pointerMove(pointer: ToolPointer): void {
    const layer = this.drawing?.layer;
    if (!layer || Math.hypot(pointer.screen.x - this.lastScreen.x, pointer.screen.y - this.lastScreen.y) < 1) return;
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    if (this.points.length >= MAX_POINTS) this.points = this.points.filter((_item, index) => index % 2 === 0);
    this.points.push(point);
    this.lastScreen = pointer.screen;
    this.editor.requestRender();
  }

  finish(): void {
    if (!this.drawing) return;
    try {
      if (this.points.length >= 3) {
        this.paintPath(this.points, this.opacity);
        super.finish();
      } else super.cancel();
    } finally {
      this.points = [];
      this.editor.requestRender();
    }
  }

  cancel(): void {
    this.points = [];
    super.cancel();
    this.editor.requestRender();
  }

  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }

  drawOverlay(): void {
    const layer = this.drawing?.layer;
    if (!layer || this.points.length < 2) return;
    const screen = this.points.map((point) => this.editor.viewport.worldToScreen(transformPoint(layer.worldTransform(), point)));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${screen.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`);
    path.setAttribute('class', 'lasso-preview');
    path.setAttribute('fill-rule', 'evenodd');
    this.editor.overlay.append(path);
  }

  drawUI(container: HTMLElement): void {
    container.append(new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', get: () => this.opacity * 100,
      input: (value) => { this.opacity = value / 100; },
    }).element);
  }
}
