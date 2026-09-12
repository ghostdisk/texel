import { GaussianBlur } from '../gpu/blur';
import type { Gpu } from '../gpu/device';
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
  private static kernels = new WeakMap<Gpu, GaussianBlur>();

  outputBounds(input: Rect): Rect { return expandBounds(input, Math.ceil(this.sigma * 3)); }
  protected properties(): JsonObject { return { sigma: this.sigma }; }

  protected loadProperties(properties: JsonObject): void {
    const sigma = properties.sigma;
    if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > 32) throw new Error('Blur sigma must be between 0 and 32.');
    this.sigma = sigma;
  }

  render(context: FilterRenderContext, content: Surface): Surface {
    if (this.sigma === 0) return content;
    let blur = BlurFilter.kernels.get(context.gpu);
    if (!blur) { blur = new GaussianBlur(context.gpu); BlurFilter.kernels.set(context.gpu, blur); }
    const { frame, quads, surface } = context;
    const bounds = expandBounds(content.bounds, Math.ceil(this.sigma * 3 * content.scale) / content.scale);
    const reduction = Math.max(1, 2 ** Math.ceil(Math.log2(this.sigma * content.scale / 32)));
    const scale = content.scale / reduction;
    const input = surface('input', bounds, scale);
    const scratch = surface('scratch', bounds, scale);
    const blurred = surface('blurred', bounds, scale);
    quads.copy(frame, content, input);
    blur.encode(frame, input, scratch, blurred, this.sigma * scale);
    if (reduction === 1) return blurred;
    const output = surface('output', bounds, content.scale);
    quads.copy(frame, blurred, output);
    return output;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Sigma', min: 0, max: 32, step: 0.25, format: (value) => `${value} px`,
      get: () => this.sigma, set: (value) => { this.sigma = value; },
    });
  }
}