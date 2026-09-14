import type { Surface } from '../gpu/surface';
import { dispatchLocal, expandedRegions } from '../gpu/local';
import type { FilterRenderContext } from './filter';

/** A kernel supplies pixel math; the shared dispatcher owns sparse allocation and caching. */
export function renderComputeFilter(context: FilterRenderContext, input: Surface, code: string,
  parameters: readonly number[], label: string, supportRadius = 0): Surface {
  const output = context.surface('output', input.bounds, input.scale);
  dispatchLocal(context.frame, input, output, { code, parameters, label, radius: supportRadius,
    regions: context.channels === 1 && supportRadius === 0 ? [input.bounds] : expandedRegions(input, supportRadius / input.scale) });
  return output;
}
