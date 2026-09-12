import shader from '../shaders/white-balance.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class WhiteBalanceFilter extends ColorFilter {
  readonly kind = 'white-balance';
  readonly label = 'White balance';
  protected readonly shader = shader;
  temperature = 0;
  tint = 0;

  protected properties(): JsonObject { return { temperature: this.temperature, tint: this.tint }; }
  protected parameters(): readonly number[] { return [this.temperature / 100, this.tint / 100, 0, 0]; }
  protected isIdentity(): boolean { return this.temperature === 0 && this.tint === 0; }

  protected loadProperties(properties: JsonObject): void {
    this.temperature = filterNumber(properties, 'temperature', -100, 100);
    this.tint = filterNumber(properties, 'tint', -100, 100);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Temperature', min: -100, max: 100, step: 1, className: 'temperature-slider',
      get: () => this.temperature, set: (value) => { this.temperature = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Tint', min: -100, max: 100, step: 1, className: 'tint-slider',
      get: () => this.tint, set: (value) => { this.tint = value; },
    });
  }
}
