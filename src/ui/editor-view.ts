import type { Editor } from '../editor';
import { isEditingText } from '../actions';
import type { Filter, SerializedFilter } from '../filters/filter';
import { UndoOperation } from '../history/undo';
import { GroupLayer, ImageLayer, Layer, canReferenceLayer, validateLayerDependencies } from '../model/layers';
import type { BlendMode, LayerProperties } from '../model/layers';
import { SliderInput } from './slider-input';
import { LayerPointerDrag } from './layer-pointer-drag';
import type { LayerDragPosition } from './layer-pointer-drag';
import type { Matrix } from '../model/geometry';

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
const input = (id: string) => element<HTMLInputElement>(id);

type LayerDrop =
  | {
    kind: 'mask';
    layer: Layer;
  }
  | {
    kind: 'before' | 'after' | 'inside' | 'bottom';
    parent: GroupLayer;
    index: number;
  };

export class EditorView {
  private treeSignature = '';
  private rows = new Map<string, HTMLElement>();
  private optionsTool = '';
  private sizedLayerDialog = false;
  private draggedLayer: Layer | null = null;
  private readonly layerPointerDrag: LayerPointerDrag;
  private layerDropTargets = new WeakMap<HTMLElement, (position: LayerDragPosition) => LayerDrop | null>();
  private groupDropEnds = new Map<GroupLayer, HTMLElement>();
  private layerDropIndicator: HTMLElement | null = null;
  private layerDropParent: HTMLElement | null = null;
  private paintedPreviews = new WeakMap<HTMLCanvasElement, ImageData>();
  private readonly opacityControl: SliderInput;
  private draggedFilterId: string | null = null;
  private draggedFilterLayer: Layer | null = null;

  constructor(private readonly editor: Editor) {
    editor.onChange = () => this.render();
    editor.onPreviews = () => this.renderPreviews();
    editor.onColorChange = (primary, secondary) => {
      input('brush-color').value = primary;
      input('secondary-color').value = secondary;
    };
    editor.onNewDocument = () => this.showSizeDialog();
    editor.onNewSizedLayer = () => this.showSizeDialog(true);
    editor.onRename = () => this.rename(editor.image.selected);
    editor.onFrame = () => {
      element('zoom-label').textContent = `${Math.round(editor.viewport.scale * 100)}%`;
      if (editor.activeTool.id === 'transform') this.updateTransformFields();
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.onclick = () => editor.actions.execute(button.dataset.action!);
    }
    input('brush-color').oninput = () => editor.setBrushColor(input('brush-color').value);
    input('secondary-color').oninput = () => editor.setColors(editor.primaryColor, input('secondary-color').value);
    this.opacityControl = this.createOpacityControl();
    element('layer-opacity-control').append(this.opacityControl.element);
    element<HTMLSelectElement>('layer-blend').onchange = () => editor.run(() => {
      const layer = editor.image.selected;
      const blend = element<HTMLSelectElement>('layer-blend').value as BlendMode;
      editor.changeLayer(layer, 'Change blend mode', () => layer.setBlendMode(blend));
    });
    for (const id of ['layer-x', 'layer-y', 'layer-scale-x', 'layer-scale-y', 'layer-angle']) {
      input(id).onchange = () => editor.run(() => this.changeTransform(id));
    }
    element('cancel-size').onclick = () => element<HTMLDialogElement>('size-dialog').close();
    element('size-form').onsubmit = (event) => {
      event.preventDefault();
      editor.run(() => {
        const width = input('new-width').valueAsNumber;
        const height = input('new-height').valueAsNumber;
        if (this.sizedLayerDialog) editor.image.createPixelLayer(width, height);
        else editor.reset(width, height);
        element<HTMLDialogElement>('size-dialog').close();
      });
    };
    this.attachImport();
    const tree = element('layer-tree');
    this.layerPointerDrag = new LayerPointerDrag(tree, {
      begin: (layer, row) => this.startLayerDrag(layer, row),
      move: (position) => this.updateLayerDrag(position),
      drop: (position) => this.dropLayer(position),
      end: () => this.endLayerDrag(),
      error: editor.report,
    });
    this.bindLayerDrop(tree, (event) => event.target === tree && !event.shiftKey ?
      { kind: 'bottom', parent: this.editor.image.root, index: 0 } : null);
    void editor.generation.refreshModels();
  }

  private createOpacityControl(): SliderInput {
    let editedLayer: Layer | null = null;
    let before: LayerProperties | null = null;
    const commit = () => {
      if (!before || !editedLayer) return;
      const layer = editedLayer;
      const previous = before;
      before = null;
      editedLayer = null;
      if (this.editor.commitEdits === commit) this.editor.commitEdits = undefined;
      this.editor.recordLayerChange(layer, previous, 'Change opacity');
      this.editor.requestRender();
    };
    return new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', get: () => this.editor.image.selected.opacity * 100,
      begin: () => this.editor.run(() => {
        if (before) return;
        this.editor.finishGesture();
        editedLayer = this.editor.image.selected;
        before = editedLayer.properties();
        this.editor.commitEdits = commit;
      }),
      input: (value) => this.editor.run(() => editedLayer?.setOpacity(value / 100)),
      commit: () => this.editor.run(commit),
    });
  }
  render(): void {
    this.renderTree();
    const { editor } = this;
    const layer = editor.image.selected;
    element('frame-label').textContent = `${editor.image.width} × ${editor.image.height} px`;
    element('layer-kind').textContent = layer.isSelection ? 'SELECTION' : layer instanceof ImageLayer && layer.channels === 1 ? 'MASK' : layer === editor.image.root ? 'ROOT' : layer.kind.toUpperCase();
    element('layer-size').textContent = layer instanceof ImageLayer ? `${layer.width} × ${layer.height} native pixels` : `${(layer as GroupLayer).children.length} children · isolated group`;
    element('selection-actions').hidden = !layer.isSelection;
    this.opacityControl.sync(!editor.commitEdits);
    const blend = element<HTMLSelectElement>('layer-blend');
    blend.value = layer.blendMode;
    blend.disabled = !layer.parent;
    element('transform-fields').hidden = editor.activeTool.id !== 'transform' || !layer.parent;
    this.updateTransformFields();
    input('brush-color').value = editor.primaryColor;
    input('secondary-color').value = editor.secondaryColor;
    element('tool-name').textContent = editor.activeTool.label;
    if (this.optionsTool !== editor.activeTool.id) {
      this.optionsTool = editor.activeTool.id;
      element('tool-options').replaceChildren();
      element('tool-options').classList.remove('generation-options');
      editor.activeTool.drawUI(element('tool-options'));
      element('tool-options').closest<HTMLElement>('section')!.hidden = !element('tool-options').childElementCount;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.disabled = !editor.actions.enabled(button.dataset.action!);
      if (button.dataset.action!.startsWith('tool.')) button.classList.toggle('active', button.dataset.action === `tool.${editor.activeTool.id}`);
      if (button.dataset.action === 'drawing.erase' || button.dataset.action === 'selection.mode') {
        const enabled = button.dataset.action === 'drawing.erase' ? editor.eraseMode : editor.selectionMode;
        button.classList.toggle('active', enabled);
        button.setAttribute('aria-pressed', String(enabled));
      }
    }
    this.renderFilters();
    element('cancel-generation').hidden = !editor.generation.busy;
    editor.generation.onChange?.();
  }

  private renderTree(force = false): void {
    const { image } = this.editor;
    const layers = image.allLayers();
    const signature = JSON.stringify(layers.map((layer) => [layer.id, layer.name, layer.visible, layer.parent?.id, layer.filters.length, layer.isSelection]));
    if (force || signature !== this.treeSignature) {
      this.endLayerDrag();
      this.treeSignature = signature;
      const tree = element('layer-tree');
      tree.replaceChildren();
      this.rows.clear();
      this.groupDropEnds.clear();
      const visit = (layer: Layer, depth: number) => {
        const row = document.createElement('div');
        row.className = `layer-row${layer.isSelection ? ' selection-layer' : layer instanceof ImageLayer && layer.channels === 1 ? ' mask-layer' : ''}`;
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.style.setProperty('--layer-indent', row.style.paddingLeft);
        row.draggable = false;
        const visibility = document.createElement('button');
        visibility.className = 'visibility';
        visibility.onclick = () => this.editor.run(() => this.editor.toggleLayerVisibility(layer));
        const choose = document.createElement('button');
        choose.className = 'select-layer';
        const preview = document.createElement('canvas');
        preview.className = `layer-preview${layer instanceof GroupLayer ? ' group-preview' : ''}`;
        preview.width = 64;
        preview.height = 64;
        preview.setAttribute('aria-hidden', 'true');
        this.drawPreview(preview, layer);
        const title = document.createElement('span');
        title.className = 'layer-title';
        title.textContent = layer.name;
        choose.append(preview, title);
        choose.onclick = () => { if (image.selected !== layer) this.editor.select(layer); };
        choose.ondblclick = (event) => { event.preventDefault(); this.rename(layer); };
        row.append(visibility, choose);
        if (layer instanceof ImageLayer && layer.channels === 1) {
          const badge = document.createElement('span');
          badge.className = 'layer-badge mask-badge';
          badge.textContent = layer.isSelection ? 'sel' : 'mask';
          row.append(badge);
        }
        if (layer.filters.length) {
          const badge = document.createElement('span');
          badge.className = 'layer-badge';
          badge.textContent = 'fx';
          row.append(badge);
        }
        this.bindLayerDrag(row, layer);
        tree.append(row);
        this.rows.set(layer.id, row);
        if (layer instanceof GroupLayer) {
          [...layer.children].reverse().forEach((child) => visit(child, depth + 1));
          const end = document.createElement('div');
          end.className = 'layer-drop-end';
          end.style.marginLeft = `${8 + (depth + 1) * 14}px`;
          const label = document.createElement('span');
          label.textContent = `Bottom of ${layer.name}`;
          const path = [layer.name];
          for (let parent = layer.parent; parent; parent = parent.parent) path.unshift(parent.name);
          end.title = `Move to bottom of ${path.join(' / ')}`;
          end.append(label);
          this.groupDropEnds.set(layer, end);
          this.bindLayerDrop(end, (event) => event.shiftKey ? null : { kind: 'bottom', parent: layer, index: 0 });
          tree.append(end);
        }
      };
      visit(image.root, 0);
    }
    const editedMask = this.editor.maskEditLayer;
    for (const layer of layers) {
      const row = this.rows.get(layer.id);
      if (!row) continue;
      row.classList.toggle('selected', layer === image.selected);
      row.querySelector('.select-layer')?.setAttribute('aria-pressed', String(layer === image.selected));
      const visibility = row.querySelector<HTMLButtonElement>('.visibility')!;
      const isMask = layer instanceof ImageLayer && layer.channels === 1;
      const shown = isMask ? layer === editedMask : layer.visible;
      visibility.textContent = shown ? '●' : '○';
      visibility.classList.toggle('mask-edit-muted', !!editedMask && layer !== editedMask);
      visibility.classList.toggle('mask-edit-active', layer === editedMask);
      visibility.setAttribute('aria-pressed', String(shown));
      const action = isMask ? layer === editedMask ? 'Return to image' : `Edit ${layer.name} in isolation` :
        editedMask ? 'Return to image' : `${shown ? 'Hide' : 'Show'} ${layer.name}`;
      visibility.title = action;
      visibility.setAttribute('aria-label', action);
    }
    element('layer-count').textContent = String(layers.length - 1);
    const index = image.selected.parent?.children.indexOf(image.selected) ?? -1;
    element<HTMLButtonElement>('layer-up').disabled = !image.selected.parent || index === image.selected.parent.children.length - 1;
    element<HTMLButtonElement>('layer-down').disabled = !image.selected.parent || index === 0;
  }

  private drawPreview(canvas: HTMLCanvasElement, layer: Layer): void {
    const pixels = this.editor.previews.get(layer);
    if (!pixels || this.paintedPreviews.get(canvas) === pixels) return;
    canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    this.paintedPreviews.set(canvas, pixels);
  }

  private renderPreviews(): void {
    for (const layer of this.editor.image.allLayers()) {
      const canvas = this.rows.get(layer.id)?.querySelector<HTMLCanvasElement>('.layer-preview');
      if (canvas) this.drawPreview(canvas, layer);
    }
  }

  rename(layer: Layer): void {
    this.editor.select(layer);
    const row = this.rows.get(layer.id);
    const label = row?.querySelector('.select-layer');
    if (!row || !label) return;
    const field = document.createElement('input');
    field.className = 'rename-layer';
    field.value = layer.name;
    field.setAttribute('aria-label', 'Layer name');
    row.draggable = false;
    label.replaceWith(field);
    let finished = false;
    const finish = (cancel: boolean) => {
      if (finished) return;
      finished = true;
      if (!cancel) this.editor.run(() => this.editor.changeLayer(layer, 'Rename layer', () => { layer.name = field.value.trim() || layer.name; }));
      this.renderTree(true);
      this.editor.canvas.focus({ preventScroll: true });
    };
    field.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Escape'); }
    };
    field.onblur = () => finish(false);
    field.focus();
    field.select();
  }

  private clearLayerDrop(): void {
    if (this.layerDropIndicator) {
      delete this.layerDropIndicator.dataset.drop;
      delete this.layerDropIndicator.dataset.dropLabel;
    }
    this.layerDropParent?.classList.remove('drop-parent');
    this.layerDropIndicator = null;
    this.layerDropParent = null;
  }

  private endLayerDrag(): void {
    this.layerPointerDrag.cancel();
    if (this.draggedLayer) this.rows.get(this.draggedLayer.id)?.classList.remove('layer-drag-source');
    this.draggedLayer = null;
    this.clearLayerDrop();
    element('layer-tree').classList.remove('layer-dragging', 'mask-dragging');
    for (const end of this.groupDropEnds.values()) end.classList.remove('drop-unavailable');
  }

  private allowedLayerDrop(drop: LayerDrop | null): drop is LayerDrop {
    const source = this.draggedLayer;
    if (!source || !drop || !this.editor.image.allLayers().includes(source)) return false;
    return canReferenceLayer(drop.kind === 'mask' ? drop.layer : drop.parent, source);
  }

  private showLayerDrop(node: HTMLElement, drop: LayerDrop): void {
    this.clearLayerDrop();
    const indicator = node === element('layer-tree') && drop.kind === 'bottom' ? this.groupDropEnds.get(drop.parent) ?? node : node;
    this.layerDropIndicator = indicator;
    indicator.dataset.drop = drop.kind;
    if (drop.kind === 'mask') {
      indicator.dataset.dropLabel = drop.layer.filters.some((filter) => filter.kind === 'mask') ? 'Replace mask' : 'Set mask';
    } else {
      this.layerDropParent = this.rows.get(drop.parent.id) ?? null;
      this.layerDropParent?.classList.add('drop-parent');
    }
  }

  private bindLayerDrop(node: HTMLElement, resolve: (position: LayerDragPosition) => LayerDrop | null): void {
    this.layerDropTargets.set(node, resolve);
  }

  private layerDropAt(position: LayerDragPosition): {
    node: HTMLElement;
    drop: LayerDrop;
  } | null {
    for (let node = position.target; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const resolve = this.layerDropTargets.get(node);
      if (!resolve) continue;
      const drop = resolve(position);
      return drop ? { node, drop } : null;
    }
    return null;
  }

  private updateLayerDrag(position: LayerDragPosition): 'alias' | 'grabbing' | 'not-allowed' {
    element('layer-tree').classList.toggle('mask-dragging', position.shiftKey);
    const candidate = this.layerDropAt(position);
    if (!candidate || !this.allowedLayerDrop(candidate.drop)) {
      this.clearLayerDrop();
      return 'not-allowed';
    }
    this.showLayerDrop(candidate.node, candidate.drop);
    return candidate.drop.kind === 'mask' ? 'alias' : 'grabbing';
  }

  private dropLayer(position: LayerDragPosition): void {
    const source = this.draggedLayer;
    const candidate = this.layerDropAt(position);
    const allowed = candidate && this.allowedLayerDrop(candidate.drop);
    this.endLayerDrag();
    if (!source || !candidate || !allowed) return;
    const drop = candidate.drop;
    this.editor.run(() => {
      this.editor.finishGesture();
      if (drop.kind === 'mask') this.editor.setLayerMask(drop.layer, source);
      else this.editor.image.move(source, drop.parent, drop.index);
    });
  }

  private startLayerDrag(layer: Layer, row: HTMLElement): boolean {
    if (this.editor.halted || document.getElementById('app')?.inert) return false;
    this.editor.finishGesture();
    if (!row.isConnected || !layer.parent) return false;
    this.draggedLayer = layer;
    row.classList.add('layer-drag-source');
    element('layer-tree').classList.add('layer-dragging');
    for (const [group, end] of this.groupDropEnds) end.classList.toggle('drop-unavailable', !canReferenceLayer(group, layer));
    return true;
  }

  private bindLayerDrag(row: HTMLElement, layer: Layer): void {
    this.bindLayerDrop(row, (position) => {
      if (position.shiftKey) return { kind: 'mask', layer };
      if (this.draggedLayer === layer) return null;
      const rect = row.getBoundingClientRect();
      const fraction = (position.clientY - rect.top) / rect.height;
      if (layer instanceof GroupLayer && (!layer.parent || fraction > 0.25 && fraction < 0.75)) {
        return { kind: 'inside', parent: layer, index: layer.children.length };
      }
      if (!layer.parent) return null;
      const kind = fraction < 0.5 ? 'before' : 'after';
      return { kind, parent: layer.parent, index: layer.parent.children.indexOf(layer) + Number(kind === 'before') };
    });
    this.layerPointerDrag.bind(row, layer);
  }

  private updateTransformFields(): void {
    const matrix = this.editor.image.selected.transform;
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    const values: Record<string, number> = {
      'layer-x': matrix[4], 'layer-y': matrix[5],
      'layer-scale-x': Math.hypot(matrix[0], matrix[1]) * 100,
      'layer-scale-y': Math.hypot(matrix[2], matrix[3]) * 100 * Math.sign(determinant || 1),
      'layer-angle': Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI,
    };
    for (const [id, value] of Object.entries(values)) if (document.activeElement !== input(id)) input(id).value = String(Number(value.toFixed(2)));
  }

  private changeTransform(id: string): void {
    const layer = this.editor.image.selected;
    const value = input(id).valueAsNumber;
    if (!Number.isFinite(value)) { this.updateTransformFields(); return; }
    const [a, b, c, d, x, y] = layer.transform;
    let matrix: Matrix = layer.transform;
    if (id === 'layer-x') matrix = [a, b, c, d, value, y];
    else if (id === 'layer-y') matrix = [a, b, c, d, x, value];
    else if (id === 'layer-angle') {
      const angle = value * Math.PI / 180 - Math.atan2(b, a);
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      matrix = [a * cosine - b * sine, a * sine + b * cosine, c * cosine - d * sine, c * sine + d * cosine, x, y];
    } else {
      const desired = Math.sign(value || 1) * Math.max(0.001, Math.abs(value / 100));
      if (id === 'layer-scale-x') {
        const ratio = desired / Math.max(1e-10, Math.hypot(a, b));
        matrix = [a * ratio, b * ratio, c, d, x, y];
      } else {
        const ratio = desired / (Math.max(1e-10, Math.hypot(c, d)) * Math.sign(a * d - b * c || 1));
        matrix = [a, b, c * ratio, d * ratio, x, y];
      }
    }
    this.editor.changeLayer(layer, 'Transform layer', () => layer.setTransform(matrix));
  }

  private renderFilters(): void {
    if (this.draggedFilterId) return;
    const layer = this.editor.image.selected;
    const stack = element('filter-stack');
    stack.replaceChildren();
    const add = element<HTMLSelectElement>('add-filter');
    add.replaceChildren(new Option('+ Add filter', ''));
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const definition of this.editor.filters.list()) {
      const option = new Option(definition.label, definition.kind);
      if (!definition.group) { add.add(option); continue; }
      let group = groups.get(definition.group);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = definition.group;
        groups.set(definition.group, group);
        add.append(group);
      }
      group.append(option);
    }
    add.onchange = () => { if (add.value) this.editor.actions.execute(`filter.${add.value}`); };
    for (const filter of layer.filters) this.drawFilter(layer, filter, stack);
  }

  private drawFilter(layer: Layer, filter: Filter, stack: HTMLElement): void {
    let before: SerializedFilter | null = null;
    let label = '';
    const commit = () => {
      if (!before) return;
      const previous = before;
      before = null;
      if (this.editor.commitEdits === commit) this.editor.commitEdits = undefined;
      const after = filter.serialize();
      if (JSON.stringify(previous) === JSON.stringify(after)) return;
      this.editor.history.push(new UndoOperation(
        label,
        { type: 'filter', targetId: filter.id, action: 'state', data: { layerId: layer.id, filter: previous } },
        { type: 'filter', targetId: filter.id, action: 'state', data: { layerId: layer.id, filter: after } },
      ));
    };
    const card = document.createElement('div');
    filter.drawUI(card, {
      histogram: () => this.editor.histogram(layer, filter.id),
      layers: () => this.editor.image.allLayers().map((candidate) => {
        const path = [candidate.name];
        for (let parent = candidate.parent; parent && parent !== this.editor.image.root; parent = parent.parent) path.unshift(parent.name);
        return { id: candidate.id, label: path.join(' / '), disabled: !canReferenceLayer(layer, candidate) };
      }),
      begin: (name) => {
        if (before) return;
        this.editor.finishGesture();
        before = filter.serialize();
        label = name;
        this.editor.commitEdits = commit;
      },
      preview: (change) => this.editor.run(() => {
        const previous = filter.serialize();
        try { change(); validateLayerDependencies(layer); }
        catch (error) { filter.deserialize(previous); this.editor.changed(); throw error; }
        layer.invalidate();
      }),
      commit,
      remove: () => this.editor.run(() => this.editor.removeFilter(layer, filter)),
    });
    this.bindFilterDrag(card, layer, filter);
    stack.append(card);
  }

  private bindFilterDrag(card: HTMLElement, layer: Layer, filter: Filter): void {
    const header = card.querySelector<HTMLElement>('.filter-header')!;
    header.draggable = true;
    header.title = 'Drag to reorder';
    const clearIndicators = () => {
      for (const item of element('filter-stack').querySelectorAll<HTMLElement>('.filter')) {
        delete item.dataset.drop;
        item.classList.remove('filter-dragging');
      }
    };
    const clearDrag = () => { this.draggedFilterId = null; this.draggedFilterLayer = null; clearIndicators(); };
    const allowed = () => this.draggedFilterLayer === layer && this.editor.image.selected === layer &&
      !!this.draggedFilterId && this.draggedFilterId !== filter.id;
    header.onpointerdown = (event) => {
      header.draggable = !(event.target instanceof Element && event.target.closest('input, button, select'));
    };
    header.ondragstart = (event) => {
      if (!header.draggable || !event.dataTransfer) { event.preventDefault(); return; }
      this.draggedFilterId = filter.id;
      this.draggedFilterLayer = layer;
      this.editor.finishGesture();
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-imged-filter', filter.id);
      card.classList.add('filter-dragging');
    };
    header.ondragend = () => {
      const pending = this.draggedFilterId !== null;
      clearDrag();
      if (pending) this.renderFilters();
    };
    card.ondragover = (event) => {
      if (!allowed()) return;
      event.preventDefault();
      event.stopPropagation();
      for (const item of element('filter-stack').querySelectorAll<HTMLElement>('.filter')) delete item.dataset.drop;
      const bounds = card.getBoundingClientRect();
      card.dataset.drop = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      event.dataTransfer!.dropEffect = 'move';
    };
    card.ondragleave = (event) => {
      if (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget)) delete card.dataset.drop;
    };
    card.ondrop = (event) => {
      if (!allowed()) return;
      event.preventDefault();
      event.stopPropagation();
      const id = this.draggedFilterId!;
      const bounds = card.getBoundingClientRect();
      const index = layer.filters.indexOf(filter) + Number(event.clientY >= bounds.top + bounds.height / 2);
      const previous = layer.filters.findIndex((item) => item.id === id);
      clearDrag();
      this.editor.run(() => this.editor.moveFilter(layer, id, index));
      if (layer.filters.findIndex((item) => item.id === id) === previous) this.renderFilters();
    };
  }

  private showSizeDialog(sizedLayer = false): void {
    this.sizedLayerDialog = sizedLayer;
    element('dialog-title').textContent = sizedLayer ? 'New sized layer' : 'New document';
    element('dialog-description').textContent = sizedLayer ? 'Choose the new layer’s pixel dimensions.' :
      'Replace the current document and its history. These dimensions set the canonical canvas size and initial layer pixels.';
    element('confirm-size').textContent = sizedLayer ? 'Create layer' : 'Create document';
    input('new-width').value = String(sizedLayer ? 512 : this.editor.image.frame.width);
    input('new-height').value = String(sizedLayer ? 512 : this.editor.image.frame.height);
    for (const id of ['new-width', 'new-height']) input(id).max = String(this.editor.gpu.device.limits.maxTextureDimension2D);
    element<HTMLDialogElement>('size-dialog').showModal();
  }

  private attachImport(): void {
    document.addEventListener('paste', (event) => {
      if (isEditingText(event.target) || document.querySelector('dialog[open]')) return;
      const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      event.preventDefault();
      this.editor.run(async () => { for (const file of files) await this.editor.addImage('Pasted image', file); });
    });
    this.editor.stage.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    this.editor.stage.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
      this.editor.run(async () => { for (const file of files) await this.editor.addImage(file.name, file); });
    });
  }
}