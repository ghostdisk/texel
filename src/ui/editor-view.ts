import type { Editor } from '../editor';
import { MAX_IMAGE_SIZE } from '../gpu/surface';
import { isEditingText } from '../actions';
import type { Filter, SerializedFilter } from '../filters/filter';
import { UndoOperation } from '../history/undo';
import { GroupLayer, ImageLayer, Layer, canReferenceLayer, validateLayerDependencies } from '../model/layers';
import type { BlendMode, LayerProperties } from '../model/layers';
import { SliderInput } from './slider-input';
import { icon } from './icons';
import type { IconName } from './icons';
import { TabGroup } from './tabs';
import { HistoryPanel } from './history-panel';
import { LayerPointerDrag } from './layer-pointer-drag';
import type { LayerDragPosition } from './layer-pointer-drag';
import type { Matrix } from '../model/geometry';
import type { GuideAxis } from '../model/precision';
import { BlendModeInput } from './blend-mode-input';
import { ToolWindow } from './tool-window';
import type { ExportFormat, ExportMode, ExportSettings } from '../model/export';
import type { ImageDocument } from '../model/image-document';

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
  private treeLayers: Layer[] = [];
  private rows = new Map<string, HTMLElement>();
  private collapsedGroups = new WeakMap<ImageDocument, Set<string>>();
  private optionsTool = '';
  private sizedLayerDialog = false;
  private imageSizeAspect = 1;
  private imageSizeSyncing = false;
  private draggedLayer: Layer | null = null;
  private draggedLayers: Layer[] = [];
  private readonly layerPointerDrag: LayerPointerDrag;
  private layerDropTargets = new WeakMap<HTMLElement, (position: LayerDragPosition) => LayerDrop | null>();
  private groupDropEnds = new Map<GroupLayer, HTMLElement>();
  private layerDropIndicator: HTMLElement | null = null;
  private layerDropParent: HTMLElement | null = null;
  private paintedPreviews = new WeakMap<HTMLCanvasElement, ImageData>();
  private opacityControl: SliderInput | null = null;
  private blendControl: BlendModeInput | null = null;
  private blendPreviewLayers: Layer[] = [];
  private readonly panels: TabGroup;
  private readonly historyPanel: HistoryPanel;
  private draggedFilterId: string | null = null;
  private draggedFilterLayer: Layer | null = null;
  private documentSignature = '';
  private readonly toolWindow: ToolWindow;
  private exportSettings: ExportSettings | null = null;

  constructor(private readonly editor: Editor) {
    this.toolWindow = new ToolWindow(editor);
    this.panels = new TabGroup(element('document-panels'), [
      { id: 'layers', label: 'Layers', panel: element('layers-panel') },
      { id: 'history', label: 'History', panel: element('history-panel') },
    ], 'Document panels');
    this.historyPanel = new HistoryPanel(editor, element('history-list'));
    editor.onChange = () => this.render();
    editor.onDocumentsChange = () => this.render();
    editor.onPreviews = () => this.renderPreviews();
    editor.onColorChange = (primary, secondary) => {
      input('brush-color').value = primary;
      input('secondary-color').value = secondary;
    };
    editor.onCursorPosition = (point) => {
      const position = element('cursor-position');
      position.hidden = !point;
      position.textContent = point ? `X ${Math.floor(point.x)} · Y ${Math.floor(point.y)}` : '';
    };
    editor.onNewDocument = () => this.showSizeDialog();
    editor.onNewSizedLayer = () => this.showSizeDialog(true);
    editor.onImageSize = () => this.showImageSizeDialog();
    editor.onRename = () => this.rename(editor.image.selected);
    editor.onGuideSettings = () => this.showPrecisionDialog();
    editor.onExport = () => this.showExportDialog();
    editor.onFrame = () => {
      element('zoom-label').textContent = `${Math.round(editor.viewport.scale * 100)}%`;
      if (editor.activeTool.id === 'transform') this.updateTransformFields();
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.onclick = () => editor.actions.execute(button.dataset.action!);
    }
    input('brush-color').oninput = () => editor.setBrushColor(input('brush-color').value);
    input('secondary-color').oninput = () => editor.setColors(editor.primaryColor, input('secondary-color').value);
    for (const id of ['layer-x', 'layer-y', 'layer-scale-x', 'layer-scale-y', 'layer-angle']) {
      input(id).onchange = () => editor.run(() => this.changeTransform(id));
    }
    element('cancel-size').onclick = () => element<HTMLDialogElement>('size-dialog').close();
    element('cancel-image-size').onclick = () => element<HTMLDialogElement>('image-size-dialog').close();
    element('cancel-export').onclick = () => {
      this.exportSettings = null;
      element<HTMLDialogElement>('export-dialog').close();
    };
    element<HTMLDialogElement>('export-dialog').addEventListener('close', () => { this.exportSettings = null; });
    element<HTMLSelectElement>('export-mode').onchange = () => {
      if (!this.exportSettings) return;
      this.exportSettings.mode = element<HTMLSelectElement>('export-mode').value as ExportMode;
      this.exportSettings.location = null;
      this.syncExportDialog();
    };
    element<HTMLSelectElement>('export-format').onchange = () => {
      if (!this.exportSettings) return;
      this.exportSettings.format = element<HTMLSelectElement>('export-format').value as ExportFormat;
      if (this.exportSettings.mode === 'single') this.exportSettings.location = null;
      this.syncExportDialog();
    };
    input('export-scale').oninput = () => {
      const scale = input('export-scale').valueAsNumber;
      if (this.exportSettings && Number.isFinite(scale) && scale >= 0.01 && scale <= 16) this.exportSettings.scale = scale;
    };
    element('choose-export-location').onclick = () => editor.run(() => this.chooseExportLocation());
    element<HTMLFormElement>('export-form').onsubmit = (event) => {
      event.preventDefault();
      editor.run(() => this.submitExport());
    };
    input('image-width').oninput = () => this.syncImageSize('width');
    input('image-height').oninput = () => this.syncImageSize('height');
    input('image-keep-aspect').onchange = () => {
      if (input('image-keep-aspect').checked) this.syncImageSize('width');
    };
    element('close-precision').onclick = () => element<HTMLDialogElement>('precision-dialog').close();
    element('precision-form').onsubmit = (event) => event.preventDefault();
    input('grid-size').onchange = () => editor.run(() => {
      const state = editor.image.precisionState();
      state.gridSize = input('grid-size').valueAsNumber;
      editor.setPrecisionState(state, 'Change grid size');
    });
    element('add-guide').onclick = () => editor.run(() => {
      const axis = element<HTMLSelectElement>('new-guide-axis').value as GuideAxis;
      editor.addGuide(axis, input('new-guide-position').valueAsNumber);
    });
    element('size-form').onsubmit = (event) => {
      event.preventDefault();
      editor.run(async () => {
        const width = input('new-width').valueAsNumber;
        const height = input('new-height').valueAsNumber;
        element<HTMLDialogElement>('size-dialog').close();
        if (this.sizedLayerDialog) editor.image.createPixelLayer(width, height);
        else await editor.files.newDocument(width, height);
      });
    };
    element('image-size-form').onsubmit = (event) => {
      event.preventDefault();
      editor.run(() => {
        const width = input('image-width').valueAsNumber;
        const height = input('image-height').valueAsNumber;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return;
        element<HTMLDialogElement>('image-size-dialog').close();
        editor.resizeImage(width, height);
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
    void editor.generators.refreshModels();
  }

  private createOpacityControl(): SliderInput {
    let editedLayers: Layer[] = [];
    let before: LayerProperties[] | null = null;
    const commit = () => {
      if (!before) return;
      const layers = editedLayers;
      const previous = before;
      before = null;
      editedLayers = [];
      if (this.editor.commitEdits === commit) this.editor.commitEdits = undefined;
      this.editor.recordLayerChanges(layers, previous, 'Change opacity');
      this.editor.requestRender();
    };
    return new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', compact: true, get: () => this.editor.image.selected.opacity * 100,
      begin: () => this.editor.run(() => {
        if (before) return;
        this.editor.finishGesture();
        editedLayers = this.editor.image.selectedLayers;
        before = editedLayers.map((layer) => layer.properties());
        this.editor.commitEdits = commit;
      }),
      input: (value) => this.editor.run(() => { for (const layer of editedLayers) layer.setOpacity(value / 100); }),
      commit: () => this.editor.run(commit),
    });
  }

  private initializeDocumentControls(): void {
    if (!this.opacityControl) {
      this.opacityControl = this.createOpacityControl();
      element('layer-opacity-control').append(this.opacityControl.element);
    }
    if (!this.blendControl) this.blendControl = new BlendModeInput(element<HTMLSelectElement>('layer-blend'), {
      preview: (mode) => this.previewBlendMode(mode),
      change: (mode) => this.editor.run(() => {
        this.editor.finishGesture();
        const layers = this.blendPreviewLayers.length ? this.blendPreviewLayers : this.editor.image.selectedLayers;
        const before = layers.map((layer) => layer.properties());
        for (const layer of layers) layer.setBlendMode(mode);
        this.blendPreviewLayers = [];
        this.editor.recordLayerChanges(layers, before, 'Change blend mode');
      }),
    });
  }

  render(): void {
    this.renderDocumentTabs();
    const hasDocument = this.editor.hasDocument;
    element('app').classList.toggle('no-document', !hasDocument);
    element('welcome-screen').hidden = hasDocument;
    if (!hasDocument) {
      this.toolWindow.sync(null);
      this.renderWelcome();
      element('frame-label').textContent = '';
      element('image-operation-status').textContent = '';
      this.syncActionButtons();
      return;
    }
    this.initializeDocumentControls();
    this.renderTree();
    this.historyPanel.render();
    const { editor } = this;
    this.toolWindow.sync(editor.activeTool);
    const layer = editor.image.selected;
    element('frame-label').textContent = `${editor.image.width} × ${editor.image.height} px`;
    element('layer-kind').textContent = editor.image.selectedLayers.length > 1 ? editor.image.selectedLayers.length + ' LAYERS' : layer.isSelection ? 'SELECTION' : layer instanceof ImageLayer && layer.channels === 1 ? 'MASK' : layer === editor.image.root ? 'ROOT' : layer.kind.toUpperCase();
    element('layer-size').textContent = editor.image.selectedLayers.length > 1 ? '' : layer instanceof ImageLayer ? `${layer.width} × ${layer.height} native pixels` : `${(layer as GroupLayer).children.length} children · isolated group`;
    element('selection-actions').hidden = !layer.isSelection;
    this.opacityControl!.sync(!editor.commitEdits);
    this.blendControl!.sync(layer.blendMode, !layer.parent);
    element('transform-fields').hidden = editor.activeTool.id !== 'transform' || !layer.parent || editor.image.selectedLayers.length > 1;
    this.updateTransformFields();
    input('brush-color').value = editor.primaryColor;
    input('secondary-color').value = editor.secondaryColor;
    element('tool-name').textContent = editor.activeTool.label;
    if (this.optionsTool !== editor.activeTool.id) {
      this.optionsTool = editor.activeTool.id;
      const glyphs: Record<string, IconName> = {
        brush: 'brush', rectangle: 'rectangle', ellipse: 'ellipse', fill: 'fill', text: 'text',
        'clone-stamp': 'clone-stamp', 'healing-brush': 'healing-brush', 'freehand-lasso': 'freehand-lasso',
        'polygon-lasso': 'polygon-lasso', crop: 'crop', transform: 'transform', eyedropper: 'eyedropper', 'color-range': 'selection',
      };
      element('active-tool-icon').replaceChildren(icon(glyphs[editor.activeTool.id] ?? 'brush'));
      element('tool-options').replaceChildren();
      element('tool-options').classList.remove('generation-options', 'crop-options', 'polygon-options', 'text-options', 'transform-precision-options', 'retouch-options');
      editor.activeTool.drawUI(element('tool-options'));
    }
    editor.activeTool.syncUI();
    if (element<HTMLDialogElement>('precision-dialog').open) this.renderGuideSettings();
    this.syncActionButtons();
    this.renderFilters();
    element('cancel-generation').hidden = !editor.generators.busy;
    element('cancel-generation').textContent = 'Cancel generation';
    element('image-operation-status').textContent = editor.generators.active?.progress.phase ?? '';
  }

  private syncActionButtons(): void {
    const { editor } = this;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.disabled = !editor.actions.enabled(button.dataset.action!);
      if (button.dataset.action!.startsWith('tool.')) {
        const active = button.dataset.action === `tool.${editor.activeTool.id}`;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
      if (button.dataset.action!.startsWith('generator.') && ['image', 'background-removal', 'object-removal', 'inpaint'].includes(button.dataset.action!.slice('generator.'.length))) {
        const active = button.dataset.action === `generator.${editor.generators.active?.id}`;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
      if (button.dataset.action === 'drawing.erase' || button.dataset.action === 'selection.mode') {
        const enabled = button.dataset.action === 'drawing.erase' ? editor.eraseMode : editor.selectionMode;
        button.classList.toggle('active', enabled);
        button.setAttribute('aria-pressed', String(enabled));
      }
    }
  }

  private renderWelcome(): void {
    const list = element('welcome-recent-files');
    list.replaceChildren();
    if (!this.editor.files.recentEnabled) {
      const empty = document.createElement('p');
      empty.className = 'welcome-recent-empty';
      empty.textContent = 'Recent files are disabled in Settings.';
      list.append(empty);
      return;
    }
    if (!this.editor.files.recentCount) {
      const empty = document.createElement('p');
      empty.className = 'welcome-recent-empty';
      empty.textContent = 'No recent files yet.';
      list.append(empty);
      return;
    }
    for (let index = 0; index < this.editor.files.recentCount; index++) {
      const row = document.createElement('div');
      row.className = 'welcome-recent-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'welcome-recent-file';
      button.textContent = this.editor.files.recentLabel(index);
      button.title = `Open ${button.textContent}`;
      button.onclick = () => this.editor.run(() => this.editor.files.openRecent(index));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'welcome-recent-remove';
      remove.textContent = '×';
      remove.title = `Remove ${button.textContent} from recent files`;
      remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => this.editor.run(() => this.editor.files.removeRecent(index));
      row.append(button, remove);
      list.append(row);
    }
  }

  private previewBlendMode(mode: BlendMode | null): void {
    this.editor.run(() => {
      if (mode && !this.blendPreviewLayers.length) this.blendPreviewLayers = this.editor.image.selectedLayers;
      for (const layer of this.blendPreviewLayers) layer.setTemporaryBlendMode(mode);
      if (!mode) this.blendPreviewLayers = [];
    });
  }

  private renderDocumentTabs(): void {
    const active = this.editor.activeDocument;
    const signature = JSON.stringify(this.editor.documents.map((document) => [
      document.id, document.name, document.dirty, document === active,
    ]));
    if (signature === this.documentSignature) return;
    this.documentSignature = signature;
    const tabs = element('document-tabs');
    const nodes = this.editor.documents.map((session) => {
      const tab = document.createElement('div');
      tab.className = 'document-tab' + (session === active ? ' active' : '');
      const select = document.createElement('button');
      select.className = 'document-tab-select';
      select.type = 'button';
      select.title = session.name;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(session === active));
      select.tabIndex = session === active ? 0 : -1;
      const image = document.createElement('img');
      image.src = '/assets/branding/txl.svg';
      image.alt = '';
      image.draggable = false;
      const label = document.createElement('span');
      label.className = 'document-tab-label';
      label.textContent = session.name + (session.dirty ? ' *' : '');
      select.append(image, label);
      let drag: {
        pointerId: number;
        startX: number;
        dragging: boolean;
      } | null = null;
      let suppressClick = false;
      select.onpointerdown = (event) => {
        if (event.button !== 0) return;
        drag = { pointerId: event.pointerId, startX: event.clientX, dragging: false };
        select.setPointerCapture(event.pointerId);
      };
      select.onpointermove = (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (!drag.dragging && Math.abs(event.clientX - drag.startX) < 4) return;
        if (!drag.dragging) {
          drag.dragging = true;
          tab.classList.add('document-tab-dragging');
          document.body.classList.add('document-tab-drag');
        }
        event.preventDefault();
        const siblings = [...tabs.children].filter((node) => node !== tab) as HTMLElement[];
        const before = siblings.find((node) => event.clientX < node.getBoundingClientRect().left + node.clientWidth / 2);
        tabs.insertBefore(tab, before ?? null);
      };
      const finishDrag = (event: PointerEvent, commit: boolean) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dragging = drag.dragging;
        drag = null;
        if (select.hasPointerCapture(event.pointerId)) select.releasePointerCapture(event.pointerId);
        tab.classList.remove('document-tab-dragging');
        document.body.classList.remove('document-tab-drag');
        if (!dragging) return;
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
        if (commit) this.editor.reorderDocument(session, [...tabs.children].indexOf(tab));
        else { this.documentSignature = ''; this.renderDocumentTabs(); }
      };
      select.onpointerup = (event) => finishDrag(event, true);
      select.onpointercancel = (event) => finishDrag(event, false);
      select.onlostpointercapture = (event) => finishDrag(event, false);
      select.onclick = () => {
        if (suppressClick) return;
        this.editor.run(() => this.editor.activateDocument(session));
      };
      select.onkeydown = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        this.editor.run(() => this.editor.activateRelativeDocument(event.key === 'ArrowLeft' ? -1 : 1));
        queueMicrotask(() => element('document-tabs').querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
      };
      tab.onauxclick = (event) => {
        if (event.button === 1) { event.preventDefault(); void this.editor.files.closeDocument(session).catch(this.editor.report); }
      };
      const close = document.createElement('button');
      close.className = 'document-tab-close';
      close.type = 'button';
      close.textContent = '×';
      close.title = `Close ${session.name}`;
      close.setAttribute('aria-label', `Close ${session.name}`);
      close.onclick = (event) => { event.stopPropagation(); void this.editor.files.closeDocument(session).catch(this.editor.report); };
      tab.append(select, close);
      return tab;
    });
    tabs.replaceChildren(...nodes);
    tabs.querySelector('.document-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private renderTree(force = false): void {
    const { image } = this.editor;
    let collapsed = this.collapsedGroups.get(image);
    if (!collapsed) { collapsed = new Set(); this.collapsedGroups.set(image, collapsed); }
    const generatedLayer = this.editor.generators.active?.resultLayer;
    const layers = image.allLayers().filter((layer) => !layer.isSelection || layer === image.selectionMask || this.editor.selectionMode || image.isSelected(layer));
    const signature = JSON.stringify(layers.map((layer) => [layer.id, layer.name, layer.visible, layer.parent?.id, layer.filters.length, layer.isSelection, layer === generatedLayer]));
    if (force || signature !== this.treeSignature || layers.some((layer, index) => layer !== this.treeLayers[index])) {
      this.endLayerDrag();
      this.treeSignature = signature;
      this.treeLayers = layers;
      const tree = element('layer-tree');
      tree.replaceChildren();
      this.rows.clear();
      this.groupDropEnds.clear();
      const visit = (layer: Layer, depth: number) => {
        if (!layers.includes(layer)) return;
        const isGenerated = layer === generatedLayer;
        const row = document.createElement('div');
        row.className = `layer-row${isGenerated ? ' generation-layer' : layer.isSelection ? ' selection-layer' : layer instanceof ImageLayer && layer.channels === 1 ? ' mask-layer' : ''}`;
        row.style.paddingLeft = `${3 + depth * 12}px`;
        row.style.setProperty('--layer-indent', row.style.paddingLeft);
        row.draggable = false;
        row.oncontextmenu = (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.editor.run(async () => {
            this.editor.finishGesture();
            if (!image.isSelected(layer)) this.editor.select(layer);
            const groups = [
              ['layer.new', 'group.new', 'mask.new'],
              ['clipboard.cut', 'clipboard.copy', 'clipboard.paste'],
              ['selection.layer-copy', 'selection.layer-cut', 'selection.promote', 'selection.deselect'],
              ['layer.duplicate', 'layer.group', 'layer.merge'],
              ['layer.reframe.normalize', 'layer.reframe.trim', 'layer.reframe.extend'],
              ['layer.up', 'layer.down'],
              ['layer.visibility', 'layer.rename', 'layer.delete'],
            ];
            const items = groups.flatMap((ids, group) => this.editor.actions.menuItems(ids).map((item, index) => ({
              ...item, submenu: undefined, separatorBefore: group > 0 && index === 0,
            })));
            await window.desktop.openContextMenu(items, event.clientX, event.clientY);
          });
        };
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
        choose.onclick = (event) => this.editor.select(layer, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
          [...this.rows.keys()].map((id) => image.find(id)));
        choose.ondblclick = (event) => { event.preventDefault(); this.rename(layer); };
        if (layer.parent) {
          if (layer instanceof GroupLayer) {
            const disclosure = document.createElement('button');
            disclosure.className = 'layer-disclosure';
            disclosure.title = `${collapsed.has(layer.id) ? 'Expand' : 'Collapse'} ${layer.name}`;
            disclosure.setAttribute('aria-label', disclosure.title);
            disclosure.setAttribute('aria-expanded', String(!collapsed.has(layer.id)));
            disclosure.append(icon('chevron-down'));
            disclosure.onclick = () => {
              if (collapsed.has(layer.id)) collapsed.delete(layer.id);
              else collapsed.add(layer.id);
              this.renderTree(true);
            };
            row.append(visibility, disclosure, choose);
          } else {
            const spacer = document.createElement('span');
            spacer.className = 'layer-disclosure-spacer';
            row.append(visibility, spacer, choose);
          }
        } else row.append(visibility, choose);
        if (isGenerated) {
          const badge = document.createElement('span');
          badge.className = 'layer-badge generation-badge';
          badge.title = 'Current generator output';
          badge.append(icon('generate'), document.createTextNode('AI'));
          row.append(badge);
        }
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
          if (!collapsed.has(layer.id)) [...layer.children].reverse().forEach((child) => visit(child, depth + 1));
          const end = document.createElement('div');
          end.className = 'layer-drop-end';
          end.style.marginLeft = `${3 + (depth + 1) * 12}px`;
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
      row.classList.toggle('selected', image.isSelected(layer));
      row.classList.toggle('active-layer', layer === image.selected);
      row.querySelector('.select-layer')?.setAttribute('aria-pressed', String(image.isSelected(layer)));
      const visibility = row.querySelector<HTMLButtonElement>('.visibility')!;
      const isMask = layer instanceof ImageLayer && layer.channels === 1;
      const shown = isMask ? layer === editedMask : layer.visible;
      const glyph = shown ? 'eye' : 'eye-off';
      if (visibility.dataset.glyph !== glyph) { visibility.replaceChildren(icon(glyph)); visibility.dataset.glyph = glyph; }
      visibility.classList.toggle('visibility-off', !shown);
      visibility.classList.toggle('mask-edit-muted', !!editedMask && layer !== editedMask);
      visibility.classList.toggle('mask-edit-active', layer === editedMask);
      visibility.setAttribute('aria-pressed', String(shown));
      const action = isMask ? layer === editedMask ? 'Return to image' : `Edit ${layer.name} in isolation` :
        editedMask ? 'Return to image' : `${shown ? 'Hide' : 'Show'} ${layer.name}`;
      visibility.title = action;
      visibility.setAttribute('aria-label', action);
    }
    element('layer-count').textContent = String(layers.length - 1);
    element<HTMLButtonElement>('layer-up').disabled = !this.editor.actions.enabled('layer.up');
    element<HTMLButtonElement>('layer-down').disabled = !this.editor.actions.enabled('layer.down');
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
    this.panels.select('layers');
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
    for (const layer of this.draggedLayers) this.rows.get(layer.id)?.classList.remove('layer-drag-source');
    this.draggedLayers = [];
    this.draggedLayer = null;
    this.clearLayerDrop();
    element('layer-tree').classList.remove('layer-dragging', 'mask-dragging');
    for (const end of this.groupDropEnds.values()) end.classList.remove('drop-unavailable');
  }

  private allowedLayerDrop(drop: LayerDrop | null): drop is LayerDrop {
    const source = this.draggedLayer;
    if (!source || !drop || !this.editor.image.allLayers().includes(source)) return false;
    return drop.kind === 'mask' ? canReferenceLayer(drop.layer, source) : this.draggedLayers.every((layer) => canReferenceLayer(drop.parent, layer));
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
    const layers = this.draggedLayers;
    this.endLayerDrag();
    if (!source || !candidate || !allowed) return;
    const drop = candidate.drop;
    this.editor.run(() => {
      this.editor.finishGesture();
      if (drop.kind === 'mask') this.editor.setLayerMask(drop.layer, source);
      else this.editor.image.commands.move(layers, drop.parent, drop.index);
    });
  }

  private startLayerDrag(layer: Layer, row: HTMLElement): boolean {
    if (this.editor.halted || document.getElementById('app')?.inert) return false;
    this.editor.finishGesture();
    if (!row.isConnected || !layer.parent) return false;
    if (!this.editor.image.isSelected(layer)) this.editor.select(layer);
    this.draggedLayer = layer;
    this.draggedLayers = this.editor.image.selectedRoots;
    for (const selected of this.draggedLayers) this.rows.get(selected.id)?.classList.add('layer-drag-source');
    element('layer-tree').classList.add('layer-dragging');
    for (const [group, end] of this.groupDropEnds) end.classList.toggle('drop-unavailable', !this.draggedLayers.every((selected) => canReferenceLayer(group, selected)));
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
    add.disabled = this.editor.image.selectedLayers.length > 1;
    if (add.disabled) return;
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
    if (!layer.filters.length) {
      const empty = document.createElement('div');
      empty.className = 'filter-empty';
      const label = document.createElement('span');
      label.textContent = 'No filters on this layer';
      empty.append(icon('settings'), label);
      stack.append(empty);
    }
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
      apply: layer instanceof ImageLayer && layer.pixelEditable && layer.filters[0] === filter ? () => this.editor.actions.execute('filter.apply') : undefined,
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
    const frame = this.editor.activeDocument?.image.frame;
    element('dialog-title').textContent = sizedLayer ? 'New sized layer' : 'New document';
    element('dialog-description').textContent = sizedLayer ? 'Choose the new layer’s pixel dimensions.' :
      'Create a new document tab. These dimensions set the canonical canvas size and initial layer pixels.';
    element('confirm-size').textContent = sizedLayer ? 'Create layer' : 'Create document';
    input('new-width').value = String(sizedLayer ? 512 : frame?.width ?? 1000);
    input('new-height').value = String(sizedLayer ? 512 : frame?.height ?? 750);
    for (const id of ['new-width', 'new-height']) input(id).max = String(MAX_IMAGE_SIZE);
    element<HTMLDialogElement>('size-dialog').showModal();
  }

  private showImageSizeDialog(): void {
    const { width, height } = this.editor.image;
    this.imageSizeAspect = width / height;
    input('image-width').value = String(width);
    input('image-height').value = String(height);
    input('image-keep-aspect').checked = true;
    for (const id of ['image-width', 'image-height']) input(id).max = String(MAX_IMAGE_SIZE);
    element<HTMLDialogElement>('image-size-dialog').showModal();
  }

  private showExportDialog(): void {
    const dialog = element<HTMLDialogElement>('export-dialog');
    if (dialog.open) return;
    this.exportSettings = structuredClone(this.editor.document.exportSettings);
    this.syncExportDialog();
    dialog.showModal();
  }

  private syncExportDialog(): void {
    const settings = this.exportSettings;
    if (!settings) return;
    element<HTMLSelectElement>('export-mode').value = settings.mode;
    element<HTMLSelectElement>('export-format').value = settings.format;
    input('export-scale').value = String(settings.scale);
    input('export-location').value = settings.location?.name ?? '';
    input('export-location').placeholder = settings.mode === 'single' ? 'Choose a file' : 'Choose a directory';
  }

  private async chooseExportLocation(): Promise<boolean> {
    const settings = this.exportSettings;
    if (!settings) return false;
    const location = await this.editor.files.chooseExportLocation(settings);
    if (!location) return false;
    settings.location = location;
    this.syncExportDialog();
    return true;
  }

  private async submitExport(): Promise<void> {
    const settings = this.exportSettings;
    if (!settings) return;
    settings.scale = input('export-scale').valueAsNumber;
    if (!settings.location && !await this.chooseExportLocation()) return;
    this.editor.files.setExportSettings(settings);
    this.exportSettings = null;
    element<HTMLDialogElement>('export-dialog').close();
    await this.editor.files.exportConfigured();
  }

  private syncImageSize(source: 'width' | 'height'): void {
    if (this.imageSizeSyncing || !input('image-keep-aspect').checked) return;
    const value = input(source === 'width' ? 'image-width' : 'image-height').valueAsNumber;
    if (!Number.isFinite(value) || value < 1) return;
    const ratio = source === 'width' ? 1 / this.imageSizeAspect : this.imageSizeAspect;
    const other = Math.min(MAX_IMAGE_SIZE, Math.max(1, Math.round(value * ratio)));
    this.imageSizeSyncing = true;
    input(source === 'width' ? 'image-height' : 'image-width').value = String(other);
    this.imageSizeSyncing = false;
  }

  private showPrecisionDialog(): void {
    input('grid-size').value = String(this.editor.image.gridSize);
    this.renderGuideSettings();
    element<HTMLDialogElement>('precision-dialog').showModal();
  }

  private renderGuideSettings(): void {
    input('grid-size').value = String(this.editor.image.gridSize);
    const list = element('guide-list');
    list.replaceChildren();
    if (!this.editor.image.guides.length) {
      const empty = document.createElement('div');
      empty.className = 'guide-empty';
      empty.textContent = 'No guides';
      list.append(empty);
      return;
    }
    this.editor.image.guides.forEach((guide, index) => {
      const row = document.createElement('div');
      row.className = 'guide-row';
      const axis = document.createElement('select');
      axis.setAttribute('aria-label', `Guide ${index + 1} direction`);
      axis.add(new Option('Vertical', 'vertical'));
      axis.add(new Option('Horizontal', 'horizontal'));
      axis.value = guide.axis;
      const position = document.createElement('input');
      position.type = 'number';
      position.step = '1';
      position.value = String(guide.position);
      position.setAttribute('aria-label', `Guide ${index + 1} position`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      axis.onchange = () => this.editor.run(() => this.editor.updateGuide(index, { axis: axis.value as GuideAxis, position: position.valueAsNumber }));
      position.onchange = () => this.editor.run(() => this.editor.updateGuide(index, { axis: axis.value as GuideAxis, position: position.valueAsNumber }));
      remove.onclick = () => this.editor.run(() => this.editor.deleteGuide(index));
      row.append(axis, position, remove);
      list.append(row);
    });
  }

  private attachImport(): void {
    document.addEventListener('paste', (event) => {
      if (isEditingText(event.target) || document.querySelector('dialog[open]')) return;
      const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      event.preventDefault();
      if (!this.editor.hasDocument) this.editor.run(() => this.editor.files.openDroppedImages(files));
      else this.editor.run(async () => { for (const file of files) await this.editor.addImage('Pasted image', file); });
    });
    const acceptsFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const bindDrop = (target: HTMLElement, openDocuments: boolean) => {
      target.addEventListener('dragover', (event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        target.classList.add('image-drop-active');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });
      target.addEventListener('dragleave', (event) => {
        if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
        target.classList.remove('image-drop-active');
      });
      target.addEventListener('drop', (event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        target.classList.remove('image-drop-active');
        const files = [...(event.dataTransfer?.files ?? [])];
        if (openDocuments || !this.editor.hasDocument) {
          this.editor.run(() => this.editor.files.openDroppedImages(files));
        } else {
          const images = files.filter((file) => file.type.startsWith('image/'));
          this.editor.run(async () => { for (const file of images) await this.editor.addImage(file.name, file); });
        }
      });
    };
    bindDrop(element('document-tabs'), true);
    bindDrop(this.editor.stage, false);
  }
}
