import { expandBounds, IDENTITY, maxScale, multiply, transformBounds, unionBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import { GroupLayer, ImageLayer, Layer } from '../model/layers';
import { GaussianBlur } from './blur';
import type { RenderOperation } from './brush';
import type { Gpu, GpuFrame } from './device';
import { QuadRenderer } from './quad';
import { createSurface, matchesSurface } from './surface';
import type { Surface } from './surface';

interface LayerCache {
  revision: number;
  scale: number;
  surfaces: Map<string, Surface>;
}

interface EvaluatedChild {
  layer: Layer;
  surface: Surface;
}

interface Evaluation {
  surface: Surface;
  changed: boolean;
}

export interface RenderStats {
  updatedLayers: number;
  cachedLayers: number;
  encodingMs: number;
}

/** Owns evaluation, intermediate textures, and command ordering. Filters do not traverse the tree. */
export class Compositor {
  readonly quads: QuadRenderer;
  private readonly blur: GaussianBlur;
  private readonly caches = new Map<Layer, LayerCache>();
  private readonly operations = new Map<ImageLayer, RenderOperation[]>();
  private stats: RenderStats = { updatedLayers: 0, cachedLayers: 0, encodingMs: 0 };

  constructor(private readonly gpu: Gpu, canvasFormat: GPUTextureFormat) {
    this.quads = new QuadRenderer(gpu, canvasFormat);
    this.blur = new GaussianBlur(gpu);
  }

  enqueue(layer: ImageLayer, operation: RenderOperation): void {
    const pending = this.operations.get(layer) ?? [];
    pending.push(operation);
    this.operations.set(layer, pending);
    layer.invalidate();
  }

  render(root: GroupLayer, view: GPUTextureView, frameBounds: Rect, pixelsPerUnit: number): RenderStats {
    const start = performance.now();
    const frame = this.gpu.beginFrame();
    this.stats = { updatedLayers: 0, cachedLayers: 0, encodingMs: 0 };
    try {
      for (const [layer, operations] of this.operations) {
        const pass = this.quads.begin(frame, layer.source, 'load');
        for (const operation of operations) operation.encode(pass, { frame, target: layer.source });
        pass.end();
      }
      const output = this.evaluate(frame, root, IDENTITY, pixelsPerUnit);
      this.quads.present(frame, output.surface, view, frameBounds, root.visible ? root.opacity : 0);
      frame.submit();
      this.operations.clear();
      this.stats.encodingMs = performance.now() - start;
      return this.stats;
    } catch (error) {
      // A failed command buffer did not update any cached texture.
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  release(layer: Layer): void {
    if (layer instanceof GroupLayer) for (const child of layer.children) this.release(child);
    if (layer instanceof ImageLayer) {
      this.operations.delete(layer);
      layer.sourceTexture.destroy();
    }
    const cache = this.caches.get(layer);
    if (cache) for (const surface of cache.surfaces.values()) surface.texture.destroy();
    this.caches.delete(layer);
    layer.output = null;
  }

  private evaluate(frame: GpuFrame, layer: Layer, parentTransform: Matrix, pixelsPerUnit: number): Evaluation {
    const world = multiply(parentTransform, layer.transform);
    const scale = layer instanceof ImageLayer ? 1 : 2 ** Math.ceil(Math.log2(Math.max(1 / 16, maxScale(world) * pixelsPerUnit)));
    const cache = this.caches.get(layer) ?? { revision: -1, scale, surfaces: new Map<string, Surface>() };
    this.caches.set(layer, cache);
    const children: EvaluatedChild[] = [];
    let childrenChanged = false;
    if (layer instanceof GroupLayer) {
      for (const child of layer.children) {
        if (!child.visible || child.opacity === 0) continue;
        const evaluated = this.evaluate(frame, child, world, pixelsPerUnit);
        children.push({ layer: child, surface: evaluated.surface });
        childrenChanged ||= evaluated.changed;
      }
    }
    if (layer.output && cache.revision === layer.revision && cache.scale === scale && !childrenChanged) {
      this.stats.cachedLayers++;
      return { surface: layer.output, changed: false };
    }

    const used = new Set<string>();
    const surface = (key: string, bounds: Rect, density = scale): Surface => {
      used.add(key);
      const existing = cache.surfaces.get(key);
      if (existing && matchesSurface(existing, bounds, density)) return existing;
      const replacement = createSurface(this.gpu.device, `${layer.name}: ${key}`, bounds, density);
      if (existing) frame.retire(existing.texture);
      cache.surfaces.set(key, replacement);
      return replacement;
    };
    let content: Surface;
    const filters = layer.filters.filter((filter) => filter.enabled && filter.sigma > 0);
    if (layer instanceof ImageLayer) {
      content = layer.source;
      if (filters.length === 0) {
        const output = surface('output', content.bounds, 1);
        frame.encoder.copyTextureToTexture(
          { texture: content.texture }, { texture: output.texture },
          { width: content.texture.width, height: content.texture.height },
        );
        content = output;
      }
    } else if (layer instanceof GroupLayer) {
      const bounds = unionBounds(children.map((child) => transformBounds(child.layer.transform, child.surface.bounds)));
      content = surface('children', bounds);
      const pass = this.quads.begin(frame, content);
      for (const child of children) {
        this.quads.draw(pass, frame, child.surface, content, child.layer.transform, child.layer.opacity, child.layer.blendMode);
      }
      pass.end();
    } else {
      throw new Error(`No content renderer is registered for layer kind: ${layer.kind}`);
    }

    for (const filter of filters) {
      const padding = Math.ceil(filter.sigma * 3 * content.scale) / content.scale;
      const bounds = expandBounds(content.bounds, padding);
      // Keep wide kernels bounded. Broad blurs use a lower-resolution working surface.
      const reduction = Math.max(1, 2 ** Math.ceil(Math.log2(filter.sigma * content.scale / 32)));
      const workingScale = content.scale / reduction;
      const input = surface(`${filter.id}:input`, bounds, workingScale);
      const scratch = surface(`${filter.id}:scratch`, bounds, workingScale);
      const blurred = surface(`${filter.id}:blurred`, bounds, workingScale);
      this.quads.copy(frame, content, input);
      this.blur.encode(frame, input, scratch, blurred, filter.sigma * workingScale);
      if (reduction === 1) content = blurred;
      else {
        const output = surface(`${filter.id}:output`, bounds, content.scale);
        this.quads.copy(frame, blurred, output);
        content = output;
      }
    }
    for (const [key, unused] of cache.surfaces) {
      if (used.has(key)) continue;
      frame.retire(unused.texture);
      cache.surfaces.delete(key);
    }
    layer.output = content;
    cache.revision = layer.revision;
    cache.scale = scale;
    this.stats.updatedLayers++;
    return { surface: content, changed: true };
  }
}


