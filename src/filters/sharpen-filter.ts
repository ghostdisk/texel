import shader from '../shaders/sharpen.wgsl?raw';
import { dispatchLocal } from '../gpu/local';
import { gaussianBlur } from '../gpu/blur';
import type { Surface } from '../gpu/surface';
import type { JsonObject } from '../history/undo';
import type { Rect } from '../model/geometry';
import { drawFilterSlider, filterNumber } from './controls';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';

export class SharpenFilter extends Filter {
  readonly kind = 'sharpen';
  readonly label = 'Sharpen';
  amount = 100;
  radius = 1;
  threshold = 0;
  get supportRadius(): number { return this.amount > 0 ? Math.ceil(this.radius * 3) : 0; }


  outputBounds(input: Rect): Rect { return input; }
  protected properties(): JsonObject { return { amount: this.amount, radius: this.radius, threshold: this.threshold }; }

  protected loadProperties(properties: JsonObject): void {
    this.amount = filterNumber(properties, 'amount', 0, 500);
    this.radius = filterNumber(properties, 'radius', 0.1, 32);
    this.threshold = filterNumber(properties, 'threshold', 0, 100);
  }

  render(context: FilterRenderContext, input: Surface): Surface {
    if (this.amount === 0) return input;
    const scratch = context.surface('blur-scratch', input.bounds, input.scale);
    const blurred = context.surface('blurred', input.bounds, input.scale);
    gaussianBlur.encode(context.frame, input, scratch, blurred, this.radius * input.scale);
    const output = context.surface('output', input.bounds, input.scale);
    dispatchLocal(context.frame, input, output, {
      code: shader, label: this.label, parameters: [this.amount / 100, this.threshold / 100, 0, 0],
      secondary: blurred, regions: input.regions,
    });
    return output;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Amount', min: 0, max: 500, step: 1, format: (value) => `${value}%`,
      get: () => this.amount, set: (value) => { this.amount = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Radius', min: 0.1, max: 32, step: 0.1, format: (value) => `${value.toFixed(1)} px`,
      get: () => this.radius, set: (value) => { this.radius = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Threshold', min: 0, max: 100, step: 1, format: (value) => `${value}%`,
      get: () => this.threshold, set: (value) => { this.threshold = value; },
    });
  }
}
