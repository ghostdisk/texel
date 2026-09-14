import type { Surface } from '../gpu/surface';
import { expandBounds } from '../model/geometry';
import type { Rect } from '../model/geometry';
import type { JsonObject } from '../history/undo';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';
import { dilateAlpha, renderBehind } from './alpha-effect';
import { drawFilterColor, drawFilterSliderInput, filterColor, filterNumber } from './controls';

export class BorderFilter extends Filter {
  readonly kind = 'border';
  readonly label = 'Border';
  width = 4;
  color = '#ffffff';
  opacity = 1;
  get supportRadius(): number { return this.opacity > 0 ? Math.ceil(this.width) : 0; }

  outputBounds(input: Rect): Rect { return this.width > 0 && this.opacity > 0 ? expandBounds(input, Math.ceil(this.width)) : input; }
  protected properties(): JsonObject { return { width: this.width, color: this.color, opacity: this.opacity }; }

  protected loadProperties(properties: JsonObject): void {
    const width = filterNumber(properties, 'width', 0, 64);
    const color = filterColor(properties, 'color');
    const opacity = filterNumber(properties, 'opacity', 0, 1);
    this.width = width;
    this.color = color;
    this.opacity = opacity;
  }

  render(context: FilterRenderContext, source: Surface): Surface {
    if (this.width === 0 || this.opacity === 0) return source;
    const bounds = this.outputBounds(source.bounds);
    const mask = context.surface('border-mask', bounds, source.scale);
    dilateAlpha(context, source, mask, this.width * source.scale);
    return renderBehind(context, source, mask, bounds, this.color, this.opacity, { x: 0, y: 0 }, true);
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterColor(container, context, 'Color', () => this.color, (value) => { this.color = value; });
    drawFilterSliderInput(container, context, {
      label: 'Width', unit: 'px', min: 0, max: 64, sliderMax: 20, step: 0.5,
      get: () => this.width, set: (value) => { this.width = value; },
    });
    drawFilterSliderInput(container, context, { label: 'Opacity', unit: '%', min: 0, max: 100, step: 1, get: () => this.opacity * 100, set: (value) => { this.opacity = value / 100; } });
  }
}
