import type { GenerationFrame } from '../generation/lens';
import { GenerationOverlay } from './generation-overlay';
import type { GenerationVisual } from './generation-overlay';
import { IDENTITY, inverse, maxScale, multiply, transformBounds, unionBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import { GroupLayer, ImageLayer, Layer, layerIndex, validateLayerDependencies } from '../model/layers';
import type { RenderOperation } from './brush';
import type { Gpu, GpuFrame } from './device';
import { QuadRenderer } from './quad';
import { FilterMixer } from './filter-mix';
import { SelectionOutline } from './selection-outline';
import { createSurface, rasterBounds, MASK_FORMAT, WORKING_FORMAT } from './surface';
import type { Surface } from './surface';

export interface GenerationCapture {
  input: Surface;
  mask: Surface | null;
}

interface LayerCache {
  revision: number;
  signature: string;
  scale: number;
  surfaces: Map<string, Surface>;
  filterInputs: Map<string, Surface>;
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

export class Compositor {
  readonly quads: QuadRenderer;
  private readonly mixer: FilterMixer;
  private readonly caches = new Map<Layer, LayerCache>();
  private readonly outline: SelectionOutline;
  private readonly generationOverlay: GenerationOverlay;
  private index = new Map<string, Layer>();
  private evaluated = new Map<Layer, Evaluation>();
  private visiting = new Set<Layer>();
  private readonly operations = new Map<ImageLayer, RenderOperation[]>();
  private stats: RenderStats = { updatedLayers: 0, cachedLayers: 0, encodingMs: 0 };

  constructor(private readonly gpu: Gpu, canvasFormat: GPUTextureFormat) {
    this.quads = new QuadRenderer(gpu, canvasFormat);
    this.mixer = new FilterMixer(gpu);
    this.outline = new SelectionOutline(gpu, canvasFormat);
    this.generationOverlay = new GenerationOverlay(gpu, canvasFormat);
  }

  private generationPreview: {
    root: GroupLayer;
    layer: ImageLayer;
  } | null = null;

  setGenerationPreview(root: GroupLayer, layer: ImageLayer | null): void {
    const previous = this.generationPreview;
    this.generationPreview = layer ? { root, layer } : null;
    previous?.root.invalidate();
    if (previous?.root !== root) root.invalidate();
  }

  captureGenerationInput(root: GroupLayer, target: GenerationFrame, selection: ImageLayer | null): GenerationCapture {
    const frame = this.gpu.beginFrame();
    const bounds = { x: 0, y: 0, width: target.width, height: target.height };
    const input = createSurface(this.gpu.device, 'Generation input', bounds);
    let mask: Surface | null = null;
    try {
      this.prepare(root);
      this.encodePaint(frame);
      const worldToPixels = inverse(target.transform);
      const density = maxScale(worldToPixels);
      const output = this.evaluate(frame, root, IDENTITY, density).surface;
      const pass = this.quads.begin(frame, input);
      this.quads.draw(pass, frame, output, input, multiply(worldToPixels, root.worldTransform()), root.visible ? root.opacity : 0);
      pass.end();
      if (selection) {
        const output = this.evaluate(frame, selection, selection.parent?.worldTransform() ?? IDENTITY, density).surface;
        mask = createSurface(this.gpu.device, 'Generation selection', bounds);
        const pass = this.quads.begin(frame, mask);
        this.quads.draw(pass, frame, output, mask, multiply(worldToPixels, selection.worldTransform()));
        pass.end();
      }
      frame.submit();
      this.operations.clear();
      return { input, mask };
    } catch (error) {
      input.texture.destroy();
      mask?.texture.destroy();
      frame.release();
      throw error;
    }
  }

  /** Bake selected branches in their common parent's coordinates, retaining partial ancestor effects. */
  captureLayers(layers: readonly Layer[], parent: GroupLayer): {
    surface: Surface;
    transform: Matrix;
  } {
    const frame = this.gpu.beginFrame();
    const selected = new Set(layers);
    const included = new Set<Layer>(layers);
    for (const layer of layers) for (let ancestor = layer.parent; ancestor && ancestor !== parent; ancestor = ancestor.parent) included.add(ancestor);
    const parentInverse = inverse(parent.worldTransform());
    let density = 1;
    const measure = (layer: Layer) => {
      if (layer instanceof ImageLayer) density = Math.max(density, maxScale(inverse(multiply(parentInverse, layer.worldTransform()))));
      else if (layer instanceof GroupLayer) layer.children.filter((child) => child.visibleInStack).forEach(measure);
    };
    layers.forEach(measure);
    const pixelsPerUnit = density * maxScale(parentInverse);
    let result: Surface | null = null;
    const temporary = (label: string, bounds: Rect, scale: number): Surface => {
      const surface = createSurface(this.gpu.device, label, bounds, scale);
      frame.retire(surface.texture);
      return surface;
    };
    try {
      this.prepare(parent);
      this.encodePaint(frame);
      const render = (group: GroupLayer, applyFilters: boolean): Surface => {
        const children: EvaluatedChild[] = [];
        for (const child of group.children) {
          if (!included.has(child) || !child.visibleInStack || child.opacity === 0) continue;
          const surface = selected.has(child) ? this.evaluate(frame, child, group.worldTransform(), pixelsPerUnit).surface :
            child instanceof GroupLayer ? render(child, true) : null;
          if (surface) children.push({ layer: child, surface });
        }
        const world = group.worldTransform();
        const scale = density * maxScale(multiply(parentInverse, world));
        const bounds = unionBounds(children.map((child) => transformBounds(child.layer.transform, child.surface.bounds)));
        let content = applyFilters ? temporary('Merge group contents', bounds, scale) : createSurface(this.gpu.device, 'Merged layers', bounds, scale);
        if (!applyFilters) result = content;
        const pass = this.quads.begin(frame, content);
        for (const child of children) {
          const magnified = maxScale(child.layer.transform) * content.scale > child.surface.scale;
          this.quads.draw(pass, frame, child.surface, content, child.layer.transform, child.layer.opacity, child.layer.blendMode, false, magnified);
        }
        pass.end();
        if (applyFilters) for (const filter of group.filters) {
          if (!filter.enabled) continue;
          const masks = new Map<string, Layer>();
          for (const id of filter.dependencies()) {
            const dependency = this.index.get(id);
            if (!dependency) continue;
            this.evaluate(frame, dependency, dependency.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
            masks.set(id, dependency);
          }
          const original = content;
          content = filter.render({
            gpu: this.gpu, frame, quads: this.quads, channels: 4,
            surface: (key, rect, rasterScale) => temporary('Merge ' + key, rect, rasterScale),
            layer: (id) => {
              const mask = masks.get(id);
              return mask?.output ? { surface: mask.output, transform: multiply(inverse(mask.worldTransform()), world) } : null;
            },
          }, original);
          if (filter.mix < 1) {
            const bounds = filter.mix === 0 ? original.bounds : unionBounds([original.bounds, content.bounds]);
            const mixed = temporary('Merge filter mix', bounds, original.scale);
            this.mixer.encode(frame, original, content, mixed, 1 - filter.mix);
            content = mixed;
          }
        }
        return content;
      };
      const output = render(parent, false);
      frame.submit();
      this.operations.clear();
      return {
        surface: { ...output, bounds: { x: 0, y: 0, width: output.texture.width, height: output.texture.height }, scale: 1 },
        transform: [1 / output.scale, 0, 0, 1 / output.scale, output.bounds.x, output.bounds.y],
      };
    } catch (error) {
      (result as Surface | null)?.texture.destroy();
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  private prepare(layer: Layer): void {
    validateLayerDependencies(layer);
    this.index = layerIndex(layer);
    this.evaluated.clear();
    this.visiting.clear();
  }

  enqueue(layer: ImageLayer, operation: RenderOperation): void {
    const pending = this.operations.get(layer) ?? [];
    pending.push(operation);
    this.operations.set(layer, pending);
    layer.invalidate();
  }

  private encodePaint(frame: GpuFrame): void {
    for (const [layer, operations] of this.operations) {
      const pass = this.quads.begin(frame, layer.source, 'load');
      for (const operation of operations) operation.encode(pass, { frame, target: layer.source });
      pass.end();
    }
  }

  /** Submit queued paint before taking a history snapshot or changing source ownership. */
  flush(): void {
    if (!this.operations.size) return;
    const frame = this.gpu.beginFrame();
    try { this.encodePaint(frame); frame.submit(); this.operations.clear(); }
    catch (error) { frame.release(); throw error; }
  }

  render(
    root: GroupLayer, view: GPUTextureView, viewport: Rect, framing: Rect, pixelsPerUnit: number,
    selection: ImageLayer | null = null, editingSelection = false, maskEdit: ImageLayer | null = null, generation: GenerationVisual | null = null,
  ): RenderStats {
    const start = performance.now();
    const frame = this.gpu.beginFrame();
    this.stats = { updatedLayers: 0, cachedLayers: 0, encodingMs: 0 };
    try {
      this.prepare(root);
      this.encodePaint(frame);
      if (maskEdit) {
        const output = this.evaluate(frame, maskEdit, maskEdit.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
        const world = maskEdit.worldTransform();
        const magnified = maxScale(world) * pixelsPerUnit > output.surface.scale;
        this.quads.present(frame, output.surface, view, viewport, 1, framing, magnified, world);
      } else {
        const output = this.evaluate(frame, root, IDENTITY, pixelsPerUnit);
        this.quads.present(frame, output.surface, view, viewport, root.visible ? root.opacity : 0, framing, pixelsPerUnit > 1);
        if (selection) {
          const mask = this.evaluate(frame, selection, selection.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
          this.outline.encode(frame, mask.surface, inverse(selection.worldTransform()), view, viewport, framing, pixelsPerUnit, editingSelection);
        }
      }
      if (generation && !maskEdit) this.generationOverlay.encode(frame, view, viewport, framing, generation);
      frame.submit();
      this.operations.clear();
      this.stats.encodingMs = performance.now() - start;
      return this.stats;
    } catch (error) {
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  /** Resolve current effects for sampling or a committed preview, including hidden layers. */
  resolve(layer: Layer, pixelsPerUnit: number): Surface {
    const frame = this.gpu.beginFrame();
    try {
      this.prepare(layer);
      this.encodePaint(frame);
      const output = this.evaluate(frame, layer, layer.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
      frame.submit();
      this.operations.clear();
      return output.surface;
    } catch (error) {
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  filterInput(layer: Layer, filterId: string): Surface | undefined { return this.caches.get(layer)?.filterInputs.get(filterId); }

  release(layer: Layer): void {
    if (layer instanceof GroupLayer) for (const child of layer.children) this.release(child);
    if (layer === this.generationPreview?.layer || layer === this.generationPreview?.root) this.generationPreview = null;
    if (layer instanceof ImageLayer) { this.operations.delete(layer); layer.sourceTexture.destroy(); }
    const cache = this.caches.get(layer);
    if (cache) for (const surface of cache.surfaces.values()) surface.texture.destroy();
    this.caches.delete(layer);
    layer.output = null;
  }

  private evaluate(frame: GpuFrame, layer: Layer, parentTransform: Matrix, pixelsPerUnit: number): Evaluation {
    const evaluated = this.evaluated.get(layer);
    if (evaluated) return evaluated;
    if (this.visiting.has(layer)) throw new Error('Circular layer dependency.');
    this.visiting.add(layer);
    const world = multiply(parentTransform, layer.transform);
    let scale = layer instanceof ImageLayer ? 1 : 2 ** Math.ceil(Math.log2(Math.max(1 / 16, maxScale(world) * pixelsPerUnit)));
    const cache = this.caches.get(layer) ?? { revision: -1, signature: '', scale, surfaces: new Map<string, Surface>(), filterInputs: new Map<string, Surface>() };
    this.caches.set(layer, cache);
    const children: EvaluatedChild[] = [];
    let childrenChanged = false;
    if (layer instanceof GroupLayer) {
      const preview = this.generationPreview?.root === layer ? this.generationPreview.layer : null;
      const childrenToRender = preview ? [...layer.children, preview] : layer.children;
      for (const child of childrenToRender) {
        if (!child.visibleInStack || child.opacity === 0) continue;
        const evaluated = this.evaluate(frame, child, world, pixelsPerUnit);
        children.push({ layer: child, surface: evaluated.surface });
        childrenChanged ||= evaluated.changed;
      }
    }
    const filters = layer.filters.filter((filter) => filter.enabled);
    const dependencies = new Map<string, Layer>();
    for (const filter of filters) for (const id of filter.dependencies()) {
      const dependency = this.index.get(id);
      if (!dependency) continue;
      this.evaluate(frame, dependency, dependency.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
      dependencies.set(id, dependency);
    }
    const signature = JSON.stringify([
      children.map(({ layer: child }) => [child.id, child.outputRevision, child.transform, child.opacity, child.blendMode]),
      [...dependencies.values()].map((item) => [item.id, item.outputRevision, item.worldTransform()]),
      dependencies.size ? world : null,
    ]);
    const groupBounds = unionBounds(children.map((child) => transformBounds(child.layer.transform, child.surface.bounds)));
    if (layer instanceof GroupLayer) {
      const bounds = filters.reduce((bounds, filter) => filter.outputBounds(bounds), groupBounds);
      const limit = this.gpu.device.limits.maxTextureDimension2D - 8 * (filters.length + 1);
      // Zoom magnifies cached pixels once a monolithic group reaches this raster budget.
      const cap = Math.min(limit / Math.max(bounds.width, bounds.height), Math.sqrt(16 * 1024 * 1024 / (bounds.width * bounds.height)));
      scale = Math.min(scale, 2 ** Math.floor(Math.log2(cap)));
    }
    if (layer.output && cache.revision === layer.revision && cache.scale === scale && cache.signature === signature && !childrenChanged) {
      this.stats.cachedLayers++;
      const result = { surface: layer.output, changed: false };
      this.visiting.delete(layer);
      this.evaluated.set(layer, result);
      return result;
    }
    const used = new Set<string>();
    const surface = (key: string, requestedBounds: Rect, density = scale, format = WORKING_FORMAT): Surface => {
      used.add(key);
      const existing = cache.surfaces.get(key);
      const bounds = rasterBounds(requestedBounds, density);
      if (existing && existing.texture.format === format && existing.scale === density && existing.texture.width === Math.round(bounds.width * density) &&
        existing.texture.height === Math.round(bounds.height * density)) {
        const reused = { ...existing, bounds };
        cache.surfaces.set(key, reused);
        return reused;
      }
      const replacement = createSurface(this.gpu.device, `${layer.name}: ${key}`, bounds, density, format);
      if (existing) frame.retire(existing.texture);
      cache.surfaces.set(key, replacement);
      return replacement;
    };
    let content: Surface;
    if (layer instanceof ImageLayer) {
      content = layer.source;
      if (layer.channels === 1 && layer.filters.length > 0) {
        const expanded = surface('mask-input', content.bounds, 1);
        this.quads.copy(frame, content, expanded);
        content = expanded;
      }
    }
    else if (layer instanceof GroupLayer) {
      content = surface('children', groupBounds);
      const pass = this.quads.begin(frame, content);
      for (const child of children) {
        const magnified = maxScale(child.layer.transform) * content.scale > child.surface.scale;
        this.quads.draw(pass, frame, child.surface, content, child.layer.transform, child.layer.opacity, child.layer.blendMode, false, magnified);
      }
      pass.end();
    } else throw new Error(`No content renderer for layer kind: ${layer.kind}`);

    cache.filterInputs.clear();
    for (const filter of layer.filters) {
      cache.filterInputs.set(filter.id, content);
      if (!filter.enabled) continue;
      const original = content;
      content = filter.render({
        gpu: this.gpu, frame, quads: this.quads, channels: layer instanceof ImageLayer ? layer.channels : 4,
        surface: (key, bounds, density) => surface(`${filter.id}:${key}`, bounds, density),
        layer: (id) => {
          const mask = dependencies.get(id);
          return mask?.output ? { surface: mask.output, transform: multiply(inverse(mask.worldTransform()), world) } : null;
        },
      }, original);
      if (filter.mix < 1) {
        const bounds = filter.mix === 0 ? original.bounds : unionBounds([original.bounds, content.bounds]);
        const mixed = surface(`mix:${filter.id}`, bounds, original.scale);
        this.mixer.encode(frame, original, content, mixed, 1 - filter.mix);
        content = mixed;
      }
    }
    if (layer instanceof ImageLayer && layer.channels === 1) {
      const output = surface('mask-output', content.bounds, content.scale, MASK_FORMAT);
      if (content === layer.source) {
        frame.encoder.copyTextureToTexture({ texture: content.texture }, { texture: output.texture }, [layer.width, layer.height]);
      } else this.quads.copy(frame, content, output);
      content = output;
    } else if (layer instanceof ImageLayer && content === layer.source) {
      const output = surface('output', content.bounds, 1);
      frame.encoder.copyTextureToTexture({ texture: content.texture }, { texture: output.texture }, { width: layer.width, height: layer.height });
      content = output;
    }
    for (const [key, unused] of cache.surfaces) {
      if (used.has(key)) continue;
      frame.retire(unused.texture);
      cache.surfaces.delete(key);
    }
    layer.output = content;
    cache.revision = layer.revision;
    cache.scale = scale;
    cache.signature = signature;
    layer.outputRevision++;
    this.stats.updatedLayers++;
    const result = { surface: content, changed: true };
    this.visiting.delete(layer);
    this.evaluated.set(layer, result);
    return result;
  }
}