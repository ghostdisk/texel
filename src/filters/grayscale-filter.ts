import shader from '../shaders/grayscale.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class GrayscaleFilter extends ColorFilter {
  readonly kind = 'grayscale';
  readonly label = 'Grayscale';
  protected readonly shader = shader;
  red = 21;
  green = 72;
  blue = 7;

  protected properties(): JsonObject { return { red: this.red, green: this.green, blue: this.blue }; }
  protected parameters(): readonly number[] { return [this.red / 100, this.green / 100, this.blue / 100, 0]; }

  protected loadProperties(properties: JsonObject): void {
    this.red = filterNumber(properties, 'red', 0, 200);
    this.green = filterNumber(properties, 'green', 0, 200);
    this.blue = filterNumber(properties, 'blue', 0, 200);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    for (const [label, key] of [['Red', 'red'], ['Green', 'green'], ['Blue', 'blue']] as const) drawFilterSlider(container, context, {
      label, min: 0, max: 200, step: 1, className: `grayscale-${key}`, format: (value) => `${value}%`,
      get: () => this[key], set: (value) => { this[key] = value; },
    });
  }
}
