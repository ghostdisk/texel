import type { Gpu } from '../gpu/device';
import type { Compositor } from '../gpu/compositor';
import { createImageLayer } from '../gpu/images';
import { createSurface, rasterBounds, MASK_FORMAT, WORKING_FORMAT, MAX_IMAGE_SIZE } from '../gpu/surface';
import type { LayerReframer } from '../gpu/reframe';
import type { MaskRenderer } from '../gpu/mask';
import type { Surface } from '../gpu/surface';
import type { FilterRegistry, SerializedFilter } from '../filters/filter';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection, UndoStack, UndoTarget } from '../history/undo';
import { GroupLayer, ImageLayer, Layer } from './layers';
import type { LayerProperties } from './layers';
import { IDENTITY, inverse, multiply, transformBounds, unionBounds } from './geometry';
import type { Matrix, Rect } from './geometry';
import { LayerCommands } from './layer-commands';
import { TextLayer, validateText } from './text-layer';
import type { TextProperties } from './text-layer';
import { DEFAULT_GRID_SIZE, validatePrecision } from './precision';
import type { Guide, PrecisionState } from './precision';

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
  text: TextProperties | null;
}

export interface CanvasLayerState {
  layerId: string;
  transform: Matrix;
}

export class ImageDocument implements UndoTarget {
  id: string = crypto.randomUUID();
  root = new GroupLayer('Document');
  private activeLayer: Layer = this.root;
  private selectedIds = new Set<string>([this.root.id]);
  private selectionAnchor = this.root.id;
  readonly commands: LayerCommands;
  private inactiveSelection: {
    layer: ImageLayer;
    revision: number;
  } | null = null;
  private canvasWidth = 1000;
  private canvasHeight = 750;
  private gridSpacing = DEFAULT_GRID_SIZE;
  private documentGuides: Guide[] = [];
  private readonly reframer: LayerReframer;
  onChange?: () => void;
  onInvalidated?: () => void;

  constructor(
    readonly gpu: Gpu,
    private readonly compositor: Compositor,
    readonly filters: FilterRegistry, reframer: LayerReframer, masks: MaskRenderer,
    private readonly history: UndoStack,
    private readonly flush: () => void,
  ) {
    this.root.onInvalidated = () => this.onInvalidated?.();
    this.reframer = reframer;
    this.commands = new LayerCommands(this, gpu, compositor, history, masks, reframer);
  }

  /** Canonical pixel dimensions used for presentation and export. */
  get width(): number { return this.canvasWidth; }
  get height(): number { return this.canvasHeight; }
  get frame(): Rect { return { x: 0, y: 0, width: this.width, height: this.height }; }
  get gridSize(): number { return this.gridSpacing; }
  get guides(): readonly Guide[] { return this.documentGuides; }

  precisionState(): PrecisionState { return { gridSize: this.gridSpacing, guides: this.documentGuides.map((guide) => ({ ...guide })) }; }

  setPrecisionState(state: PrecisionState): void {
    const precision = validatePrecision(state);
    this.gridSpacing = precision.gridSize;
    this.documentGuides = precision.guides;
    this.onChange?.();
  }

  setCanvasState(width: number, height: number, layers: readonly CanvasLayerState[], selection: JsonObject): void {
    const limit = MAX_IMAGE_SIZE;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > limit || height > limit) {
      throw new Error(`Canvas dimensions must be whole pixels from 1 to ${limit}.`);
    }
    const children = new Map(this.root.children.map((layer) => [layer.id, layer]));
    if (layers.length !== children.size || new Set(layers.map((entry) => entry.layerId)).size !== children.size || layers.some((entry) => !children.has(entry.layerId))) {
      throw new Error('Crop layer state does not match the document.');
    }
    this.canvasWidth = width;
    this.canvasHeight = height;
    for (const entry of layers) children.get(entry.layerId)!.setTransform(entry.transform);
    this.restoreSelection(selection);
    this.root.invalidate();
  }

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

  get selectionLayer(): ImageLayer | null {
    return this.allLayers().find((layer): layer is ImageLayer => layer instanceof ImageLayer && layer.isSelection) ?? null;
  }

  get selectionMask(): ImageLayer | null {
    const layer = this.selectionLayer;
    return layer && this.inactiveSelection?.layer === layer && this.inactiveSelection.revision === layer.revision ? null : layer;
  }

  deactivateEmptySelection(layer: ImageLayer): void {
    // Keep the temporary buffer so undoing the edit restores selection without a second history entry.
    this.inactiveSelection = { layer, revision: layer.revision };
  }

  createPixelLayer(width = this.width, height = this.height): void {
    const parent = this.destination();
    const layer = createImageLayer(this.gpu, 'Pixel layer', width, height);
    try {
      layer.setTransform(multiply(inverse(parent.worldTransform()), [1, 0, 0, 1, (this.width - width) / 2, (this.height - height) / 2]));
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
    const existing = this.selectionLayer;
    this.inactiveSelection = null;
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
      if (layer.source !== source) source.destroy();
      for (const snapshot of snapshots.values()) snapshot.destroy();
      throw error;
    }
  }

  get selected(): Layer { return this.activeLayer; }
  set selected(layer: Layer) { this.setSelected([layer], layer); }
  get selectedLayers(): Layer[] { return this.allLayers().filter((layer) => this.selectedIds.has(layer.id)); }
  isSelected(layer: Layer): boolean { return this.selectedIds.has(layer.id); }

  /** Selected descendants move with their selected ancestor, exactly once. */
  get selectedRoots(): Layer[] {
    return this.selectedLayers.filter((layer) => {
      if (!layer.parent) return false;
      for (let parent: GroupLayer | null = layer.parent; parent; parent = parent.parent) if (this.isSelected(parent)) return false;
      return true;
    });
  }

  setSelected(layers: readonly Layer[], active = layers[layers.length - 1] ?? this.root): void {
    const existing = new Set(this.allLayers());
    const unique = [...new Set(layers)].filter((layer) => existing.has(layer));
    const chosen = unique.length > 1 ? unique.filter((layer) => layer !== this.root && !layer.isSelection) : unique;
    if (!chosen.length) chosen.push(this.root);
    this.activeLayer = chosen.includes(active) ? active : chosen[chosen.length - 1];
    this.selectedIds = new Set(chosen.map((layer) => layer.id));
    this.selectionAnchor = this.activeLayer.id;
  }

  select(layer: Layer, mode: 'replace' | 'toggle' | 'range' = 'replace', order = this.allLayers()): void {
    const anchor = this.selectionAnchor;
    if (mode === 'range' && layer.parent && !layer.isSelection) {
      const start = order.findIndex((item) => item.id === anchor);
      const end = order.indexOf(layer);
      this.setSelected(start < 0 || end < 0 ? [layer] : order.slice(Math.min(start, end), Math.max(start, end) + 1), layer);
      this.selectionAnchor = anchor;
    } else if (mode === 'toggle' && layer.parent && !layer.isSelection) {
      const chosen = this.selectedLayers.filter((item) => item.parent && !item.isSelection);
      if (this.isSelected(layer)) this.setSelected(chosen.filter((item) => item !== layer), this.selected === layer ? undefined : this.selected);
      else this.setSelected([...chosen, layer], layer);
    } else this.selected = layer;
    this.onChange?.();
  }

  selectionState(): JsonObject { return { ids: this.selectedLayers.map((layer) => layer.id), active: this.selected.id }; }

  restoreSelection(state: JsonObject): void {
    const layers = this.allLayers();
    const ids = state.ids as string[];
    this.setSelected(layers.filter((layer) => ids.includes(layer.id)), layers.find((layer) => layer.id === state.active));
  }
  destination(): GroupLayer { return this.selected instanceof GroupLayer ? this.selected : this.selected.parent ?? this.root; }

  reset(width: number, height: number): void {
    const initial = createImageLayer(this.gpu, 'Pixel layer', width, height);
    const root = new GroupLayer('Document');
    root.add(initial);
    this.replace(root, width, height, { ids: [initial.id], active: initial.id }, null);
  }

  /** Adopt a fully decoded tree only after loading and validation have succeeded. */
  replace(
    root: GroupLayer, width: number, height: number, selection: JsonObject, activeSelectionId: string | null,
    precision: PrecisionState = { gridSize: DEFAULT_GRID_SIZE, guides: [] },
  ): void {
    if (root.parent) throw new Error('The document root cannot have a parent.');
    const validatedPrecision = validatePrecision(precision);
    this.flush();
    const previous = this.root;
    previous.onInvalidated = undefined;
    this.root = root;
    this.id = crypto.randomUUID();
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.gridSpacing = validatedPrecision.gridSize;
    this.documentGuides = validatedPrecision.guides;
    this.inactiveSelection = null;
    root.onInvalidated = () => this.onInvalidated?.();
    this.restoreSelection(selection);
    const mask = this.selectionLayer;
    if (mask && mask.id !== activeSelectionId) this.deactivateEmptySelection(mask);
    this.history.clear();
    this.compositor.release(previous);
    this.onChange?.();
  }

  capturePixels(layer: ImageLayer, snapshots: Map<string, Surface>): string {
    this.flush();
    return this.captureSurface(layer.source, snapshots);
  }

  captureSurface(source: Surface, snapshots: Map<string, Surface>): string {
    const id = crypto.randomUUID();
    snapshots.set(id, source.snapshot('Undo snapshot'));
    return id;
  }

  async reframe(layer: ImageLayer, mode: ReframeMode): Promise<void> {
    if (!layer.pixelEditable) throw new Error('Text layers cannot be reframed as pixels.');
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
      replacement.destroy();
      for (const snapshot of snapshots.values()) snapshot.destroy();
      throw error;
    }
    layer.replaceSource(replacement);
    layer.setTransform(transform);
    this.selected = layer;
    this.history.push(operation);
  }

  serializeLayer(layer: Layer, snapshots: Map<string, Surface>): SerializedLayer {
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
      text: layer instanceof TextLayer ? layer.textProperties : null,
    };
  }

  restoreLayer(data: SerializedLayer, snapshots: Map<string, Surface>, duplicates?: ReadonlyMap<string, string>): Layer {
    const id = duplicates?.get(data.id) ?? data.id;
    let layer: Layer;
    if (data.kind === 'image' || data.kind === 'text') {
      const text = data.kind === 'text' ? validateText(data.text) : null;
      const surface = createSurface(`${data.properties.name}: source`, { x: 0, y: 0, width: data.width, height: data.height }, 1, data.channels === 1 ? MASK_FORMAT : WORKING_FORMAT);
      layer = text ? new TextLayer(data.properties.name, surface, text, id) : new ImageLayer(data.properties.name, surface, id);
      const snapshot = snapshots.get(data.snapshotId!);
      if (!snapshot) { surface.destroy(); throw new Error('Missing layer pixel snapshot.'); }
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

  add(layer: Layer, parent = this.destination(), index = parent.children.length, selectAdded = true, label = layer instanceof GroupLayer ? 'Add group' : 'Add layer'): void {
    const snapshots = new Map<string, Surface>();
    try {
      const serialized = this.serializeLayer(layer, snapshots);
      const previousSelection = this.selectionState();
      parent.add(layer, index);
      if (selectAdded) this.selected = layer;
      this.history.push(new UndoOperation(
        label,
        { type: 'image', targetId: this.id, action: 'remove-layer', data: { layerId: layer.id, selection: previousSelection } },
        { type: 'image', targetId: this.id, action: 'add-layer', data: { parentId: parent.id, index, layer: serialized, selection: this.selectionState() } },
        snapshots,
      ));
    } catch (error) { for (const snapshot of snapshots.values()) snapshot.destroy(); throw error; }
  }

  deleteSelected(layer?: Layer): void { this.commands.delete(layer ? [layer] : this.selectedRoots); }
  duplicateSelected(): Promise<void> { return this.commands.duplicate(); }
  groupSelected(): void { this.commands.group(); }
  mergeSelected(): void { this.commands.merge(); }

  move(layer: Layer, parent: GroupLayer, insertionIndex: number): void {
    this.commands.move(this.isSelected(layer) && !layer.isSelection ? this.selectedRoots : [layer], parent, insertionIndex);
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'image' || payload.targetId !== this.id) throw new Error('Undo operation belongs to a different image.');
    const data = payload.data;
    if (payload.action === 'layer-properties') {
      const entries = data.layers as {
        layerId: string;
        properties: LayerProperties;
      }[];
      for (const entry of entries) this.find(entry.layerId).setProperties(entry.properties);
      this.restoreSelection(data.selection as JsonObject);
    } else if (payload.action === 'precision') {
      this.setPrecisionState(data as unknown as PrecisionState);
    } else if (payload.action === 'layer-batch') {
      this.commands.apply(operation, direction);
    } else if (payload.action === 'add-layer') {
      const parent = this.find(String(data.parentId));
      if (!(parent instanceof GroupLayer)) throw new Error('Layer parent must be a group.');
      parent.add(this.restoreLayer(data.layer as SerializedLayer, operation.snapshots), Number(data.index));
      if (typeof data.selection === 'string') this.selected = this.find(data.selection);
      else this.restoreSelection(data.selection as JsonObject);
    } else if (payload.action === 'remove-layer') {
      const layer = this.find(String(data.layerId));
      if (!layer.parent) throw new Error('Cannot remove the root group.');
      layer.parent.remove(layer);
      this.compositor.release(layer);
      if (typeof data.selection === 'string') this.selected = this.find(data.selection);
      else this.restoreSelection(data.selection as JsonObject);
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
