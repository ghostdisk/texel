import shader from '../shaders/curves.wgsl?raw';
import type { Json, JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { drawCurvesControls } from '../ui/curves-controls';

export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue';

export interface CurvePoint {
  x: number;
  y: number;
}

const CHANNELS: readonly CurveChannel[] = ['rgb', 'red', 'green', 'blue'];
const identity = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

export class CurvesFilter extends ColorFilter {
  readonly kind = 'curves';
  readonly label = 'Curves';
  protected readonly shader = shader;
  readonly curves: Record<CurveChannel, CurvePoint[]> = { rgb: identity(), red: identity(), green: identity(), blue: identity() };
  selectedChannel: CurveChannel = 'rgb';

  protected properties(): JsonObject {
    return { curves: Object.fromEntries(CHANNELS.map((channel) => [channel, this.curves[channel].map((point) => [point.x, point.y])])) };
  }

  protected parameters(): readonly number[] {
    const values: number[] = [];
    for (const channel of CHANNELS) {
      const points = this.curves[channel];
      for (let index = 0; index < 8; index++) {
        const point = points[index];
        values.push(point?.x ?? 2, point?.y ?? points[points.length - 1].y);
      }
    }
    return values;
  }

  protected isIdentity(): boolean {
    return CHANNELS.every((channel) => {
      const points = this.curves[channel];
      return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
    });
  }

  protected loadProperties(properties: JsonObject): void {
    const curves = properties.curves;
    if (!curves || typeof curves !== 'object' || Array.isArray(curves)) throw new Error('Curves filter requires channel point arrays.');
    const loaded = {
      rgb: this.readCurve((curves as JsonObject).rgb, 'rgb'),
      red: this.readCurve((curves as JsonObject).red, 'red'),
      green: this.readCurve((curves as JsonObject).green, 'green'),
      blue: this.readCurve((curves as JsonObject).blue, 'blue'),
    };
    for (const channel of CHANNELS) this.curves[channel] = loaded[channel];
  }

  private readCurve(value: Json | undefined, channel: CurveChannel): CurvePoint[] {
    if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error(`Curves ${channel} must contain 2 to 8 points.`);
    const points = value.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number' || typeof entry[1] !== 'number' ||
        !Number.isFinite(entry[0]) || !Number.isFinite(entry[1]) || entry[0] < 0 || entry[0] > 1 || entry[1] < 0 || entry[1] > 1) {
        throw new Error(`Curves ${channel} points must contain normalized x and y values.`);
      }
      return { x: entry[0], y: entry[1] };
    });
    if (points[0].x !== 0 || points[points.length - 1].x !== 1) throw new Error(`Curves ${channel} must start at x 0 and end at x 1.`);
    for (let index = 1; index < points.length; index++) {
      if (points[index].x <= points[index - 1].x) throw new Error(`Curves ${channel} points must have increasing x values.`);
    }
    return points;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void { drawCurvesControls(container, context, this); }
}
