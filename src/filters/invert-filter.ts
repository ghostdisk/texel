import shader from '../shaders/invert.wgsl?raw';
import type { Surface } from '../gpu/surface';
import type { JsonObject } from '../history/undo';
import type { Rect } from '../model/geometry';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';
import { renderComputeFilter } from './compute';

export class InvertFilter extends Filter {
  readonly kind = 'invert';
  readonly label = 'Invert';
  readonly supportRadius = 0;

  outputBounds(input: Rect): Rect { return input; }
  protected properties(): JsonObject { return {}; }
  protected loadProperties(_properties: JsonObject): void {}
  protected drawParameters(_container: HTMLElement, _context: FilterUIContext): void {}

  render(context: FilterRenderContext, input: Surface): Surface {
    const parameters = [Number(context.channels === 1), 0, 0, 0, 0, 0, 0, 0];
    return renderComputeFilter(context, input, shader, parameters, this.label);
  }
}
