import type { Surface } from '../gpu/surface';
import { expandBounds, unionBounds } from '../model/geometry';
import type { Point, Rect } from '../model/geometry';
import type { JsonObject } from '../history/undo';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';
import { BlurFilter } from './blur-filter';
import { renderBehind } from './alpha-effect';
import { drawFilterColor, drawFilterNumber, drawFilterSliderInput, filterColor, filterNumber } from './controls';

export class DropShadowFilter extends Filter {
  readonly kind = 'drop-shadow';
  readonly label = 'Drop shadow';
  color = '#000000';
  opacity = 0.6;
  angle = 45;
  distance = 16;
  softness = 8;
  get supportRadius(): number {
    const offset = this.offset();
    return this.opacity > 0 ? Math.ceil(Math.max(Math.abs(offset.x), Math.abs(offset.y)) + this.softness * 3) : 0;
  }
  private readonly blur = new BlurFilter();

  private offset(): Point {
    const angle = this.angle * Math.PI / 180;
    return { x: Math.cos(angle) * this.distance, y: Math.sin(angle) * this.distance };
  }

  outputBounds(input: Rect): Rect {
    if (this.opacity === 0) return input;
    const offset = this.offset();
    const shadow = expandBounds(input, Math.ceil(this.softness * 3));
    return unionBounds([input, { ...shadow, x: shadow.x + offset.x, y: shadow.y + offset.y }]);
  }

  protected properties(): JsonObject {
    return { color: this.color, opacity: this.opacity, angle: this.angle, distance: this.distance, softness: this.softness };
  }

  protected loadProperties(properties: JsonObject): void {
    const color = filterColor(properties, 'color');
    const opacity = filterNumber(properties, 'opacity', 0, 1);
    const angle = filterNumber(properties, 'angle', 0, 360);
    const distance = filterNumber(properties, 'distance', 0, 256);
    const softness = filterNumber(properties, 'softness', 0, 32);
    this.color = color;
    this.opacity = opacity;
    this.angle = angle;
    this.distance = distance;
    this.softness = softness;
  }

  render(context: FilterRenderContext, source: Surface): Surface {
    if (this.opacity === 0) return source;
    this.blur.sigma = this.softness;
    const mask = this.blur.render({
      ...context, surface: (key, bounds, scale) => context.surface(`shadow:${key}`, bounds, scale),
    }, source);
    return renderBehind(context, source, mask, this.outputBounds(source.bounds), this.color, this.opacity, this.offset());
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterColor(container, context, 'Color', () => this.color, (value) => { this.color = value; });
    drawFilterSliderInput(container, context, { label: 'Opacity', unit: '%', min: 0, max: 100, step: 1, get: () => this.opacity * 100, set: (value) => { this.opacity = value / 100; } });
    drawFilterNumber(container, context, { label: 'Angle · °', min: 0, max: 360, step: 1, get: () => this.angle, set: (value) => { this.angle = value; } });
    drawFilterNumber(container, context, { label: 'Distance · px', min: 0, max: 256, step: 1, get: () => this.distance, set: (value) => { this.distance = value; } });
    drawFilterNumber(container, context, { label: 'Softness · px', min: 0, max: 32, step: 0.25, get: () => this.softness, set: (value) => { this.softness = value; } });
  }
}

