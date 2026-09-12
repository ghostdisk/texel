import type { Editor } from '../editor';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';

interface BrushLikeSettings {
  size: number;
  hardness: number;
  flow: number;
}

/** Shared brush parameters, controls, and wheel shortcuts for stamp-based tools. */
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

  protected constructor(editor: Editor, settings: BrushLikeSettings) {
    super(editor);
    this.size = this.wheelSize = settings.size;
    this.hardness = this.wheelHardness = settings.hardness;
    this.flow = this.wheelFlow = settings.flow;
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
