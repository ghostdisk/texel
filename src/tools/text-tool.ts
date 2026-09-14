import { rasterizeText } from '../gpu/text';
import type { Surface } from '../gpu/surface';
import { UndoOperation } from '../history/undo';
import type { UndoDirection } from '../history/undo';
import { inverse, multiply, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { TextLayer, DEFAULT_TEXT, validateText } from '../model/text-layer';
import type { TextProperties } from '../model/text-layer';
import { icon } from '../ui/icons';
import { Popover } from '../ui/popover';
import { Tool } from './tool';
import type { ToolPointer } from './tool';

interface TextEdit {
  layer: TextLayer;
  text: TextProperties;
  before: string;
  snapshots: Map<string, Surface>;
}

export class TextTool extends Tool {
  readonly id = 'text';
  readonly label = 'Text';
  readonly cursor = 'text';
  readonly hint = 'Click to add text · Click selected text to edit';
  private defaults = { ...DEFAULT_TEXT, color: this.editor.primaryColor };
  private edit: TextEdit | null = null;
  private popup: Popover | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private fields = new Map<keyof TextProperties, HTMLInputElement | HTMLSelectElement>();
  private toggles = new Map<'bold' | 'italic', HTMLButtonElement>();

  private get layer(): TextLayer | null {
    const selected = this.editor.image.selected;
    return this.editor.image.selectedLayers.length === 1 && selected instanceof TextLayer ? selected : null;
  }

  private get properties(): TextProperties { return this.layer?.textProperties ?? { ...this.defaults }; }

  createAt(point: Point = { x: this.editor.image.width / 2, y: this.editor.image.height / 2 }): void {
    this.editor.setSelectionMode(false);
    this.editor.switchTool(this.id);
    const parent = this.editor.image.destination();
    const properties = validateText(this.defaults);
    const source = rasterizeText(this.editor.gpu, this.editor.compositor.quads, properties);
    let layer: TextLayer | undefined;
    try {
      layer = new TextLayer('Text', source, properties);
      layer.setTransform(multiply(inverse(parent.worldTransform()), [1, 0, 0, 1, point.x, point.y]));
      this.editor.image.add(layer, parent, parent.children.length, true, 'Add text layer');
    } catch (error) { if (!layer?.parent) source.destroy(); throw error; }
    this.openEditor();
  }

  pointerDown(pointer: ToolPointer): void {
    const layer = this.layer;
    if (layer) {
      const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
      if (point.x >= 0 && point.y >= 0 && point.x < layer.width && point.y < layer.height) { this.openEditor(); return; }
    }
    this.createAt(pointer.world);
  }

  private openEditor(): void {
    queueMicrotask(() => {
      if (this.editor.activeTool !== this || !this.popup?.element.isConnected) return;
      this.syncUI();
      this.popup.show();
      this.textarea?.focus();
      this.textarea?.select();
    });
  }

  private update(patch: Partial<TextProperties>): void {
    const properties = validateText({ ...this.properties, ...patch });
    const layer = this.layer;
    if (!layer) { this.defaults = properties; this.syncUI(); return; }
    if (JSON.stringify(properties) === JSON.stringify(layer.textProperties)) return;
    const source = rasterizeText(this.editor.gpu, this.editor.compositor.quads, properties);
    try {
      if (!this.edit) {
        this.editor.finishGesture();
        const snapshots = new Map<string, Surface>();
        const before = this.editor.image.capturePixels(layer, snapshots);
        this.edit = { layer, text: layer.textProperties, before, snapshots };
        this.editor.commitEdits = this.commit;
      }
      layer.updateText(properties, source);
      this.defaults = properties;
      this.syncUI();
      this.editor.requestRender();
    } catch (error) { if (layer.source !== source) source.destroy(); throw error; }
  }

  private commit = (): void => {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    if (this.editor.commitEdits === this.commit) this.editor.commitEdits = undefined;
    if (JSON.stringify(edit.text) === JSON.stringify(edit.layer.textProperties)) {
      edit.layer.restoreText(this.editor.gpu, edit.text, edit.snapshots.get(edit.before)!);
      for (const snapshot of edit.snapshots.values()) snapshot.destroy();
      return;
    }
    try {
      const after = this.editor.image.capturePixels(edit.layer, edit.snapshots);
      this.editor.history.push(new UndoOperation(
        'Edit text',
        { type: 'layer', targetId: edit.layer.id, action: 'text', data: { text: edit.text, snapshotId: edit.before } },
        { type: 'layer', targetId: edit.layer.id, action: 'text', data: { text: edit.layer.textProperties, snapshotId: after } },
        edit.snapshots,
      ));
    } catch (error) {
      edit.layer.restoreText(this.editor.gpu, edit.text, edit.snapshots.get(edit.before)!);
      for (const snapshot of edit.snapshots.values()) snapshot.destroy();
      throw error;
    }
  };

  pointerMove(_pointer: ToolPointer): void {}
  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }
  finish(): void { this.commit(); }
  cancel(): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    if (this.editor.commitEdits === this.commit) this.editor.commitEdits = undefined;
    this.defaults = edit.text;
    try { edit.layer.restoreText(this.editor.gpu, edit.text, edit.snapshots.get(edit.before)!); }
    finally { for (const snapshot of edit.snapshots.values()) snapshot.destroy(); }
    this.editor.changed();
  }
  applyUndo(_operation: UndoOperation, _direction: UndoDirection): void { throw new Error('Text edits belong to their layer.'); }

  override syncUI(): void {
    const properties = this.properties;
    for (const [key, field] of this.fields) if (document.activeElement !== field) field.value = String(properties[key]);
    if (this.textarea && document.activeElement !== this.textarea) this.textarea.value = properties.text;
    for (const [key, button] of this.toggles) button.setAttribute('aria-pressed', String(properties[key]));
  }

  drawUI(container: HTMLElement): void {
    container.classList.add('text-options');
    this.fields.clear();
    this.toggles.clear();
    const addInput = (key: 'fontFamily' | 'fontSize' | 'color' | 'lineHeight', title: string, type: string, parent = container) => {
      const label = document.createElement('label');
      label.textContent = title;
      const field = document.createElement('input');
      field.type = type;
      field.setAttribute('aria-label', title);
      field.className = `text-${key}`;
      const change = () => this.editor.run(() => {
        const value = type === 'number' ? field.valueAsNumber : field.value;
        if (type === 'number' && (!Number.isFinite(value) || !field.validity.valid)) return;
        this.update({ [key]: value });
      });
      if (key === 'fontFamily') field.onchange = () => { change(); this.editor.run(this.commit); };
      else { field.oninput = change; field.onchange = () => this.editor.run(this.commit); }
      field.onblur = () => this.editor.run(() => { this.commit(); this.syncUI(); });
      label.append(field);
      parent.append(label);
      this.fields.set(key, field);
      return field;
    };
    const family = addInput('fontFamily', 'Font', 'text');
    family.maxLength = 128;
    const families = document.createElement('datalist');
    families.id = 'text-font-families';
    for (const name of ['Arial', 'Segoe UI', 'Georgia', 'Times New Roman', 'Courier New', 'system-ui']) families.append(new Option(name));
    family.setAttribute('list', families.id);
    container.append(families);
    const size = addInput('fontSize', 'Size', 'number');
    size.min = '1'; size.max = '2048'; size.step = '1';
    for (const key of ['bold', 'italic'] as const) {
      const button = document.createElement('button');
      button.className = 'text-style icon-button';
      button.append(icon(key));
      button.title = key === 'bold' ? 'Bold' : 'Italic';
      button.setAttribute('aria-label', button.title);
      button.onclick = () => this.editor.run(() => { this.update({ [key]: !this.properties[key] }); this.commit(); });
      this.toggles.set(key, button);
      container.append(button);
    }
    addInput('color', 'Color', 'color');
    const align = document.createElement('select');
    align.setAttribute('aria-label', 'Text alignment');
    align.append(new Option('Left', 'left'), new Option('Center', 'center'), new Option('Right', 'right'));
    align.onchange = () => this.editor.run(() => { this.update({ align: align.value as TextProperties['align'] }); this.commit(); });
    this.fields.set('align', align);
    container.append(align);
    this.popup = new Popover('Edit text', 'text');
    this.popup.panel.classList.add('text-panel');
    this.textarea = document.createElement('textarea');
    this.textarea.rows = 5;
    this.textarea.maxLength = 65536;
    this.textarea.setAttribute('aria-label', 'Text content');
    this.textarea.spellcheck = false;
    this.textarea.oninput = () => this.editor.run(() => this.update({ text: this.textarea!.value }));
    this.textarea.onblur = () => this.editor.run(this.commit);
    this.textarea.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        this.editor.run(() => this.cancel());
        this.popup?.panel.hidePopover();
        this.editor.canvas.focus();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.editor.run(this.commit);
        this.popup?.panel.hidePopover();
        this.editor.canvas.focus();
      }
    };
    this.popup.panel.append(this.textarea);
    const spacing = addInput('lineHeight', 'Line height', 'number', this.popup.panel);
    spacing.min = '0.5'; spacing.max = '4'; spacing.step = '0.05';
    const hint = document.createElement('p');
    hint.textContent = 'Enter adds a line · Ctrl+Enter finishes · Escape reverts the current edit';
    this.popup.panel.append(hint);
    container.append(this.popup.element);
    this.syncUI();
  }
}
