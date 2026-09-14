import { gaussianBlur } from '../gpu/blur';
import type { Surface } from '../gpu/surface';
import { expandBounds } from '../model/geometry';
import type { Rect } from '../model/geometry';
import type { JsonObject } from '../history/undo';
import { Filter } from './filter';
import { drawFilterSlider } from './controls';
import type { FilterRenderContext, FilterUIContext } from './filter';

export class BlurFilter extends Filter {
  readonly kind = 'blur';
  readonly label = 'Gaussian blur';
  sigma = 6;
  get supportRadius(): number { return Math.ceil(this.sigma * 3); }

  outputBounds(input: Rect): Rect { return expandBounds(input, Math.ceil(this.sigma * 3)); }
  protected properties(): JsonObject { return { sigma: this.sigma }; }

  protected loadProperties(properties: JsonObject): void {
    const sigma = properties.sigma;
    if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > 32) throw new Error('Blur sigma must be between 0 and 32.');
    this.sigma = sigma;
  }

  render(context: FilterRenderContext, content: Surface): Surface {
    if (this.sigma === 0) return content;
    const bounds = expandBounds(content.bounds, Math.ceil(this.sigma * 3 * content.scale) / content.scale);
    const scratch = context.surface('scratch', bounds, content.scale);
    const blurred = context.surface('blurred', bounds, content.scale);
    gaussianBlur.encode(context.frame, content, scratch, blurred, this.sigma * content.scale);
    return blurred;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Sigma', min: 0, max: 32, step: 0.25, format: (value) => `${value} px`,
      get: () => this.sigma, set: (value) => { this.sigma = value; },
    });
  }
}
