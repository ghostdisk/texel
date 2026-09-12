import shader from '../shaders/posterize.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class PosterizeFilter extends ColorFilter {
  readonly kind = 'posterize';
  readonly label = 'Posterize';
  protected readonly shader = shader;
  levels = 8;

  protected properties(): JsonObject { return { levels: this.levels }; }
  protected parameters(): readonly number[] { return [this.levels, 0, 0, 0, 0, 0, 0, 0]; }
  protected loadProperties(properties: JsonObject): void { this.levels = filterNumber(properties, 'levels', 2, 256, true); }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Levels per channel', min: 2, max: 256, step: 1,
      get: () => this.levels, set: (value) => { this.levels = value; },
    });
  }
}
