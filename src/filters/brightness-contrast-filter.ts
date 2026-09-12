import shader from '../shaders/brightness-contrast.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawFilterSlider, filterNumber } from './controls';

export class BrightnessContrastFilter extends ColorFilter {
  readonly kind = 'brightness-contrast';
  readonly label = 'Brightness / contrast';
  protected readonly shader = shader;
  brightness = 0;
  contrast = 0;

  protected properties(): JsonObject { return { brightness: this.brightness, contrast: this.contrast }; }
  protected parameters(): readonly number[] { return [this.brightness / 100, this.contrast / 100, 0, 0, 0, 0, 0, 0]; }
  protected isIdentity(): boolean { return this.brightness === 0 && this.contrast === 0; }

  protected loadProperties(properties: JsonObject): void {
    const brightness = filterNumber(properties, 'brightness', -100, 100);
    const contrast = filterNumber(properties, 'contrast', -100, 100);
    this.brightness = brightness;
    this.contrast = contrast;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Brightness', min: -100, max: 100, step: 1,
      get: () => this.brightness, set: (value) => { this.brightness = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Contrast', min: -100, max: 100, step: 1,
      get: () => this.contrast, set: (value) => { this.contrast = value; },
    });
  }
}
