import type { Editor } from '../editor';
import { ImageLayer } from '../model/layers';
import { inverse, maxScale, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { DrawingTool } from './drawing-tool';
import { SliderInput } from '../ui/slider-input';
import type { ToolPointer } from './tool';

export class BrushTool extends DrawingTool {
  readonly id = 'brush';
  readonly label = 'Brush';
  readonly cursor = 'crosshair';
  readonly hint = 'Paint on a pixel layer · Hold Space to pan · Scroll to zoom';
  size = 36;
  hardness = 0.8;
  flow = 1;
  private wheelSize = this.size;
  private wheelHardness = this.hardness;
  private wheelFlow = this.flow;
  private sizeControl: SliderInput | null = null;
  private hardnessControl: SliderInput | null = null;
  private flowControl: SliderInput | null = null;
  private last: Point = { x: 0, y: 0 };

  constructor(editor: Editor) { super(editor); }

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

  resizeByWheel(delta: number): void {
    if (Math.round(this.wheelSize) !== this.size) this.wheelSize = this.size;
    this.wheelSize = Math.max(1, Math.min(400, this.wheelSize * Math.exp(-delta * 0.002)));
    this.size = Math.round(this.wheelSize);
    this.sizeControl?.sync(true);
  }

  adjustByWheel(property: 'hardness' | 'flow', delta: number): void {
    const minimum = property === 'flow' ? 0.01 : 0;
    const wheelProperty = property === 'hardness' ? 'wheelHardness' : 'wheelFlow';
    const control = property === 'hardness' ? this.hardnessControl : this.flowControl;
    if (Math.round(this[wheelProperty] * 100) !== Math.round(this[property] * 100)) this[wheelProperty] = this[property];
    this[wheelProperty] = Math.max(minimum, Math.min(1, this[wheelProperty] - delta * 0.0005));
    this[property] = Math.round(this[wheelProperty] * 100) / 100;
    control?.sync(true);
  }

  drawUI(container: HTMLElement): void {
    const add = (label: string, key: 'size' | 'hardness' | 'flow', min: number, max: number, step: number, unit: string) => {
      const factor = key === 'size' ? 1 : 100;
      const control = new SliderInput({
        label, min, max, step, unit, get: () => this[key] * factor,
        input: (value) => { this[key] = value / factor; },
      });
      if (key === 'size') this.sizeControl = control;
      else if (key === 'hardness') this.hardnessControl = control;
      else this.flowControl = control;
      control.element.classList.add('brush-slider');
      container.append(control.element);
    };
    add('Size', 'size', 1, 400, 1, 'px');
    add('Hardness', 'hardness', 0, 100, 1, '%');
    add('Flow', 'flow', 1, 100, 1, '%');
  }
}
