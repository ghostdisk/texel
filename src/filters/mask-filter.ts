import type { Gpu } from '../gpu/device';
import { MaskRenderer } from '../gpu/mask';
import type { Surface } from '../gpu/surface';
import type { JsonObject } from '../history/undo';
import type { Rect } from '../model/geometry';
import { drawLayerSelect } from '../ui/layer-select';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';

const renderers = new WeakMap<Gpu, MaskRenderer>();

export class MaskFilter extends Filter {
  readonly kind = 'mask';
  readonly label = 'Mask';
  readonly supportRadius = 0;
  layerId: string | null = null;

  override dependencies(): readonly string[] { return this.layerId ? [this.layerId] : []; }
  override remapDependencies(ids: ReadonlyMap<string, string>): void { if (this.layerId) this.layerId = ids.get(this.layerId) ?? this.layerId; }
  outputBounds(input: Rect): Rect { return input; }
  protected properties(): JsonObject { return { layerId: this.layerId }; }
  protected loadProperties(properties: JsonObject): void {
    if (properties.layerId !== null && typeof properties.layerId !== 'string') throw new Error('A mask must reference a layer ID.');
    this.layerId = properties.layerId as string | null;
  }

  render(context: FilterRenderContext, input: Surface): Surface {
    const mask = this.layerId ? context.layer(this.layerId) : null;
    // Retain dangling IDs so undoing a deletion reconnects the same mask.
    if (!mask) return input;
    let renderer = renderers.get(context.gpu);
    if (!renderer) { renderer = new MaskRenderer(context.gpu); renderers.set(context.gpu, renderer); }
    const output = context.surface('output', input.bounds, input.scale);
    renderer.encode(context.frame, input, output, mask);
    return output;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawLayerSelect(container, 'Layer', this.layerId, context.layers?.() ?? [], (id) => {
      context.begin('Change mask layer');
      context.preview(() => { this.layerId = id; });
      context.commit();
    });
  }
}
