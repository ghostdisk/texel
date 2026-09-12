import type { Layer } from '../model/layers';
import type { Surface } from '../gpu/surface';
import type { GpuReadback } from '../gpu/readback';

interface Preview {
  revision: number;
  pixels: ImageData;
}

export class LayerPreviews {
  private entries = new Map<Layer, Preview>();
  private generation = 0;

  constructor(private readonly readback: GpuReadback) {}

  get(layer: Layer): ImageData | undefined { return this.entries.get(layer)?.pixels; }

  async update(layers: readonly Layer[], resolve: (layer: Layer) => Surface): Promise<void> {
    const generation = ++this.generation;
    const live = new Set(layers);
    for (const layer of this.entries.keys()) if (!live.has(layer)) this.entries.delete(layer);
    const pending = layers.filter((layer) => this.entries.get(layer)?.revision !== layer.revision);
    const revisions = pending.map((layer) => layer.revision);
    const pixels = await this.readback.thumbnails(pending.map(resolve));
    if (generation !== this.generation) return;
    pending.forEach((layer, index) => {
      if (layer.revision === revisions[index]) this.entries.set(layer, { revision: revisions[index], pixels: pixels[index] });
    });
  }

  clear(): void { this.generation++; this.entries.clear(); }
}

