import { createSurface, isMaskSurface } from '../gpu/surface';
import type { Surface } from '../gpu/surface';
import type { Gpu } from '../gpu/device';
import type { Filter, FilterRegistry, SerializedFilter } from '../filters/filter';
import type { JsonObject, UndoDirection, UndoOperation, UndoTarget } from '../history/undo';
import { IDENTITY, multiply, transformBounds, unionBounds } from './geometry';
import type { Matrix, Rect } from './geometry';

export type BlendMode = 'normal' | 'add';

export interface LayerProperties extends JsonObject {
  name: string;
  transform: number[];
  opacity: number;
  visible: boolean;
  blendMode: string;
  selection: boolean;
}

export interface LayerUndoContext {
  gpu: Gpu;
  filters: FilterRegistry;
}

export abstract class Layer implements UndoTarget {
  abstract readonly kind: string;
  parent: GroupLayer | null = null;
  revision = 0;
  /** Derived pixels, owned by the compositor. */
  output: Surface | null = null;
  private matrix: Matrix = IDENTITY;
  private alpha = 1;
  private shown = true;
  private blending: BlendMode = 'normal';
  private effects: Filter[] = [];
  private selection = false;
  outputRevision = 0;

  constructor(public name: string, readonly id: string = crypto.randomUUID()) {}

  get isSelection(): boolean { return this.selection; }
  setSelection(value: boolean): void { this.selection = value; this.invalidate(); }

  get transform(): Matrix { return this.matrix; }
  get opacity(): number { return this.alpha; }
  get visible(): boolean { return this.shown; }
  get visibleInStack(): boolean { return this.visible && !this.isSelection; }
  get blendMode(): BlendMode { return this.blending; }
  get filters(): readonly Filter[] { return this.effects; }
  get outputTexture(): GPUTexture | null { return this.output?.texture ?? null; }
  abstract localBounds(): Rect;

  visualBounds(): Rect {
    return this.effects.reduce((bounds, filter) => {
      if (!filter.enabled || filter.mix === 0) return bounds;
      const filtered = filter.outputBounds(bounds);
      return filter.mix === 1 ? filtered : unionBounds([bounds, filtered]);
    }, this.localBounds());
  }

  properties(): LayerProperties {
    return { name: this.name, transform: [...this.matrix], opacity: this.alpha, visible: this.shown, blendMode: this.blending, selection: this.selection };
  }

  setProperties(properties: LayerProperties): void {
    this.setTransform(properties.transform as unknown as Matrix);
    this.name = properties.name;
    this.setOpacity(properties.opacity);
    this.setVisible(properties.visible);
    this.setBlendMode(properties.blendMode as BlendMode);
    this.setSelection(properties.selection ?? false);
  }

  setTransform(matrix: Matrix): void {
    if (matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new Error('Layer transforms must contain six finite numbers.');
    this.matrix = [...matrix];
    this.placementChanged();
  }

  setOpacity(opacity: number): void {
    this.alpha = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    this.placementChanged();
  }


  setVisible(visible: boolean): void { this.shown = visible; this.placementChanged(); }
  setBlendMode(mode: BlendMode): void { this.blending = mode; this.placementChanged(); }

  addFilter(filter: Filter, index = this.effects.length): void {
    if (this.effects.some((item) => item.id === filter.id)) throw new Error('Duplicate filter ID.');
    this.effects.splice(index, 0, filter);
    try { validateLayerDependencies(this); }
    catch (error) { this.effects.splice(this.effects.indexOf(filter), 1); throw error; }
    this.invalidate();
  }

  removeFilter(id: string): void {
    const index = this.effects.findIndex((filter) => filter.id === id);
    if (index < 0) throw new Error(`Unknown filter: ${id}`);
    this.effects.splice(index, 1);
    this.invalidate();
  }

  moveFilter(id: string, index: number): void {
    const previous = this.effects.findIndex((filter) => filter.id === id);
    if (previous < 0) throw new Error(`Unknown filter: ${id}`);
    if (!Number.isInteger(index)) throw new Error('Filter index must be an integer.');
    const destination = Math.max(0, Math.min(index, this.effects.length - 1));
    if (previous === destination) return;
    const [filter] = this.effects.splice(previous, 1);
    this.effects.splice(destination, 0, filter);
    this.invalidate();
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection, context?: LayerUndoContext): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'layer' || payload.targetId !== this.id) throw new Error('Undo operation targets a different layer.');
    switch (payload.action) {
      case 'properties': this.setProperties(payload.data.properties as LayerProperties); break;
      case 'add-filter':
        if (!context) throw new Error('Filter registry is required to restore a filter.');
        this.addFilter(context.filters.deserialize(payload.data.filter as SerializedFilter), Number(payload.data.index));
        break;
      case 'remove-filter': this.removeFilter(String(payload.data.filterId)); break;
      case 'move-filter': this.moveFilter(String(payload.data.filterId), Number(payload.data.index)); break;
      default: throw new Error(`Unsupported layer undo action: ${payload.action}`);
    }
  }

  invalidate(): void {
    this.revision++;
    if (this.parent) this.parent.invalidate();
    else if (this instanceof GroupLayer) this.onInvalidated?.();
  }

  worldTransform(): Matrix { return this.parent ? multiply(this.parent.worldTransform(), this.matrix) : this.matrix; }

  private placementChanged(): void {
    if (this.parent) this.parent.invalidate();
    else this.invalidate();
  }
}

export class ImageLayer extends Layer {
  readonly kind = 'image';

  constructor(name: string, private pixels: Surface, id?: string) { super(name, id); }

  get channels(): 1 | 4 { return isMaskSurface(this.source) ? 1 : 4; }
  override get visibleInStack(): boolean { return this.channels === 4 && super.visibleInStack; }
  get source(): Surface { return this.pixels; }
  get sourceTexture(): GPUTexture { return this.source.texture; }
  get width(): number { return this.source.texture.width; }
  get height(): number { return this.source.texture.height; }
  localBounds(): Rect { return this.source.bounds; }

  replaceSource(source: Surface): void {
    if (source === this.pixels) return;
    const previous = this.pixels;
    this.pixels = source;
    this.output = null;
    this.invalidate();
    previous.texture.destroy();
  }

  restorePixels(gpu: Gpu, snapshot: Surface): void {
    const resized = this.width !== snapshot.texture.width || this.height !== snapshot.texture.height || this.sourceTexture.format !== snapshot.texture.format;
    const destination = resized ? createSurface(gpu.device, `${this.name}: source`, snapshot.bounds, snapshot.scale, snapshot.texture.format) : this.source;
    try {
      const encoder = gpu.device.createCommandEncoder({ label: 'Restore layer pixels' });
      encoder.copyTextureToTexture(
        { texture: snapshot.texture }, { texture: destination.texture },
        { width: snapshot.texture.width, height: snapshot.texture.height },
      );
      gpu.device.queue.submit([encoder.finish()]);
    } catch (error) { if (resized) destination.texture.destroy(); throw error; }
    if (resized) this.replaceSource(destination);
    else this.invalidate();
  }

  override applyUndo(operation: UndoOperation, direction: UndoDirection, context?: LayerUndoContext): void {
    const payload = operation.payload(direction);
    if (payload.type === 'layer' && payload.targetId === this.id && (payload.action === 'pixels' || payload.action === 'reframe' || payload.action === 'apply-filter')) {
      if (!context) throw new Error('GPU context is required to restore pixels.');
      this.restorePixels(context.gpu, operation.snapshot(String(payload.data.snapshotId)));
      if (payload.action !== 'pixels') this.setTransform(payload.data.transform as unknown as Matrix);
      if (payload.action === 'apply-filter') {
        for (const filter of [...this.filters]) this.removeFilter(filter.id);
        for (const filter of payload.data.filters as SerializedFilter[]) this.addFilter(context.filters.deserialize(filter));
      }
    } else super.applyUndo(operation, direction, context);
  }
}

export class GroupLayer extends Layer {
  readonly kind = 'group';
  private items: Layer[] = [];
  onInvalidated?: () => void;

  get children(): readonly Layer[] { return this.items; }

  localBounds(): Rect {
    return unionBounds(this.items.filter((layer) => layer.visibleInStack).map((layer) => transformBounds(layer.transform, layer.visualBounds())));
  }

  add(layer: Layer, index = this.items.length): void {
    for (let ancestor: Layer | null = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === layer) throw new Error('A group cannot contain itself or an ancestor.');
    }
    const previous = layer.parent;
    const previousIndex = previous?.children.indexOf(layer) ?? 0;
    layer.parent?.remove(layer);
    this.items.splice(Math.max(0, Math.min(index, this.items.length)), 0, layer);
    layer.parent = this;
    try { validateLayerDependencies(this); }
    catch (error) {
      this.items.splice(this.items.indexOf(layer), 1);
      layer.parent = previous;
      if (previous) previous.items.splice(previousIndex, 0, layer);
      this.invalidate();
      previous?.invalidate();
      throw error;
    }
    this.invalidate();
  }

  remove(layer: Layer): void {
    const index = this.items.indexOf(layer);
    if (index < 0) return;
    this.items.splice(index, 1);
    layer.parent = null;
    this.invalidate();
  }
}

/** Dependencies include group composition and every filter link, even when disabled. */
export function layerIndex(layer: Layer): Map<string, Layer> {
  while (layer.parent) layer = layer.parent;
  const result = new Map<string, Layer>();
  const visit = (item: Layer) => {
    result.set(item.id, item);
    if (item instanceof GroupLayer) item.children.forEach(visit);
  };
  visit(layer);
  return result;
}

export function layerInputs(layer: Layer, index: ReadonlyMap<string, Layer>): Layer[] {
  const inputs = layer instanceof GroupLayer ? [...layer.children] : [];
  for (const filter of layer.filters) for (const id of filter.dependencies()) {
    const source = index.get(id);
    if (source) inputs.push(source);
  }
  return inputs;
}

export function canReferenceLayer(owner: Layer, source: Layer): boolean {
  const index = layerIndex(owner);
  const visited = new Set<Layer>();
  const reachesOwner = (layer: Layer): boolean => {
    if (layer === owner) return true;
    if (visited.has(layer)) return false;
    visited.add(layer);
    return layerInputs(layer, index).some(reachesOwner);
  };
  return index.has(source.id) && !reachesOwner(source);
}

export function validateLayerDependencies(layer: Layer): void {
  const index = layerIndex(layer);
  const visiting = new Set<Layer>();
  const visited = new Set<Layer>();
  const visit = (item: Layer) => {
    if (visiting.has(item)) throw new Error('This mask link or group placement would create a circular layer dependency.');
    if (visited.has(item)) return;
    visiting.add(item);
    layerInputs(item, index).forEach(visit);
    visiting.delete(item);
    visited.add(item);
  };
  index.forEach(visit);
}