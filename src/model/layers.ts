import { createSurface } from '../gpu/surface';
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

  constructor(public name: string, readonly id: string = crypto.randomUUID()) {}

  get transform(): Matrix { return this.matrix; }
  get opacity(): number { return this.alpha; }
  get visible(): boolean { return this.shown; }
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
    return { name: this.name, transform: [...this.matrix], opacity: this.alpha, visible: this.shown, blendMode: this.blending };
  }

  setProperties(properties: LayerProperties): void {
    this.setTransform(properties.transform as unknown as Matrix);
    this.name = properties.name;
    this.setOpacity(properties.opacity);
    this.setVisible(properties.visible);
    this.setBlendMode(properties.blendMode as BlendMode);
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
    const resized = this.width !== snapshot.texture.width || this.height !== snapshot.texture.height;
    const destination = resized ? createSurface(gpu.device, `${this.name}: source`, snapshot.bounds) : this.source;
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
    if (payload.type === 'layer' && payload.targetId === this.id && (payload.action === 'pixels' || payload.action === 'reframe')) {
      if (!context) throw new Error('GPU context is required to restore pixels.');
      this.restorePixels(context.gpu, operation.snapshot(String(payload.data.snapshotId)));
      if (payload.action === 'reframe') this.setTransform(payload.data.transform as unknown as Matrix);
    } else super.applyUndo(operation, direction, context);
  }
}

export class GroupLayer extends Layer {
  readonly kind = 'group';
  private items: Layer[] = [];
  onInvalidated?: () => void;

  get children(): readonly Layer[] { return this.items; }

  localBounds(): Rect {
    return unionBounds(this.items.filter((layer) => layer.visible).map((layer) => transformBounds(layer.transform, layer.visualBounds())));
  }

  add(layer: Layer, index = this.items.length): void {
    for (let ancestor: Layer | null = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === layer) throw new Error('A group cannot contain itself or an ancestor.');
    }
    layer.parent?.remove(layer);
    this.items.splice(Math.max(0, Math.min(index, this.items.length)), 0, layer);
    layer.parent = this;
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
