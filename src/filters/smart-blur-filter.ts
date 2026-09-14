import shader from '../shaders/smart-blur.wgsl?raw';
import type { Rect } from '../model/geometry';
import type { Surface } from '../gpu/surface';
import type { JsonObject } from '../history/undo';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';
import { drawFilterSlider, filterNumber } from './controls';
import { renderComputeFilter } from './compute';

export class SmartBlurFilter extends Filter {
  readonly kind = 'smart-blur';
  readonly label = 'Smart blur';
  radius = 4;
  threshold = 15;
  get supportRadius(): number { return this.radius; }

  outputBounds(input: Rect): Rect { return input; }
  protected properties(): JsonObject { return { radius: this.radius, threshold: this.threshold }; }

  protected loadProperties(properties: JsonObject): void {
    const radius = filterNumber(properties, 'radius', 0, 32, true);
    const threshold = filterNumber(properties, 'threshold', 0, 100);
    this.radius = radius;
    this.threshold = threshold;
  }

  render(context: FilterRenderContext, input: Surface): Surface {
    if (this.radius === 0) return input;
    return renderComputeFilter(context, input, shader, [this.radius * input.scale, this.threshold / 100, 0, 0], this.label, this.radius * input.scale);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Radius', min: 0, max: 32, step: 1, format: (value) => `${value} px`,
      get: () => this.radius, set: (value) => { this.radius = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Threshold', min: 0, max: 100, step: 1, format: (value) => `${value}%`,
      get: () => this.threshold, set: (value) => { this.threshold = value; },
    });
  }
}
