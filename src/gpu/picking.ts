import { GroupLayer, Layer } from '../model/layers';
import { inverse, transformPoint } from '../model/geometry';
import type { Point, Rect } from '../model/geometry';
import type { Compositor } from './compositor';
import type { GpuReadback, PixelSample, SampledColor } from './readback';

function inside(point: Point, bounds: Rect): boolean {
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

export class PixelPicker {
  constructor(private readonly compositor: Compositor, private readonly readback: GpuReadback) {}

  async color(root: GroupLayer, point: Point, canvas: Rect, density: number): Promise<SampledColor | null> {
    if (!root.visible || root.opacity === 0 || !inside(point, canvas)) return null;
    const surface = this.compositor.resolve(root, density);
    const [color] = await this.readback.sample([{ surface, point }]);
    return color[3] * root.opacity > 0 ? color : null;
  }

  async layer(root: GroupLayer, point: Point, canvas: Rect, density: number): Promise<Layer | null> {
    if (!root.visible || root.opacity === 0 || !inside(point, canvas)) return null;
    this.compositor.resolve(root, density);
    const requests: PixelSample[] = [];
    const indices = new Map<Layer, number>();
    const collect = (layer: Layer) => {
      if (!layer.visible || layer.opacity === 0 || !layer.output) return;
      let local: Point;
      try { local = transformPoint(inverse(layer.worldTransform()), point); }
      catch { return; }
      if (!inside(local, layer.output.bounds)) return;
      indices.set(layer, requests.length);
      requests.push({ surface: layer.output, point: local });
      if (layer instanceof GroupLayer) layer.children.forEach(collect);
    };
    collect(root);
    const samples = await this.readback.sample(requests);
    const visit = (layer: Layer, opacity: number): Layer | null => {
      const index = indices.get(layer);
      const alpha = opacity * layer.opacity;
      if (index === undefined || samples[index][3] * alpha < 1 / 255) return null;
      if (layer instanceof GroupLayer) {
        for (let index = layer.children.length - 1; index >= 0; index--) {
          const hit = visit(layer.children[index], alpha);
          if (hit) return hit;
        }
      }
      return layer === root ? null : layer;
    };
    return visit(root, 1);
  }
}

