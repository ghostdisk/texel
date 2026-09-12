import type { Gpu } from '../gpu/device';
import type { Compositor } from '../gpu/compositor';
import { createImageLayer } from '../gpu/images';
import { createSurface, rasterBounds, MASK_FORMAT, WORKING_FORMAT } from '../gpu/surface';
import { LayerReframer } from '../gpu/reframe';
import type { Surface } from '../gpu/surface';
import type { FilterRegistry, SerializedFilter } from '../filters/filter';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection, UndoStack, UndoTarget } from '../history/undo';
import { GroupLayer, ImageLayer, Layer } from './layers';
import type { LayerProperties } from './layers';
import { IDENTITY, inverse, multiply, transformBounds, unionBounds } from './geometry';
import type { Matrix, Rect } from './geometry';

export type ReframeMode = 'normalize' | 'trim' | 'extend';

export interface SerializedLayer extends JsonObject {
  id: string;
  kind: string;
  properties: LayerProperties;
  filters: SerializedFilter[];
  width: number;
  height: number;
  channels: number;
  snapshotId: string | null;
  children: SerializedLayer[];
}

export class ImageDocument implements UndoTarget {
  id: string = crypto.randomUUID();
  root = new GroupLayer('Document');
  selected: Layer = this.root;
  private canvasWidth = 1000;
  private canvasHeight = 750;
  private readonly reframer: LayerReframer;
  onChange?: () => void;
  onInvalidated?: () => void;

  constructor(
    readonly gpu: Gpu,
    private readonly compositor: Compositor,
    readonly filters: FilterRegistry,
    private readonly history: UndoStack,
    private readonly flush: () => void,
  ) {
    this.root.onInvalidated = () => this.onInvalidated?.();
    this.reframer = new LayerReframer(gpu, compositor.quads);
  }

  /** Canonical pixel dimensions, fixed when the document is created. */
  get width(): number { return this.canvasWidth; }
  get height(): number { return this.canvasHeight; }
  get frame(): Rect { return { x: 0, y: 0, width: this.width, height: this.height }; }

  allLayers(): Layer[] {
    const result: Layer[] = [];
    const visit = (layer: Layer) => { result.push(layer); if (layer instanceof GroupLayer) layer.children.forEach(visit); };
    visit(this.root);
    return result;
  }

  find(id: string): Layer {
    const layer = this.allLayers().find((item) => item.id === id);
    if (!layer) throw new Error(`Unknown layer: ${id}`);
    return layer;
  }

  get selectionMask(): ImageLayer | null {
    return this.allLayers().find((layer): layer is ImageLayer => layer instanceof ImageLayer && layer.isSelection) ?? null;
  }

  createPixelLayer(): void {
    const parent = this.destination();
    const layer = createImageLayer(this.gpu, 'Pixel layer', this.width, this.height);
    try {
      layer.setTransform(inverse(parent.worldTransform()));
      this.add(layer, parent);
    } catch (error) { if (!layer.parent) this.compositor.release(layer); throw error; }
  }

  createMask(): void {
    const parent = this.destination();
    const mask = createImageLayer(this.gpu, 'Mask', this.width, this.height, 1, 1);
    mask.setTransform(inverse(parent.worldTransform()));
    this.add(mask, parent, 0);
  }

  ensureSelection(fill = false): ImageLayer {
    const existing = this.selectionMask;
    if (existing) { if (fill) this.fillSelection(existing); return existing; }
    const layer = createImageLayer(this.gpu, 'Selection', this.width, this.height, 1, Number(fill));
    layer.setSelection(true);
    layer.setTransform(inverse(this.root.worldTransform()));
    this.add(layer, this.root, 0, false);
    return layer;
  }

  private fillSelection(layer: ImageLayer): void {
    const snapshots = new Map<string, Surface>();
    const source = createImageLayer(this.gpu, 'Selection', this.width, this.height, 1, 1).source;
    const beforeTransform = [...layer.transform];
    const transform = inverse(layer.parent?.worldTransform() ?? IDENTITY);
    try {
      const before = this.capturePixels(layer, snapshots);
      const after = this.captureSurface(source, snapshots);
      layer.replaceSource(source);
      layer.setTransform(transform);
      this.history.push(new UndoOperation(
        'Select all',
        { type: 'layer', targetId: layer.id, action: 'reframe', data: { snapshotId: before, transform: beforeTransform } },
        { type: 'layer', targetId: layer.id, action: 'reframe', data: { snapshotId: after, transform: [...transform] } },
        snapshots,
      ));
    } catch (error) {
      if (layer.source !== source) source.texture.destroy();
      for (const snapshot of snapshots.values()) snapshot.texture.destroy();
      throw error;
    }
  }

  select(layer: Layer): void { this.selected = layer; this.onChange?.(); }
  destination(): GroupLayer { return this.selected instanceof GroupLayer ? this.selected : this.selected.parent ?? this.root; }

  reset(width: number, height: number): void {
    const initial = createImageLayer(this.gpu, 'Pixel layer', width, height);
    this.flush();
    this.history.clear();
    this.root.onInvalidated = undefined;
    this.compositor.release(this.root);
    this.id = crypto.randomUUID();
    this.root = new GroupLayer('Document');
    this.root.onInvalidated = () => this.onInvalidated?.();
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.root.add(initial);
    this.select(initial);
  }

  capturePixels(layer: ImageLayer, snapshots: Map<string, Surface>): string {
    this.flush();
    return this.captureSurface(layer.source, snapshots);
  }

  private captureSurface(source: Surface, snapshots: Map<string, Surface>): string {
    const id = crypto.randomUUID();
    const snapshot = createSurface(this.gpu.device, 'Undo snapshot', source.bounds, source.scale, source.texture.format);
    try {
      const encoder = this.gpu.device.createCommandEncoder({ label: 'Snapshot layer pixels' });
      encoder.copyTextureToTexture(
        { texture: source.texture }, { texture: snapshot.texture },
        { width: source.texture.width, height: source.texture.height },
      );
      this.gpu.device.queue.submit([encoder.finish()]);
      snapshots.set(id, snapshot);
      return id;
    } catch (error) { snapshot.texture.destroy(); throw error; }
  }

  async reframe(layer: ImageLayer, mode: ReframeMode): Promise<void> {
    this.flush();
    const documentId = this.id;
    const source = layer.source;
    const revision = layer.revision;
    const world = layer.worldTransform();
    const beforeTransform = [...layer.transform];
    let transform: Matrix;
    let replacement: Surface;
    if (mode === 'normalize') {
      if (layer.width === this.width && layer.height === this.height && world.every((value, index) => value === IDENTITY[index])) return;
      // Canvas-aligned in world space, including inside transformed groups.
      transform = layer.parent ? inverse(layer.parent.worldTransform()) : IDENTITY;
      replacement = this.reframer.normalize(source, this.frame, world);
    } else {
      const canvasInLayer = mode === 'extend' ? transformBounds(inverse(world), this.frame) : null;
      const content = await this.reframer.contentBounds(source);
      if (this.id !== documentId || !this.allLayers().includes(layer) || layer.source !== source || layer.revision !== revision ||
        layer.transform.some((value, index) => value !== beforeTransform[index]) || layer.worldTransform().some((value, index) => value !== world[index])) {
        throw new Error('The layer changed while measuring its bounds. Retry the reframe operation.');
      }
      // Empty layers trim to one transparent pixel; extension uses only the canvas when empty.
      const bounds = rasterBounds(canvasInLayer ? unionBounds(content ? [content, canvasInLayer] : [canvasInLayer]) :
        content ?? { x: 0, y: 0, width: 1, height: 1 }, 1);
      if (bounds.x === 0 && bounds.y === 0 && bounds.width === layer.width && bounds.height === layer.height) return;
      transform = multiply(layer.transform, [1, 0, 0, 1, bounds.x, bounds.y]);
      replacement = this.reframer.resize(source, bounds);
    }
    const snapshots = new Map<string, Surface>();
    let operation: UndoOperation;
    try {
      const before = this.captureSurface(source, snapshots);
      const after = this.captureSurface(replacement, snapshots);
      const label = { normalize: 'Normalize layer to canvas', trim: 'Trim layer', extend: 'Extend layer to canvas' }[mode];
      operation = new UndoOperation(
        label,
        { type: 'layer', targetId: layer.id, action: 'reframe', data: { snapshotId: before, transform: beforeTransform } },
        { type: 'layer', targetId: layer.id, action: 'reframe', data: { snapshotId: after, transform: [...transform] } },
        snapshots,
      );
    } catch (error) {
      replacement.texture.destroy();
      for (const snapshot of snapshots.values()) snapshot.texture.destroy();
      throw error;
    }
    layer.replaceSource(replacement);
    layer.setTransform(transform);
    this.selected = layer;
    this.history.push(operation);
  }

  private serializeLayer(layer: Layer, snapshots: Map<string, Surface>): SerializedLayer {
    return {
      id: layer.id,
      kind: layer.kind,
      properties: layer.properties(),
      filters: layer.filters.map((filter) => filter.serialize()),
      width: layer instanceof ImageLayer ? layer.width : 0,
      height: layer instanceof ImageLayer ? layer.height : 0,
      channels: layer instanceof ImageLayer ? layer.channels : 4,
      snapshotId: layer instanceof ImageLayer ? this.capturePixels(layer, snapshots) : null,
      children: layer instanceof GroupLayer ? layer.children.map((child) => this.serializeLayer(child, snapshots)) : [],
    };
  }

  private restoreLayer(data: SerializedLayer, snapshots: Map<string, Surface>, duplicates?: ReadonlyMap<string, string>): Layer {
    const id = duplicates?.get(data.id) ?? data.id;
    let layer: Layer;
    if (data.kind === 'image') {
      const surface = createSurface(this.gpu.device, `${data.properties.name}: source`, { x: 0, y: 0, width: data.width, height: data.height }, 1, data.channels === 1 ? MASK_FORMAT : WORKING_FORMAT);
      layer = new ImageLayer(data.properties.name, surface, id);
      const snapshot = snapshots.get(data.snapshotId!);
      if (!snapshot) { surface.texture.destroy(); throw new Error('Missing layer pixel snapshot.'); }
      (layer as ImageLayer).restorePixels(this.gpu, snapshot);
    } else if (data.kind === 'group') layer = new GroupLayer(data.properties.name, id);
    else throw new Error(`Unsupported layer kind: ${data.kind}`);
    try {
      layer.setProperties(data.properties);
      if (duplicates) layer.setSelection(false);
      for (const serialized of data.filters) {
        const filter = this.filters.deserialize(duplicates ? { ...serialized, id: crypto.randomUUID() } : serialized);
        if (duplicates) filter.remapDependencies(duplicates);
        layer.addFilter(filter);
      }
      if (layer instanceof GroupLayer) for (const child of data.children) layer.add(this.restoreLayer(child, snapshots, duplicates));
      return layer;
    } catch (error) { this.compositor.release(layer); throw error; }
  }

  add(layer: Layer, parent = this.destination(), index = parent.children.length, selectAdded = true): void {
    const snapshots = new Map<string, Surface>();
    try {
      const serialized = this.serializeLayer(layer, snapshots);
      const previousSelection = this.selected.id;
      parent.add(layer, index);
      if (selectAdded) this.selected = layer;
      this.history.push(new UndoOperation(
        `Add ${layer instanceof GroupLayer ? 'group' : 'layer'}`,
        { type: 'image', targetId: this.id, action: 'remove-layer', data: { layerId: layer.id, selection: previousSelection } },
        { type: 'image', targetId: this.id, action: 'add-layer', data: { parentId: parent.id, index, layer: serialized, selection: this.selected.id } },
        snapshots,
      ));
    } catch (error) { for (const snapshot of snapshots.values()) snapshot.texture.destroy(); throw error; }
  }

  deleteSelected(layer = this.selected): void {
    const parent = layer.parent;
    if (!parent) return;
    const snapshots = new Map<string, Surface>();
    const index = parent.children.indexOf(layer);
    let serialized: SerializedLayer;
    try { serialized = this.serializeLayer(layer, snapshots); }
    catch (error) { for (const snapshot of snapshots.values()) snapshot.texture.destroy(); throw error; }
    let nextSelection = this.selected;
    for (let item: Layer | null = this.selected; item; item = item.parent) {
      if (item === layer) { nextSelection = parent; break; }
    }
    const previousSelection = this.selected.id;
    parent.remove(layer);
    this.compositor.release(layer);
    this.selected = nextSelection;
    this.history.push(new UndoOperation(
      'Delete layer',
      { type: 'image', targetId: this.id, action: 'add-layer', data: { parentId: parent.id, index, layer: serialized, selection: previousSelection } },
      { type: 'image', targetId: this.id, action: 'remove-layer', data: { layerId: layer.id, selection: nextSelection.id } },
      snapshots,
    ));
  }

  duplicateSelected(): void {
    if (!this.selected.parent) return;
    const original = this.selected;
    const parent = original.parent!;
    const snapshots = new Map<string, Surface>();
    let duplicate: Layer | undefined;
    try {
      const serialized = this.serializeLayer(original, snapshots);
      const ids = new Map<string, string>();
      const allocate = (data: SerializedLayer) => { ids.set(data.id, crypto.randomUUID()); data.children.forEach(allocate); };
      allocate(serialized);
      duplicate = this.restoreLayer(serialized, snapshots, ids);
      duplicate.name = `${original.name} copy`;
      this.add(duplicate, parent, parent.children.indexOf(original) + 1);
    } catch (error) { if (duplicate && !duplicate.parent) this.compositor.release(duplicate); throw error; }
    finally { for (const snapshot of snapshots.values()) snapshot.texture.destroy(); }
  }

  move(layer: Layer, parent: GroupLayer, insertionIndex: number): void {
    const oldParent = layer.parent;
    if (!oldParent) return;
    for (let ancestor: Layer | null = parent; ancestor; ancestor = ancestor.parent) if (ancestor === layer) return;
    const oldIndex = oldParent.children.indexOf(layer);
    const index = Math.max(0, Math.min(insertionIndex, parent.children.length)) - Number(oldParent === parent && oldIndex < insertionIndex);
    if (oldParent === parent && index === oldIndex) return;
    const before = { layerId: layer.id, parentId: oldParent.id, index: oldIndex, transform: [...layer.transform] };
    const matrix = multiply(inverse(parent.worldTransform()), layer.worldTransform());
    parent.add(layer, index);
    layer.setTransform(matrix);
    this.selected = layer;
    this.history.push(new UndoOperation(
      oldParent === parent ? 'Reorder layer' : 'Regroup layer',
      { type: 'image', targetId: this.id, action: 'move-layer', data: before },
      { type: 'image', targetId: this.id, action: 'move-layer', data: { layerId: layer.id, parentId: parent.id, index, transform: [...matrix] } },
    ));
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'image' || payload.targetId !== this.id) throw new Error('Undo operation belongs to a different image.');
    const data = payload.data;
    if (payload.action === 'add-layer') {
      const parent = this.find(String(data.parentId));
      if (!(parent instanceof GroupLayer)) throw new Error('Layer parent must be a group.');
      parent.add(this.restoreLayer(data.layer as SerializedLayer, operation.snapshots), Number(data.index));
      this.selected = this.find(String(data.selection));
    } else if (payload.action === 'remove-layer') {
      const layer = this.find(String(data.layerId));
      if (!layer.parent) throw new Error('Cannot remove the root group.');
      layer.parent.remove(layer);
      this.compositor.release(layer);
      this.selected = this.find(String(data.selection));
    } else if (payload.action === 'move-layer') {
      const layer = this.find(String(data.layerId));
      const parent = this.find(String(data.parentId));
      if (!(parent instanceof GroupLayer)) throw new Error('Layer parent must be a group.');
      parent.add(layer, Number(data.index));
      layer.setTransform(data.transform as unknown as Matrix);
      this.selected = layer;
    } else throw new Error(`Unsupported image undo action: ${payload.action}`);
  }
}