import shader from '../shaders/exposure.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class ExposureFilter extends ColorFilter {
  readonly kind = 'exposure';
  readonly label = 'Exposure';
  protected readonly shader = shader;
  exposure = 0;
  offset = 0;
  gamma = 1;

  protected properties(): JsonObject { return { exposure: this.exposure, offset: this.offset, gamma: this.gamma }; }
  protected parameters(): readonly number[] { return [this.exposure, this.offset, this.gamma, 0]; }
  protected isIdentity(): boolean { return this.exposure === 0 && this.offset === 0 && this.gamma === 1; }

  protected loadProperties(properties: JsonObject): void {
    this.exposure = filterNumber(properties, 'exposure', -5, 5);
    this.offset = filterNumber(properties, 'offset', -0.5, 0.5);
    this.gamma = filterNumber(properties, 'gamma', 0.1, 10);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Exposure', min: -5, max: 5, step: 0.05, format: (value) => `${value.toFixed(2)} stops`,
      get: () => this.exposure, set: (value) => { this.exposure = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Offset', min: -0.5, max: 0.5, step: 0.01, format: (value) => value.toFixed(2),
      get: () => this.offset, set: (value) => { this.offset = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Gamma', min: 0.1, max: 10, step: 0.05, format: (value) => value.toFixed(2),
      get: () => this.gamma, set: (value) => { this.gamma = value; },
    });
  }
}
