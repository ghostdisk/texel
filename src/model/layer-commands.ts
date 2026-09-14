import type { Filter } from '../filters/filter';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection, UndoStack } from '../history/undo';
import type { Gpu } from '../gpu/device';
import type { Compositor } from '../gpu/compositor';
import type { MaskRenderer } from '../gpu/mask';
import type { LayerReframer } from '../gpu/reframe';
import { createSurface } from '../gpu/surface';
import type { Surface } from '../gpu/surface';
import { GroupLayer, ImageLayer, Layer, validateLayerDependencies } from './layers';
import { inverse, multiply } from './geometry';
import type { Matrix } from './geometry';
import type { ImageDocument, SerializedLayer } from './image-document';

type LayerStep =
  | {
    action: 'add';
    parentId: string;
    index: number;
    layer: SerializedLayer;
  }
  | {
    action: 'remove';
    layerId: string;
  }
  | {
    action: 'move';
    layerId: string;
    parentId: string;
    index: number;
    transform: number[];
  }
  | {
    action: 'pixels';
    layerId: string;
    snapshotId: string;
  };

/** Layer tree and pixel edits are committed together; snapshots preserve recreated and restored surfaces. */
export class LayerCommands {
  private readonly masks: MaskRenderer;
  private readonly reframer: LayerReframer;

  constructor(
    private readonly image: ImageDocument, private readonly gpu: Gpu, private readonly compositor: Compositor,
    private readonly history: UndoStack, masks: MaskRenderer, reframer: LayerReframer,
  ) {
    this.masks = masks;
    this.reframer = reframer;
  }

  private state(layers: readonly Layer[], active = layers[layers.length - 1]): JsonObject {
    return { ids: layers.map((layer) => layer.id), active: active?.id ?? this.image.root.id };
  }

  private position(layer: Layer): Extract<LayerStep, { action: 'move' }> {
    return { action: 'move', layerId: layer.id, parentId: layer.parent!.id, index: layer.parent!.children.indexOf(layer), transform: [...layer.transform] };
  }

  private commonParent(layers: readonly Layer[]): GroupLayer {
    let parent = layers[0].parent!;
    const within = (layer: Layer, group: GroupLayer): boolean => {
      for (let item = layer.parent; item; item = item.parent) if (item === group) return true;
      return false;
    };
    while (!layers.every((layer) => within(layer, parent))) parent = parent.parent!;
    return parent;
  }

  private insertion(layers: readonly Layer[], parent: GroupLayer): number {
    const indices = layers.map((layer) => {
      let branch = layer;
      while (branch.parent !== parent) branch = branch.parent!;
      return parent.children.indexOf(branch);
    });
    const above = Math.max(...indices) + 1;
    return above - layers.filter((layer) => layer.parent === parent && parent.children.indexOf(layer) < above).length;
  }

  private commit(label: string, undo: LayerStep[], redo: LayerStep[], after: JsonObject, snapshots = new Map<string, Surface>()): void {
    const operation = new UndoOperation(
      label,
      { type: 'image', targetId: this.image.id, action: 'layer-batch', data: { steps: undo, selection: this.image.selectionState() } },
      { type: 'image', targetId: this.image.id, action: 'layer-batch', data: { steps: redo, selection: after } },
      snapshots,
    );
    try { this.apply(operation, 'redo'); }
    catch (error) { operation.dispose(); throw error; }
    this.history.push(operation);
  }

  apply(operation: UndoOperation, direction: UndoDirection): void {
    this.compositor.flush();
    const data = operation.payload(direction).data;
    const steps = data.steps as LayerStep[];
    const original = this.image.allLayers();
    const lookup = new Map(original.map((layer) => [layer.id, layer]));
    const before = original.map((layer) => ({ layer, parent: layer.parent, transform: layer.transform }));
    const created: Layer[] = [];
    const removed: Layer[] = [];
    const get = (id: string): Layer => {
      const layer = lookup.get(id);
      if (!layer) throw new Error('Unknown layer in edit: ' + id);
      return layer;
    };
    const pixelSteps = steps.filter((step) => step.action === 'pixels').map((step) => {
      const layer = get(step.layerId);
      if (!(layer instanceof ImageLayer)) throw new Error('Pixel restoration requires an image layer.');
      return [layer, operation.snapshot(step.snapshotId)] as const;
    });
    try {
      // Detach the entire moving set first so insertion indices refer to the final remaining siblings.
      for (const step of steps) if (step.action === 'move' || step.action === 'remove') {
        const layer = get(step.layerId);
        if (!layer.parent) throw new Error('Cannot move or remove the document.');
        layer.parent.remove(layer);
        if (step.action === 'remove') removed.push(layer);
      }
      for (const step of steps) {
        if (step.action === 'remove' || step.action === 'pixels') continue;
        const parent = get(step.parentId);
        if (!(parent instanceof GroupLayer)) throw new Error('Layer parent must be a group.');
        let layer: Layer;
        if (step.action === 'add') {
          layer = this.image.restoreLayer(step.layer, operation.snapshots);
          created.push(layer);
          const visit = (item: Layer) => { lookup.set(item.id, item); if (item instanceof GroupLayer) item.children.forEach(visit); };
          visit(layer);
        } else {
          layer = get(step.layerId);
          layer.setTransform(step.transform as unknown as Matrix);
        }
        parent.add(layer, step.index);
      }
      validateLayerDependencies(this.image.root);
      for (const [layer, snapshot] of pixelSteps) layer.restorePixels(this.gpu, snapshot);
    } catch (error) {
      // Restore the original tree before releasing anything if regrouping introduced a mask cycle.
      for (const layer of [...original, ...created]) layer.parent?.remove(layer);
      for (const saved of before) {
        saved.layer.setTransform(saved.transform);
        saved.parent?.add(saved.layer);
      }
      for (const layer of created) this.compositor.release(layer);
      throw error;
    }
    for (const layer of removed) this.compositor.release(layer);
    this.image.restoreSelection(data.selection as JsonObject);
  }

  delete(layers: readonly Layer[]): void {
    const roots = layers.filter((layer) => !!layer.parent);
    if (!roots.length) return;
    const snapshots = new Map<string, Surface>();
    const undo: LayerStep[] = [];
    try {
      for (const layer of roots) undo.push({
        action: 'add', parentId: layer.parent!.id, index: layer.parent!.children.indexOf(layer), layer: this.image.serializeLayer(layer, snapshots),
      });
    } catch (error) { for (const surface of snapshots.values()) surface.destroy(); throw error; }
    const parent = this.commonParent(roots);
    const removed = new Set<Layer>();
    const visit = (layer: Layer) => { removed.add(layer); if (layer instanceof GroupLayer) layer.children.forEach(visit); };
    roots.forEach(visit);
    const remaining = this.image.selectedLayers.filter((layer) => !removed.has(layer));
    this.commit(roots.length > 1 ? 'Delete layers' : 'Delete layer', undo, roots.map((layer) => ({ action: 'remove', layerId: layer.id })),
      this.state(remaining.length ? remaining : [parent], remaining.includes(this.image.selected) ? this.image.selected : undefined), snapshots);
  }

  group(): void {
    const layers = this.image.selectedRoots;
    if (!layers.length) return;
    const parent = this.commonParent(layers);
    const group = new GroupLayer('Group');
    const snapshots = new Map<string, Surface>();
    const inverseParent = inverse(parent.worldTransform());
    const moves: LayerStep[] = layers.map((layer, index) => ({
      action: 'move', layerId: layer.id, parentId: group.id, index, transform: [...multiply(inverseParent, layer.worldTransform())],
    }));
    this.commit('Group layers', [...layers.map((layer) => this.position(layer)), { action: 'remove', layerId: group.id }], [
      { action: 'add', parentId: parent.id, index: this.insertion(layers, parent), layer: this.image.serializeLayer(group, snapshots) }, ...moves,
    ], this.state([group]), snapshots);
  }

  move(layers: readonly Layer[], parent: GroupLayer, insertionIndex: number): void {
    if (!layers.length) return;
    for (const layer of layers) for (let ancestor: Layer | null = parent; ancestor; ancestor = ancestor.parent) if (ancestor === layer) return;
    const index = Math.max(0, Math.min(insertionIndex, parent.children.length)) -
      layers.filter((layer) => layer.parent === parent && parent.children.indexOf(layer) < insertionIndex).length;
    const before = layers.map((layer) => this.position(layer));
    const inverseParent = inverse(parent.worldTransform());
    const after: LayerStep[] = layers.map((layer, offset) => ({
      action: 'move', layerId: layer.id, parentId: parent.id, index: index + offset, transform: [...multiply(inverseParent, layer.worldTransform())],
    }));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.commit('Move layers', before, after, this.state(layers, this.image.selected));
  }

  canStep(offset: number): boolean {
    const layers = this.image.selectedRoots;
    const parent = layers[0]?.parent;
    if (!parent || !layers.every((layer) => layer.parent === parent)) return false;
    const indices = layers.map((layer) => parent.children.indexOf(layer));
    return offset > 0 ? Math.max(...indices) < parent.children.length - 1 : Math.min(...indices) > 0;
  }

  step(offset: number): void {
    if (!this.canStep(offset)) return;
    const layers = this.image.selectedRoots;
    const parent = layers[0].parent!;
    const indices = layers.map((layer) => parent.children.indexOf(layer));
    this.move(layers, parent, offset > 0 ? Math.max(...indices) + 2 : Math.min(...indices) - 1);
  }

  async duplicate(): Promise<void> {
    const layers = this.image.selectedRoots;
    if (!layers.length) return;
    const originals = new Map<string, Surface>();
    const snapshots = new Map<string, Surface>();
    const copies: Layer[] = [];
    const redo: LayerStep[] = [];
    try {
      const serialized = layers.map((layer) => this.image.serializeLayer(layer, originals));
      const ids = new Map<string, string>();
      const allocate = (data: SerializedLayer) => { ids.set(data.id, crypto.randomUUID()); data.children.forEach(allocate); };
      serialized.forEach(allocate);
      const offsets = new Map<GroupLayer, number>();
      for (let i = 0; i < layers.length; i++) {
        const original = layers[i];
        const copy = this.image.restoreLayer(serialized[i], originals, ids);
        copies.push(copy);
        copy.name = original.name + ' copy';
        const parent = original.parent!;
        const offset = offsets.get(parent) ?? 0;
        redo.push({ action: 'add', parentId: parent.id, index: parent.children.indexOf(original) + 1 + offset, layer: this.image.serializeLayer(copy, snapshots) });
        offsets.set(parent, offset + 1);
      }
    } catch (error) { for (const surface of snapshots.values()) surface.destroy(); throw error; }
    finally {
      for (const surface of originals.values()) surface.destroy();
      for (const copy of copies) this.compositor.release(copy);
    }
    this.commit(layers.length > 1 ? 'Duplicate layers' : 'Duplicate layer',
      copies.map((copy) => ({ action: 'remove', layerId: copy.id })), redo, this.state(copies), snapshots);
  }

  paste(serialized: readonly SerializedLayer[], sourceSnapshots: Map<string, Surface>, worldTransforms: readonly Matrix[]): void {
    if (!serialized.length || serialized.length !== worldTransforms.length) return;
    const parent = this.image.destination();
    const ids = new Map<string, string>();
    const allocate = (data: SerializedLayer) => { ids.set(data.id, crypto.randomUUID()); data.children.forEach(allocate); };
    serialized.forEach(allocate);
    const copies: Layer[] = [];
    const snapshots = new Map<string, Surface>();
    const redo: LayerStep[] = [];
    try {
      for (let index = 0; index < serialized.length; index++) {
        const copy = this.image.restoreLayer(serialized[index], sourceSnapshots, ids);
        copies.push(copy);
        copy.setTransform(multiply(inverse(parent.worldTransform()), worldTransforms[index]));
        redo.push({
          action: 'add', parentId: parent.id, index: parent.children.length + index,
          layer: this.image.serializeLayer(copy, snapshots),
        });
      }
    } catch (error) {
      for (const snapshot of snapshots.values()) snapshot.destroy();
      throw error;
    } finally { for (const copy of copies) this.compositor.release(copy); }
    this.commit(copies.length > 1 ? 'Paste layers' : 'Paste layer',
      copies.map((copy) => ({ action: 'remove', layerId: copy.id })), redo, this.state(copies), snapshots);
  }

  private deselectionSteps(snapshots: Map<string, Surface>): {
    undo: LayerStep[];
    redo: LayerStep[];
  } {
    const selection = this.image.selectionLayer;
    if (!selection?.parent) return { undo: [], redo: [] };
    return {
      undo: [{
        action: 'add', parentId: selection.parent.id, index: selection.parent.children.indexOf(selection),
        layer: this.image.serializeLayer(selection, snapshots),
      }],
      redo: [{ action: 'remove', layerId: selection.id }],
    };
  }

  cutPixels(layer: ImageLayer): void {
    const selection = this.image.selectionMask;
    if (!selection || !layer.parent || !layer.pixelEditable || layer.channels !== 4) return;
    this.compositor.flush();
    const mask = this.compositor.resolve(selection, 1);
    const remaining = createSurface('Cut pixels remainder', layer.source.bounds, layer.source.scale);
    const snapshots = new Map<string, Surface>();
    const frame = this.gpu.beginFrame();
    let before: string;
    let after: string;
    let deselection: ReturnType<LayerCommands['deselectionSteps']>;
    try {
      this.masks.encode(frame, layer.source, remaining, {
        surface: mask, transform: multiply(inverse(selection.worldTransform()), layer.worldTransform()),
      }, true);
      frame.submit();
      before = this.image.capturePixels(layer, snapshots);
      after = this.image.captureSurface(remaining, snapshots);
      deselection = this.deselectionSteps(snapshots);
    } catch (error) { for (const snapshot of snapshots.values()) snapshot.destroy(); throw error; }
    finally { frame.release(); remaining.destroy(); }
    this.commit('Cut pixels',
      [{ action: 'pixels', layerId: layer.id, snapshotId: before }, ...deselection.undo],
      [{ action: 'pixels', layerId: layer.id, snapshotId: after }, ...deselection.redo],
      this.state([layer]), snapshots,
    );
  }

  /** Snapshot the imported pixels; the caller retains ownership of the temporary layer. */
  pastePixels(layer: ImageLayer, parent = this.image.destination()): void {
    const snapshots = new Map<string, Surface>();
    const index = parent.children.length - Number(this.image.selectionLayer?.parent === parent);
    let serialized: SerializedLayer;
    let deselection: ReturnType<LayerCommands['deselectionSteps']>;
    try {
      serialized = this.image.serializeLayer(layer, snapshots);
      deselection = this.deselectionSteps(snapshots);
    } catch (error) { for (const snapshot of snapshots.values()) snapshot.destroy(); throw error; }
    this.commit('Paste pixels',
      [{ action: 'remove', layerId: layer.id }, ...deselection.undo],
      [...deselection.redo, { action: 'add', parentId: parent.id, index, layer: serialized }],
      this.state([layer]), snapshots,
    );
  }

  async layerViaSelection(layer: ImageLayer, selection: ImageLayer, cut: boolean, reportEmpty = true): Promise<ImageLayer | null> {
    if (cut && !layer.pixelEditable) throw new Error('Text layers cannot be cut as pixels. Use Layer via Copy to create a pixel layer.');
    const layers = this.image.allLayers();
    if (layer.isSelection || layer.channels !== 4 || !layer.parent || !layers.includes(layer) ||
      selection !== this.image.selectionMask || !selection.isSelection || !layers.includes(selection)) {
      throw new Error('Layer via Copy or Cut requires an image layer and an active selection.');
    }
    this.compositor.flush();
    const documentId = this.image.id;
    const source = layer.source;
    const revision = layer.revision;
    const world = layer.worldTransform();
    const parent = layer.parent;
    const index = parent.children.indexOf(layer);
    const selectionRevision = selection.revision;
    const maskWorld = selection.worldTransform();
    const mask = this.compositor.resolve(selection, 1);
    const masked = createSurface(cut ? 'Layer via cut' : 'Layer via copy', source.bounds, source.scale);
    const remaining = cut ? createSurface('Layer via cut remainder', source.bounds, source.scale) : null;
    const frame = this.gpu.beginFrame();
    let copy: ImageLayer | null = null;
    try {
      const input = { surface: mask, transform: multiply(inverse(maskWorld), world) };
      this.masks.encode(frame, source, masked, input);
      if (remaining) this.masks.encode(frame, source, remaining, input, true);
      frame.submit();
      const bounds = await this.reframer.contentBounds(masked);
      if (this.image.id !== documentId || !parent || layer.parent !== parent || parent.children.indexOf(layer) !== index ||
        layer.source !== source || layer.revision !== revision || this.image.selectionMask !== selection || selection.revision !== selectionRevision ||
        layer.worldTransform().some((value, index) => value !== world[index]) || selection.worldTransform().some((value, index) => value !== maskWorld[index])) {
        throw new Error(`The layer or selection changed while ${cut ? 'cutting' : 'copying'} pixels. Retry the command.`);
      }
      if (!bounds) {
        if (reportEmpty) throw new Error('Selection is empty.');
        return null;
      }
      copy = new ImageLayer(layer.name + ' copy', this.reframer.resize(masked, bounds));
      copy.setProperties(layer.properties());
      copy.name = layer.name + (cut ? ' cut' : ' copy');
      copy.setTransform(multiply(layer.transform, [1, 0, 0, 1, bounds.x, bounds.y]));
      for (const filter of layer.filters) copy.addFilter(this.image.filters.deserialize({ ...filter.serialize(), id: crypto.randomUUID() }));
      const snapshots = new Map<string, Surface>();
      let serialized: SerializedLayer;
      let before = '';
      let after = '';
      try {
        serialized = this.image.serializeLayer(copy, snapshots);
        if (remaining) {
          before = this.image.capturePixels(layer, snapshots);
          after = this.image.captureSurface(remaining, snapshots);
        }
      } catch (error) { for (const snapshot of snapshots.values()) snapshot.destroy(); throw error; }
      const copyId = copy.id;
      this.compositor.release(copy);
      copy = null;
      const undo: LayerStep[] = [{ action: 'remove', layerId: copyId }];
      const redo: LayerStep[] = [{ action: 'add', parentId: parent.id, index: index + 1, layer: serialized }];
      if (cut) {
        undo.push({ action: 'pixels', layerId: layer.id, snapshotId: before });
        redo.push({ action: 'pixels', layerId: layer.id, snapshotId: after });
      }
      const label = cut ? 'Layer via Cut' : 'Layer via Copy';
      this.commit(label, undo, redo, { ids: [copyId], active: copyId }, snapshots);
      return this.image.find(copyId) as ImageLayer;
    } catch (error) { if (copy && !copy.parent) this.compositor.release(copy); throw error; }
    finally { frame.release(); masked.destroy(); remaining?.destroy(); }
  }

  get mergeTargets(): Layer[] {
    let layers = this.image.selectedRoots;
    if (layers.length === 1 && !(layers[0] instanceof GroupLayer)) {
      const layer = layers[0];
      const below = layer.parent!.children.slice(0, layer.parent!.children.indexOf(layer)).reverse().find((item) => item.visibleInStack);
      layers = below ? [below, layer] : [];
    }
    return layers.every((layer) => layer.visibleInStack && !(layer instanceof ImageLayer && layer.channels === 1)) ? layers : [];
  }

  merge(): void {
    const layers = this.mergeTargets;
    if (!layers.length) return;
    const parent = this.commonParent(layers);
    const top = layers[layers.length - 1];
    const capture = this.compositor.captureLayers(layers, parent);
    const merged = new ImageLayer(top.name, capture.surface, top.id);
    merged.setTransform(capture.transform);
    const snapshots = new Map<string, Surface>();
    const undo: LayerStep[] = [];
    let serialized: SerializedLayer;
    try {
      for (const layer of layers) undo.push({
        action: 'add', parentId: layer.parent!.id, index: layer.parent!.children.indexOf(layer), layer: this.image.serializeLayer(layer, snapshots),
      });
      serialized = this.image.serializeLayer(merged, snapshots);
    } catch (error) { for (const surface of snapshots.values()) surface.destroy(); throw error; }
    finally { this.compositor.release(merged); }
    this.commit(layers.length === 1 ? 'Merge group' : 'Merge layers',
      [{ action: 'remove', layerId: merged.id }, ...undo],
      [...layers.map((layer): LayerStep => ({ action: 'remove', layerId: layer.id })),
        { action: 'add', parentId: parent.id, index: this.insertion(layers, parent), layer: serialized }],
      this.state([merged]), snapshots,
    );
  }

  applyFilter(layer: ImageLayer, filter: Filter): void {
    if (!layer.pixelEditable) throw new Error('Text layer filters must remain editable.');
    if (layer.filters[0] !== filter) throw new Error('Only the first filter can be applied to pixels.');
    this.compositor.flush();
    const resolved = this.compositor.resolve(layer, 1);
    const next = layer.filters[1];
    const filtered = next ? this.compositor.filterInput(layer, next.id)! : resolved;
    const bounds = filtered.bounds;
    const source = createSurface('Applied filter pixels', { x: 0, y: 0, width: bounds.width, height: bounds.height }, 1, layer.source.format);
    const snapshots = new Map<string, Surface>();
    const frame = this.gpu.beginFrame();
    try {
      const pass = this.compositor.quads.begin(frame, source);
      this.compositor.quads.draw(pass, frame, filtered, source, [1, 0, 0, 1, -bounds.x, -bounds.y]);
      pass.end();
      frame.submit();
      const before = {
        snapshotId: this.image.capturePixels(layer, snapshots), transform: [...layer.transform], filters: layer.filters.map((item) => item.serialize()),
      };
      const transform = multiply(layer.transform, [1, 0, 0, 1, bounds.x, bounds.y]);
      const after = {
        snapshotId: this.image.captureSurface(source, snapshots), transform: [...transform], filters: layer.filters.slice(1).map((item) => item.serialize()),
      };
      layer.replaceSource(source);
      layer.setTransform(transform);
      layer.removeFilter(filter.id);
      this.history.push(new UndoOperation(
        'Apply ' + filter.label,
        { type: 'layer', targetId: layer.id, action: 'apply-filter', data: before },
        { type: 'layer', targetId: layer.id, action: 'apply-filter', data: after },
        snapshots,
      ));
    } catch (error) {
      if (layer.source !== source) source.destroy();
      for (const surface of snapshots.values()) surface.destroy();
      throw error;
    } finally { frame.release(); }
  }
}
