import type { Layer } from '../model/layers';
import type { Surface } from '../gpu/surface';
import type { GpuReadback } from '../gpu/readback';

interface Preview {
  revision: number;
  outputRevision: number;
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
    const resolved = layers.map((layer) => ({ layer, surface: resolve(layer) }));
    const pending = resolved.filter(({ layer }) => {
      const previous = this.entries.get(layer);
      return !previous || previous.revision !== layer.revision || previous.outputRevision !== layer.outputRevision;
    });
    const revisions = pending.map(({ layer }) => [layer.revision, layer.outputRevision]);
    const pixels = await this.readback.thumbnails(pending.map(({ surface }) => surface));
    if (generation !== this.generation) return;
    pending.forEach(({ layer }, index) => {
      const [revision, outputRevision] = revisions[index];
      if (layer.revision === revision && layer.outputRevision === outputRevision) {
        this.entries.set(layer, { revision, outputRevision, pixels: pixels[index] });
      }
    });
  }

  clear(): void { this.generation++; this.entries.clear(); }
}