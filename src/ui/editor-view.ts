import type { Editor } from '../editor';
import { isEditingText } from '../actions';
import type { Filter, SerializedFilter } from '../filters/filter';
import { createImageLayer } from '../gpu/images';
import { UndoOperation } from '../history/undo';
import { GroupLayer, ImageLayer, Layer } from '../model/layers';
import type { BlendMode, LayerProperties } from '../model/layers';
import { SliderInput } from './slider-input';
import type { Matrix } from '../model/geometry';
import { BrushTool } from '../tools/brush-tool';

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
const input = (id: string) => element<HTMLInputElement>(id);

export class EditorView {
  private treeSignature = '';
  private rows = new Map<string, HTMLElement>();
  private optionsTool = '';
  private dialogMode: 'document' | 'layer' = 'document';
  private draggedLayer: string | null = null;
  private paintedPreviews = new WeakMap<HTMLCanvasElement, ImageData>();
  private readonly opacityControl: SliderInput;
  private draggedFilterId: string | null = null;
  private draggedFilterLayer: Layer | null = null;

  constructor(private readonly editor: Editor) {
    editor.onChange = () => this.render();
    editor.onPreviews = () => this.renderPreviews();
    editor.onColorChange = (color) => { input('brush-color').value = color; };
    editor.onNewDocument = () => this.showSizeDialog('document');
    editor.onNewLayer = () => this.showSizeDialog('layer');
    editor.onRename = () => this.rename(editor.image.selected);
    editor.onFrame = () => {
      element('zoom-label').textContent = `${Math.round(editor.viewport.scale * 100)}%`;
      if (editor.activeTool.id === 'transform') this.updateTransformFields();
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.onclick = () => editor.actions.execute(button.dataset.action!);
    }
    input('brush-color').oninput = () => editor.setBrushColor(input('brush-color').value);
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
        if (this.dialogMode === 'document') editor.reset(width, height);
        else {
          const layer = createImageLayer(editor.gpu, input('new-layer-name').value.trim() || 'Pixel layer', width, height);
          try { editor.image.add(layer); }
          catch (error) { if (!layer.parent) editor.compositor.release(layer); throw error; }
        }
        element<HTMLDialogElement>('size-dialog').close();
      });
    };
    element('layer-up').onclick = () => editor.run(() => {
      editor.finishGesture();
      const layer = editor.image.selected;
      if (layer.parent) editor.image.move(layer, layer.parent, layer.parent.children.indexOf(layer) + 2);
    });
    element('layer-down').onclick = () => editor.run(() => {
      editor.finishGesture();
      const layer = editor.image.selected;
      if (layer.parent) editor.image.move(layer, layer.parent, layer.parent.children.indexOf(layer) - 1);
    });
    this.attachImport();
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
    element('layer-kind').textContent = layer === editor.image.root ? 'ROOT' : layer.kind.toUpperCase();
    element('layer-size').textContent = layer instanceof ImageLayer ? `${layer.width} × ${layer.height} native pixels` : `${(layer as GroupLayer).children.length} children · isolated group`;
    this.opacityControl.sync(!editor.commitEdits);
    const blend = element<HTMLSelectElement>('layer-blend');
    blend.value = layer.blendMode;
    blend.disabled = !layer.parent;
    element('transform-fields').hidden = editor.activeTool.id !== 'transform' || !layer.parent;
    this.updateTransformFields();
    input('brush-color').value = (editor.tools.get('brush') as BrushTool).color;
    element('tool-name').textContent = editor.activeTool.label;
    if (this.optionsTool !== editor.activeTool.id) {
      this.optionsTool = editor.activeTool.id;
      element('tool-options').replaceChildren();
      editor.activeTool.drawUI(element('tool-options'));
      element('tool-options').closest<HTMLElement>('section')!.hidden = !element('tool-options').childElementCount;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.disabled = !editor.actions.enabled(button.dataset.action!);
      if (button.dataset.action!.startsWith('tool.')) button.classList.toggle('active', button.dataset.action === `tool.${editor.activeTool.id}`);
    }
    this.renderFilters();
  }

  private renderTree(force = false): void {
    const { image } = this.editor;
    const layers = image.allLayers();
    const signature = JSON.stringify(layers.map((layer) => [layer.id, layer.name, layer.visible, layer.parent?.id, layer.filters.length]));
    if (force || signature !== this.treeSignature) {
      this.treeSignature = signature;
      const tree = element('layer-tree');
      tree.replaceChildren();
      this.rows.clear();
      const visit = (layer: Layer, depth: number) => {
        const row = document.createElement('div');
        row.className = 'layer-row';
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.draggable = !!layer.parent;
        const visibility = document.createElement('button');
        visibility.className = 'visibility';
        visibility.textContent = layer.visible ? '●' : '○';
        visibility.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
        visibility.onclick = () => this.editor.run(() => this.editor.changeLayer(layer, 'Toggle layer visibility', () => layer.setVisible(!layer.visible)));
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
        if (layer.filters.length) {
          const badge = document.createElement('span');
          badge.className = 'layer-badge';
          badge.textContent = 'fx';
          row.append(badge);
        }
        this.bindLayerDrag(row, layer);
        tree.append(row);
        this.rows.set(layer.id, row);
        if (layer instanceof GroupLayer) [...layer.children].reverse().forEach((child) => visit(child, depth + 1));
      };
      visit(image.root, 0);
    }
    for (const [id, row] of this.rows) {
      row.classList.toggle('selected', id === image.selected.id);
      row.querySelector('.select-layer')?.setAttribute('aria-pressed', String(id === image.selected.id));
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

  private bindLayerDrag(row: HTMLElement, layer: Layer): void {
    const clear = () => { for (const item of this.rows.values()) delete item.dataset.drop; };
    const zone = (event: DragEvent): 'before' | 'after' | 'inside' => {
      if (!layer.parent) return 'inside';
      const rect = row.getBoundingClientRect();
      const position = (event.clientY - rect.top) / rect.height;
      if (layer instanceof GroupLayer && position > 0.25 && position < 0.75) return 'inside';
      return position < 0.5 ? 'before' : 'after';
    };
    const allowed = (): boolean => {
      if (!this.draggedLayer || this.draggedLayer === layer.id) return false;
      for (let parent: Layer | null = layer; parent; parent = parent.parent) if (parent.id === this.draggedLayer) return false;
      return true;
    };
    row.ondragstart = (event) => {
      if (!layer.parent || isEditingText(event.target)) { event.preventDefault(); return; }
      this.editor.finishGesture();
      this.draggedLayer = layer.id;
      event.dataTransfer!.effectAllowed = 'move';
      event.dataTransfer!.setData('application/x-imged-layer', layer.id);
    };
    row.ondragover = (event) => {
      if (!allowed()) return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      row.dataset.drop = zone(event);
      event.dataTransfer!.dropEffect = 'move';
    };
    row.ondragleave = () => { delete row.dataset.drop; };
    row.ondragend = () => { this.draggedLayer = null; clear(); };
    row.ondrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!allowed()) return;
      const id = this.draggedLayer!;
      const position = zone(event);
      this.draggedLayer = null;
      clear();
      this.editor.run(() => {
        this.editor.finishGesture();
        const moving = this.editor.image.find(id);
        if (position === 'inside' && layer instanceof GroupLayer) this.editor.image.move(moving, layer, layer.children.length);
        else if (layer.parent) this.editor.image.move(moving, layer.parent, layer.parent.children.indexOf(layer) + Number(position === 'before'));
      });
    };
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
    for (const definition of this.editor.filters.list()) add.add(new Option(definition.label, definition.kind));
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
      begin: (name) => {
        if (before) return;
        this.editor.finishGesture();
        before = filter.serialize();
        label = name;
        this.editor.commitEdits = commit;
      },
      preview: (change) => { change(); layer.invalidate(); },
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

  private showSizeDialog(mode: 'document' | 'layer'): void {
    this.dialogMode = mode;
    element('dialog-title').textContent = mode === 'document' ? 'New document' : 'New pixel layer';
    element('dialog-description').textContent = mode === 'document'
      ? 'Replace the current document and its history. These dimensions set the canonical canvas size and initial layer pixels.'
      : 'Choose this layer’s native resolution. Its transform controls its size in the composition.';
    element('confirm-size').textContent = mode === 'document' ? 'Create document' : 'Add layer';
    element('new-layer-name-field').hidden = mode === 'document';
    input('new-width').value = String(this.editor.image.frame.width);
    input('new-height').value = String(this.editor.image.frame.height);
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
