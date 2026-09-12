import type { Surface } from '../gpu/surface';
import { IDENTITY, multiply } from './geometry';
import type { Matrix } from './geometry';

export type BlendMode = 'normal' | 'add';

export interface BlurFilter {
  readonly id: string;
  readonly kind: 'blur';
  readonly enabled: boolean;
  readonly sigma: number;
}

export type LayerFilter = BlurFilter;

export abstract class Layer {
  readonly id = crypto.randomUUID();
  abstract readonly kind: string;
  parent: GroupLayer | null = null;
  name: string;
  revision = 0;
  /** Written by the compositor; painting must always target the image source. */
  output: Surface | null = null;
  private matrix: Matrix = IDENTITY;
  private alpha = 1;
  private shown = true;
  private blending: BlendMode = 'normal';
  private effects: readonly LayerFilter[] = [];

  constructor(name: string) { this.name = name; }

  get transform(): Matrix { return this.matrix; }
  get opacity(): number { return this.alpha; }
  get visible(): boolean { return this.shown; }
  get blendMode(): BlendMode { return this.blending; }
  get filters(): readonly LayerFilter[] { return this.effects; }
  get outputTexture(): GPUTexture | null { return this.output?.texture ?? null; }

  setTransform(matrix: Matrix): void {
    if (!matrix.every(Number.isFinite)) throw new Error('Layer transforms must contain finite numbers.');
    this.matrix = [...matrix];
    this.placementChanged();
  }

  setOpacity(opacity: number): void {
    this.alpha = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    this.placementChanged();
  }

  setVisible(visible: boolean): void { this.shown = visible; this.placementChanged(); }
  setBlendMode(mode: BlendMode): void { this.blending = mode; this.placementChanged(); }

  setFilters(filters: readonly LayerFilter[]): void {
    if (new Set(filters.map((filter) => filter.id)).size !== filters.length) {
      throw new Error('Each filter in a layer stack must have a unique ID.');
    }
    for (const filter of filters) {
      if (!Number.isFinite(filter.sigma) || filter.sigma < 0 || filter.sigma > 32) {
        throw new Error('Blur sigma must be between 0 and 32 local pixels.');
      }
    }
    this.effects = filters.map((filter) => Object.freeze({ ...filter }));
    this.invalidate();
  }

  invalidate(): void {
    this.revision++;
    if (this.parent) this.parent.invalidate();
    else if (this instanceof GroupLayer) this.onInvalidated?.();
  }

  worldTransform(): Matrix {
    return this.parent ? multiply(this.parent.worldTransform(), this.matrix) : this.matrix;
  }

  private placementChanged(): void {
    if (this.parent) this.parent.invalidate();
    else this.invalidate();
  }
}

export class ImageLayer extends Layer {
  readonly kind = 'image';
  readonly source: Surface;

  constructor(name: string, source: Surface) {
    super(name);
    this.source = source;
  }

  get sourceTexture(): GPUTexture { return this.source.texture; }
  get width(): number { return this.source.texture.width; }
  get height(): number { return this.source.texture.height; }
}

export class GroupLayer extends Layer {
  readonly kind = 'group';
  private items: Layer[] = [];
  onInvalidated?: () => void;

  /** Bottom-to-top order. A group is isolated before its own filters and opacity. */
  get children(): readonly Layer[] { return this.items; }

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

  move(layer: Layer, direction: -1 | 1): void {
    const index = this.items.indexOf(layer);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.items.length) return;
    [this.items[index], this.items[target]] = [this.items[target], this.items[index]];
    this.invalidate();
  }
}

