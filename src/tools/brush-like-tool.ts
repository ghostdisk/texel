import type { Editor } from '../editor';
import { inverse, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import type { ImageLayer } from '../model/layers';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

interface BrushLikeSettings {
  size: number;
  hardness: number;
  flow: number;
}

interface BrushAnchor {
  documentId: string;
  layer: ImageLayer;
  point: Point;
  historyState: string;
}

/** Shared stroke spacing, Shift-click lines, parameters, and controls for stamp-based tools. */
export abstract class BrushLikeTool extends DrawingTool {
  size: number;
  hardness: number;
  flow: number;
  private wheelSize: number;
  private wheelHardness: number;
  private wheelFlow: number;
  private sizeControl: SliderInput | null = null;
  private hardnessControl: SliderInput | null = null;
  private flowControl: SliderInput | null = null;
  private anchor: BrushAnchor | null = null;
  private lastStamp: Point | null = null;
  private strokeEnd: Point | null = null;

  protected constructor(editor: Editor, settings: BrushLikeSettings) {
    super(editor);
    this.size = this.wheelSize = settings.size;
    this.hardness = this.wheelHardness = settings.hardness;
    this.flow = this.wheelFlow = settings.flow;
  }

  protected abstract stamp(point: Point, pressure: number): void;

  protected strokeStart(pointer: ToolPointer, layer: ImageLayer): Point {
    const anchor = this.anchor;
    if (pointer.shift && anchor?.documentId === this.editor.image.id && anchor.layer === layer && anchor.historyState === this.editor.history.stateId) {
      return anchor.point;
    }
    return transformPoint(inverse(layer.worldTransform()), pointer.world);
  }

  protected startStroke(pointer: ToolPointer): void {
    const drawing = this.drawing;
    if (!drawing) return;
    const point = transformPoint(inverse(drawing.layer.worldTransform()), pointer.world);
    this.lastStamp = this.strokeStart(pointer, drawing.layer);
    this.strokeEnd = point;
    if (this.lastStamp.x !== point.x || this.lastStamp.y !== point.y) this.drawTo(point, pointer.pressure, true);
    else this.stamp(point, pointer.pressure);
  }

  pointerMove(pointer: ToolPointer): void {
    if (!this.drawing || !this.lastStamp) return;
    this.drawTo(transformPoint(inverse(this.drawing.layer.worldTransform()), pointer.world), pointer.pressure);
  }

  private drawTo(point: Point, pressure: number, includeEndpoint = false): void {
    const start = this.lastStamp!;
    const dx = point.x - start.x, dy = point.y - start.y;
    const distance = Math.hypot(dx, dy);
    const spacing = Math.max(0.25, this.size * Math.max(0.05, pressure) * 0.1);
    const steps = Math.floor(distance / spacing);
    for (let step = 1; step <= steps; step++) {
      const amount = step * spacing / distance;
      this.lastStamp = { x: start.x + dx * amount, y: start.y + dy * amount };
      this.stamp(this.lastStamp, pressure);
    }
    if (includeEndpoint) {
      if (distance - steps * spacing > 1e-6) this.stamp(point, pressure);
      this.lastStamp = point;
    }
    this.strokeEnd = point;
  }

  override finish(): void {
    const drawing = this.drawing;
    const point = this.strokeEnd;
    try {
      super.finish();
      if (drawing && point) this.anchor = {
        documentId: this.editor.image.id, layer: drawing.layer, point, historyState: this.editor.history.stateId,
      };
    } finally { this.lastStamp = null; this.strokeEnd = null; }
  }

  override cancel(): void {
    try { super.cancel(); }
    finally { this.lastStamp = null; this.strokeEnd = null; }
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
    const fineFlow = property === 'flow' && (this[wheelProperty] < 0.1 || delta > 0 && this[wheelProperty] <= 0.1);
    this[wheelProperty] = Math.max(minimum, Math.min(1, this[wheelProperty] - delta * (fineFlow ? 0.0001 : 0.0005)));
    this[property] = Math.round(this[wheelProperty] * 100) / 100;
    control?.sync(true);
  }

  protected drawBrushControls(container: HTMLElement): void {
    const add = (label: string, key: 'size' | 'hardness' | 'flow', min: number, max: number, unit: string) => {
      const factor = key === 'size' ? 1 : 100;
      const control = new SliderInput({
        label, min, max, step: 1, unit, get: () => this[key] * factor,
        input: (value) => { this[key] = value / factor; },
      });
      if (key === 'size') this.sizeControl = control;
      else if (key === 'hardness') this.hardnessControl = control;
      else this.flowControl = control;
      control.element.classList.add('brush-slider');
      container.append(control.element);
    };
    add('Size', 'size', 1, 400, 'px');
    add('Hardness', 'hardness', 0, 100, '%');
    add('Flow', 'flow', 1, 100, '%');
  }
}
