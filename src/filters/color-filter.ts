import commonShader from '../shaders/color-filter.wgsl?raw';
import type { Rect } from '../model/geometry';
import type { Surface } from '../gpu/surface';
import { Filter } from './filter';
import type { FilterRenderContext } from './filter';
import { renderComputeFilter } from './compute';

/** Pointwise adjustments share alpha/color conversion, not filter-specific formulas. */
export abstract class ColorFilter extends Filter {
  protected abstract readonly shader: string;
  protected abstract parameters(): readonly number[];
  protected isIdentity(): boolean { return false; }

  outputBounds(input: Rect): Rect { return input; }

  render(context: FilterRenderContext, input: Surface): Surface {
    if (this.isIdentity()) return input;
    const parameters = [...this.parameters()];
    while (parameters.length < 64) parameters.push(0);
    return renderComputeFilter(context, input, `${commonShader}\n${this.shader}`, parameters, this.label);
  }
}
