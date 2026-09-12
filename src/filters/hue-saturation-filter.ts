import shader from '../shaders/hue-saturation.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class HueSaturationFilter extends ColorFilter {
  readonly kind = 'hue-saturation';
  readonly label = 'Hue / saturation';
  protected readonly shader = shader;
  hue = 0;
  saturation = 0;
  lightness = 0;

  protected properties(): JsonObject { return { hue: this.hue, saturation: this.saturation, lightness: this.lightness }; }
  protected parameters(): readonly number[] { return [this.hue / 360, this.saturation / 100, this.lightness / 100, 0]; }
  protected isIdentity(): boolean { return this.hue === 0 && this.saturation === 0 && this.lightness === 0; }

  protected loadProperties(properties: JsonObject): void {
    this.hue = filterNumber(properties, 'hue', -180, 180);
    this.saturation = filterNumber(properties, 'saturation', -100, 100);
    this.lightness = filterNumber(properties, 'lightness', -100, 100);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Hue', min: -180, max: 180, step: 1, className: 'hue-slider', format: (value) => `${value}°`,
      get: () => this.hue, set: (value) => { this.hue = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Saturation', min: -100, max: 100, step: 1, className: 'saturation-slider', format: (value) => `${value}%`,
      get: () => this.saturation, set: (value) => { this.saturation = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Lightness', min: -100, max: 100, step: 1, format: (value) => `${value}%`,
      get: () => this.lightness, set: (value) => { this.lightness = value; },
    });
  }
}
