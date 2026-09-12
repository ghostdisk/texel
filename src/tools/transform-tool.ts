import type { Editor } from '../editor';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection } from '../history/undo';
import { GroupLayer, Layer } from '../model/layers';
import { IDENTITY, inverse, multiply, transformBounds, unionBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import { snapTransform, worldBounds } from '../model/precision';
import { Tool } from './tool';
import type { ToolPointer } from './tool';
import { TransformControls } from './transform-controls';
import type { TransformTarget } from './transform-controls';

class LayerSelectionTransform implements TransformTarget {
  readonly parent = null;
  readonly before: {
    layer: Layer;
    local: Matrix;
    world: Matrix;
    parentInverse: Matrix;
  }[];
  private matrix: Matrix = IDENTITY;
  private readonly bounds: Rect;

  constructor(layers: readonly Layer[]) {
    this.before = layers.map((layer) => ({
      layer, local: layer.transform, world: layer.worldTransform(), parentInverse: inverse(layer.parent!.worldTransform()),
    }));
    this.bounds = unionBounds(layers.map((layer) => transformBounds(layer.worldTransform(), layer.localBounds())));
  }

  get transform(): Matrix { return this.matrix; }
  worldTransform(): Matrix { return this.matrix; }
  localBounds(): Rect { return this.bounds; }
  setTransform(matrix: Matrix): void {
    this.matrix = matrix;
    for (const item of this.before) item.layer.setTransform(multiply(item.parentInverse, multiply(matrix, item.world)));
  }
}

export class TransformTool extends Tool {
  readonly id = 'transform';
  readonly label = 'Move / transform';
  readonly cursor = 'default';
  readonly hint = 'Drag to move · Drag bounds to resize · Shift constrains · Hold Space to pan';
  private readonly controls: TransformControls;
  private multiple: LayerSelectionTransform | null = null;
  private actionControls: {
    select: HTMLSelectElement;
    actions: readonly string[];
  }[] = [];

  constructor(editor: Editor) {
    super(editor);
    this.controls = new TransformControls(
      editor,
      () => this.target(),
      () => editor.image.selectedRoots.length > 0,
      (target, matrix, _pointer, axis) => this.snap(target, matrix, axis),
    );
  }

  private snap(target: TransformTarget, matrix: Matrix, axis: 'x' | 'y' | null): Matrix {
    if (!this.editor.snapping) return matrix;
    const excluded = new Set<Layer>();
    const visit = (layer: Layer) => {
      excluded.add(layer);
      if (layer instanceof GroupLayer) for (const child of layer.children) visit(child);
    };
    for (const layer of this.editor.image.selectedRoots) {
      visit(layer);
      for (let parent = layer.parent; parent; parent = parent.parent) excluded.add(parent);
    }
    const visible = (layer: Layer) => {
      for (let current: Layer | null = layer; current; current = current.parent) if (!current.visible) return false;
      return !layer.isSelection;
    };
    const otherBounds = this.editor.image.allLayers()
      .filter((layer) => !!layer.parent && visible(layer) && !excluded.has(layer))
      .map(worldBounds);
    return snapTransform(target, matrix, {
      frame: this.editor.image.frame,
      gridSize: this.editor.image.gridSize,
      guides: this.editor.image.guides,
      otherBounds,
      grid: this.editor.showGrid,
      guideLines: this.editor.showGuides,
      threshold: 6 / this.editor.viewport.scale,
      axis,
    });
  }

  private target(): TransformTarget {
    if (this.multiple) return this.multiple;
    const layers = this.editor.image.selectedRoots;
    return layers.length > 1 ? new LayerSelectionTransform(layers) : layers[0] ?? this.editor.image.selected;
  }

  pointerDown(pointer: ToolPointer): void {
    if (pointer.ctrl) { void this.editor.pickLayer(pointer.world, pointer.shift).catch(this.editor.report); return; }
    const layers = this.editor.image.selectedRoots;
    this.multiple = layers.length > 1 ? new LayerSelectionTransform(layers) : null;
    this.controls.pointerDown(pointer);
  }
  pointerMove(pointer: ToolPointer): void { this.controls.pointerMove(pointer); }
  hover(pointer: ToolPointer | null): void { this.controls.hover(pointer); }
  drawOverlay(controls = true): void {
    const layers = this.editor.image.selectedLayers;
    if (layers.length > 1) {
      for (const layer of layers) new TransformControls(this.editor, () => layer, () => false).drawOverlay(false);
      if (controls) this.controls.drawOverlay(true);
    } else this.controls.drawOverlay(controls);
  }
  cancel(): void { this.controls.cancel(); this.multiple = null; }

  finish(): void {
    const change = this.controls.finish();
    this.multiple = null;
    if (!change) return;
    const label = change.mode === 'move' ? 'Move' : change.mode === 'resize' ? 'Resize' : 'Rotate';
    if (change.target instanceof LayerSelectionTransform) {
      const layers = change.target.before;
      const selection = this.editor.image.selectionState();
      this.editor.history.push(new UndoOperation(
        label + ' layers',
        { type: 'tool', targetId: this.id, action: 'transform-layers', data: {
          layers: layers.map((item) => ({ layerId: item.layer.id, transform: [...item.local] })), selection,
        } },
        { type: 'tool', targetId: this.id, action: 'transform-layers', data: {
          layers: layers.map((item) => ({ layerId: item.layer.id, transform: [...item.layer.transform] })), selection,
        } },
      ));
    } else if (change.target instanceof Layer) this.editor.history.push(new UndoOperation(
      label + ' layer',
      { type: 'tool', targetId: this.id, action: 'transform', data: { layerId: change.target.id, transform: [...change.before] } },
      { type: 'tool', targetId: this.id, action: 'transform', data: { layerId: change.target.id, transform: [...change.after] } },
    ));
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id) throw new Error('Unsupported transform undo operation.');
    if (payload.action === 'transform-layers') {
      const entries = payload.data.layers as {
        layerId: string;
        transform: number[];
      }[];
      for (const entry of entries) this.editor.image.find(entry.layerId).setTransform(entry.transform as unknown as Matrix);
      this.editor.image.restoreSelection(payload.data.selection as JsonObject);
    } else if (payload.action === 'transform') {
      const layer = this.editor.image.find(String(payload.data.layerId));
      layer.setTransform(payload.data.transform as unknown as Matrix);
      this.editor.image.selected = layer;
    } else throw new Error('Unsupported transform undo operation.');
  }

  drawUI(container: HTMLElement): void {
    this.actionControls = [];
    container.classList.add('transform-precision-options');
    this.actionSelect(container, 'Align', [
      ['transform.align-left', 'Left'], ['transform.align-center', 'Center'], ['transform.align-right', 'Right'],
      ['transform.align-top', 'Top'], ['transform.align-middle', 'Middle'], ['transform.align-bottom', 'Bottom'],
    ]);
    this.actionSelect(container, 'Distribute', [
      ['transform.distribute-horizontal', 'Horizontal centers'], ['transform.distribute-vertical', 'Vertical centers'],
    ]);
    this.actionSelect(container, 'Transform', [
      ['transform.rotate-cw', 'Rotate 90° CW'], ['transform.rotate-ccw', 'Rotate 90° CCW'],
      ['transform.flip-horizontal', 'Flip horizontal'], ['transform.flip-vertical', 'Flip vertical'],
    ]);
  }

  private actionSelect(container: HTMLElement, label: string, actions: readonly (readonly [string, string])[]): void {
    const select = document.createElement('select');
    select.setAttribute('aria-label', label);
    select.add(new Option(label, ''));
    for (const [id, text] of actions) select.add(new Option(text, id));
    select.onchange = () => {
      const id = select.value;
      select.value = '';
      if (id) this.editor.actions.execute(id);
    };
    container.append(select);
    this.actionControls.push({ select, actions: actions.map(([id]) => id) });
  }

  syncUI(): void {
    for (const control of this.actionControls) {
      for (const option of [...control.select.options].slice(1)) option.disabled = !this.editor.actions.enabled(option.value);
      control.select.disabled = control.actions.every((id) => !this.editor.actions.enabled(id));
    }
  }
}
