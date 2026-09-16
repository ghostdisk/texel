import type { GenerationFrame } from '../generation/lens';
import { GenerationOverlay } from './generation-overlay';
import type { GenerationVisual } from './generation-overlay';
import { IDENTITY, inverse, maxScale, multiply, transformBounds, unionBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import { GroupLayer, ImageLayer, Layer, isFixedBlendMode, layerIndex, validateLayerDependencies } from '../model/layers';
import type { RenderOperation } from './brush';
import type { Gpu, GpuFrame } from './device';
import { QuadRenderer } from './quad';
import type { QuadPass } from './quad';
import { FilterMixer } from './filter-mix';
import { SelectionOutline } from './selection-outline';
import { BlendCompositor } from './blend';
import { createSurface, matchesSurface, planTiles, MASK_FORMAT, WORKING_FORMAT } from './surface';
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
  private readonly blender: BlendCompositor;
  private index = new Map<string, Layer>();
  private evaluated = new Map<Layer, Evaluation>();
  private visiting = new Set<Layer>();
  private readonly excludedLayers = new Set<Layer>();
  private readonly operations = new Map<ImageLayer, RenderOperation[]>();
  private stats: RenderStats = { updatedLayers: 0, cachedLayers: 0, encodingMs: 0 };

  constructor(private readonly gpu: Gpu, canvasFormat: GPUTextureFormat) {
    this.quads = new QuadRenderer(gpu, canvasFormat);
    this.mixer = new FilterMixer(gpu);
    this.outline = new SelectionOutline(gpu, canvasFormat);
    this.generationOverlay = new GenerationOverlay(gpu, canvasFormat);
    this.blender = new BlendCompositor(gpu);
  }

  captureGenerationInput(root: GroupLayer, target: GenerationFrame, selection: ImageLayer | null, excludedLayers: readonly Layer[] = []): GenerationCapture {
    const frame = this.gpu.beginFrame();
    const bounds = { x: 0, y: 0, width: target.width, height: target.height };
    const input = createSurface('Generation input', bounds);
    let mask: Surface | null = null;
    try {
      this.prepare(root, excludedLayers);
      this.encodePaint(frame);
      const worldToPixels = inverse(target.transform);
      const density = maxScale(worldToPixels);
      const output = this.evaluate(frame, root, IDENTITY, density).surface;
      const pass = this.quads.begin(frame, input);
      this.quads.draw(pass, frame, output, input, multiply(worldToPixels, root.worldTransform()), root.visible ? root.opacity : 0);
      pass.end();
      if (selection) {
        const output = this.evaluate(frame, selection, selection.parent?.worldTransform() ?? IDENTITY, density).surface;
        mask = createSurface('Generation selection', bounds, 1, MASK_FORMAT);
        const pass = this.quads.begin(frame, mask);
        this.quads.draw(pass, frame, output, mask, multiply(worldToPixels, selection.worldTransform()));
        pass.end();
      }
      frame.submit();
      this.operations.clear();
      return { input, mask };
    } catch (error) {
      input.destroy();
      mask?.destroy();
      frame.release();
      throw error;
    } finally { this.excludedLayers.clear(); }
  }

  /** Render the document into its canonical canvas, without presentation-only overlays. */
  captureDocument(root: GroupLayer, bounds: Rect, scale = 1): Surface {
    const frame = this.gpu.beginFrame();
    const result = createSurface('Document export', bounds, scale);
    try {
      this.prepare(root);
      this.encodePaint(frame);
      const output = this.evaluate(frame, root, IDENTITY, scale, scale > 1).surface;
      const pass = this.quads.begin(frame, result);
      this.quads.draw(pass, frame, output, result, root.worldTransform(), root.visible ? root.opacity : 0);
      pass.end();
      frame.submit();
      this.operations.clear();
      return result;
    } catch (error) {
      result.destroy();
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  /** Render one layer into its transformed document-space bounds without sibling contributions. */
  captureLayer(root: GroupLayer, layer: Layer, scale = 1): Surface {
    const bounds = transformBounds(layer.worldTransform(), layer.localBounds());
    const frame = this.gpu.beginFrame();
    const result = createSurface(`${layer.name} export`, { x: 0, y: 0, width: bounds.width, height: bounds.height }, scale);
    try {
      this.prepare(root);
      this.encodePaint(frame);
      const output = this.evaluate(frame, layer, layer.parent?.worldTransform() ?? IDENTITY, scale, scale > 1).surface;
      const pass = this.quads.begin(frame, result);
      this.quads.draw(pass, frame, output, result, multiply([1, 0, 0, 1, -bounds.x, -bounds.y], layer.worldTransform()), layer.opacity);
      pass.end();
      frame.submit();
      this.operations.clear();
      return result;
    } catch (error) {
      result.destroy();
      for (const cache of this.caches.values()) cache.revision = -1;
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
      const surface = createSurface(label, bounds, scale);
      frame.retire(surface);
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
        const needsShader = children.some((child) => !isFixedBlendMode(child.layer.effectiveBlendMode));
        const first = applyFilters ? temporary('Merge group contents', bounds, scale) : createSurface('Merged layers', bounds, scale);
        const second = needsShader ? applyFilters ? temporary('Merge group blend', bounds, scale) :
          createSurface('Merged layers blend', bounds, scale) : null;
        let content = this.compositeChildren(frame, children, first, second);
        if (!applyFilters) {
          result = content;
          if (second) frame.retire(content === first ? second : first);
        }
        if (applyFilters) for (const filter of group.filters) {
          if (!filter.enabled || filter.mix === 0) continue;
          const masks = new Map<string, Layer>();
          for (const id of filter.dependencies()) {
            const dependency = this.index.get(id);
            if (!dependency) continue;
            this.evaluate(frame, dependency, dependency.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
            masks.set(id, dependency);
          }
          const original = content;
          content = filter.renderLocal({
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
      const normalized = createSurface('Merged layer pixels', { x: 0, y: 0, width: output.width, height: output.height }, 1, output.format);
      const normalize = this.gpu.beginFrame();
      try {
        const pass = this.quads.begin(normalize, normalized);
        this.quads.draw(pass, normalize, output, normalized, [output.scale, 0, 0, output.scale, -output.bounds.x * output.scale, -output.bounds.y * output.scale]);
        pass.end();
        normalize.submit();
      } catch (error) { normalized.destroy(); normalize.release(); throw error; }
      output.destroy();
      return { surface: normalized, transform: [1 / output.scale, 0, 0, 1 / output.scale, output.bounds.x, output.bounds.y] };
    } catch (error) {
      (result as Surface | null)?.destroy();
      for (const cache of this.caches.values()) cache.revision = -1;
      frame.release();
      throw error;
    }
  }

  private prepare(layer: Layer, excludedLayers: readonly Layer[] = []): void {
    validateLayerDependencies(layer);
    this.index = layerIndex(layer);
    this.excludedLayers.clear();
    const exclude = (item: Layer) => {
      this.excludedLayers.add(item);
      this.index.delete(item.id);
      if (item instanceof GroupLayer) item.children.forEach(exclude);
    };
    excludedLayers.forEach(exclude);
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
      for (const operation of operations) for (const [key, region] of planTiles(layer.source, operation.regions())) {
        if (operation.erase && !layer.source.tiles.has(key)) continue;
        const color = operation.solidColor?.(layer.source, region);
        if (color) { layer.source.setColor(frame, region.x, region.y, color); continue; }
        const target = layer.source.writable(frame, region.x, region.y, region.bounds, true);
        operation.encode({ frame, target, image: layer.source, quads: this.quads });
      }
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
    background: GPUColorDict,
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
        this.quads.present(frame, output.surface, view, viewport, 1, framing, background, magnified, world);
      } else {
        const output = this.evaluate(frame, root, IDENTITY, pixelsPerUnit);
        this.quads.present(frame, output.surface, view, viewport, root.visible ? root.opacity : 0, framing, background, pixelsPerUnit > 1);
        if (selection) {
          const mask = this.evaluate(frame, selection, selection.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit);
          this.outline.encode(frame, mask.surface, inverse(selection.worldTransform()), view, viewport, framing, pixelsPerUnit, editingSelection);
        }
      }
      if (generation && !maskEdit) this.generationOverlay.encode(frame, view, viewport, framing, generation, pixelsPerUnit);
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
    if (layer instanceof ImageLayer) { this.operations.delete(layer); layer.source.destroy(); }
    const cache = this.caches.get(layer);
    if (cache) for (const surface of cache.surfaces.values()) surface.destroy();
    this.caches.delete(layer);
    layer.output = null;
  }

  private compositeChildren(
    frame: GpuFrame, children: readonly EvaluatedChild[], first: Surface, second: Surface | null,
  ): Surface {
    if (!second) {
      const pass = this.quads.begin(frame, first);
      for (const child of children) {
        if (!isFixedBlendMode(child.layer.effectiveBlendMode)) throw new Error('Shader blend requires a separate stage.');
        const magnified = maxScale(child.layer.transform) * first.scale > child.surface.scale;
        this.quads.draw(pass, frame, child.surface, first, child.layer.transform, child.layer.opacity, child.layer.effectiveBlendMode, false, magnified);
      }
      pass.end();
      return first;
    }
    let current = second;
    // The empty backdrop has no tile records. Every prefix has its own persistent cache.
    second.retain(new Set(), frame);
    const used = new Set<string>();
    children.forEach((child, index) => {
      const key = 'stack:' + index;
      used.add(key);
      const output = index === children.length - 1 ? first : first.scratch(frame, key);
      const magnified = maxScale(child.layer.transform) * first.scale > child.surface.scale;
      if (isFixedBlendMode(child.layer.effectiveBlendMode)) {
        const pass = this.quads.begin(frame, output);
        this.quads.draw(pass, frame, current, output);
        this.quads.draw(pass, frame, child.surface, output, child.layer.transform, child.layer.opacity, child.layer.effectiveBlendMode, false, magnified);
        pass.end();
      } else this.blender.encode(frame, current, child.surface, output, child.layer.transform, child.layer.opacity, child.layer.effectiveBlendMode, magnified);
      current = output;
    });
    first.retainScratch(frame, 'stack:', used);
    return current;
  }

  private evaluate(frame: GpuFrame, layer: Layer, parentTransform: Matrix, pixelsPerUnit: number, allowUpscale = false): Evaluation {
    const evaluated = this.evaluated.get(layer);
    if (evaluated) return evaluated;
    if (this.visiting.has(layer)) throw new Error('Circular layer dependency.');
    this.visiting.add(layer);
    const world = multiply(parentTransform, layer.transform);
    const scale = layer instanceof ImageLayer ? 1 : Math.min(allowUpscale ? Infinity : 1,
      2 ** Math.ceil(Math.log2(Math.max(1 / 16, maxScale(world) * pixelsPerUnit))));
    const cache = this.caches.get(layer) ?? { revision: -1, signature: '', scale, surfaces: new Map<string, Surface>(), filterInputs: new Map<string, Surface>() };
    this.caches.set(layer, cache);
    const children: EvaluatedChild[] = [];
    let childrenChanged = false;
    if (layer instanceof GroupLayer) {
      for (const child of layer.children) {
        if (!child.visibleInStack || child.opacity === 0 || this.excludedLayers.has(child)) continue;
        const evaluated = this.evaluate(frame, child, world, pixelsPerUnit, allowUpscale);
        children.push({ layer: child, surface: evaluated.surface });
        childrenChanged ||= evaluated.changed;
      }
    }
    const filters = layer.filters.filter((filter) => filter.enabled && filter.mix > 0);
    const dependencies = new Map<string, Layer>();
    for (const filter of filters) for (const id of filter.dependencies()) {
      const dependency = this.index.get(id);
      if (!dependency) continue;
      this.evaluate(frame, dependency, dependency.parent?.worldTransform() ?? IDENTITY, pixelsPerUnit, allowUpscale);
      dependencies.set(id, dependency);
    }
    const signature = JSON.stringify([
      children.map(({ layer: child }) => [child.id, child.outputRevision, child.transform, child.opacity, child.effectiveBlendMode]),
      [...dependencies.values()].map((item) => [item.id, item.outputRevision, item.worldTransform()]),
      dependencies.size ? world : null,
    ]);
    const groupBounds = unionBounds(children.map((child) => transformBounds(child.layer.transform, child.surface.bounds)));
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
      const bounds = requestedBounds;
      if (existing && existing.format === format && matchesSurface(existing, bounds, density)) return existing;
      const replacement = createSurface(`${layer.name}: ${key}`, bounds, density, format);
      if (existing) frame.retire(existing);
      cache.surfaces.set(key, replacement);
      return replacement;
    };
    let content: Surface;
    if (layer instanceof ImageLayer) {
      content = layer.source;
    }
    else if (layer instanceof GroupLayer) {
      const needsShader = children.some((child) => !isFixedBlendMode(child.layer.effectiveBlendMode));
      const first = surface(needsShader ? 'children-a' : 'children', groupBounds);
      const second = needsShader ? surface('children-b', groupBounds) : null;
      content = this.compositeChildren(frame, children, first, second);
    } else throw new Error(`No content renderer for layer kind: ${layer.kind}`);

    cache.filterInputs.clear();
    for (const filter of layer.filters) {
      cache.filterInputs.set(filter.id, content);
      if (!filter.enabled || filter.mix === 0) continue;
      const original = content;
      content = filter.renderLocal({
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
      if (layer instanceof ImageLayer && layer.channels === 1 && content.format !== MASK_FORMAT) {
        const output = surface(`mask-after:${filter.id}`, content.bounds, content.scale, MASK_FORMAT);
        this.quads.copy(frame, content, output);
        content = output;
      }
    }
    for (const [key, unused] of cache.surfaces) {
      if (used.has(key)) continue;
      frame.retire(unused);
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
