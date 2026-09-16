import { ColorRangeRenderer } from '../gpu/color-range';
import type { Surface } from '../gpu/surface';
import type { UndoDirection, UndoOperation } from '../history/undo';
import { ImageLayer } from '../model/layers';
import type { Layer } from '../model/layers';
import { inverse } from '../model/geometry';
import type { Editor } from '../editor';
import { SliderInput } from '../ui/slider-input';
import { PointEditor } from './point-editor';
import type { ToolPointer } from './tool';
import { Tool } from './tool';

interface MaskTarget {
  id: string;
  label: string;
}

export class ColorRangeTool extends Tool {
  readonly id = 'color-range';
  readonly label = 'Color range';
  readonly cursor = 'crosshair';
  readonly hint = '';
  override readonly coalescedPointerMoves = false;
  override readonly popup = true;
  override readonly temporary = true;
  private readonly renderer: ColorRangeRenderer;
  private readonly pointEditor: PointEditor;
  private source: Surface | null = null;
  private targetId = 'selection';
  private target: ImageLayer | null = null;
  private edit: UndoOperation | undefined;
  private fuzziness = 40;
  private invert = false;
  private targetSelect: HTMLSelectElement | null = null;
  private targetSignature = '';
  private samplesLabel: HTMLElement | null = null;
  private fuzzinessControl: SliderInput | null = null;
  private hasRange = false;
  private maskOwner: Layer | null = null;
  private pendingMaskOwner: Layer | null = null;

  constructor(editor: Editor) {
    super(editor);
    this.renderer = new ColorRangeRenderer(editor.gpu);
    this.pointEditor = new PointEditor(editor, {
      bounds: () => this.editor.image.frame,
      createData: () => null,
      changed: () => { this.hasRange = true; this.rebuild(); },
    });
  }

  override activate(): void {
    this.targetId = 'selection';
    this.target = this.editor.image.selectionLayer;
    this.edit = undefined;
    this.hasRange = false;
    const selected = this.editor.image.selected;
    const cannotOwnMask = this.editor.image.selectedLayers.length !== 1 || selected === this.editor.image.root || selected.isSelection ||
      selected instanceof ImageLayer && selected.channels === 1;
    this.maskOwner = cannotOwnMask ? null : selected;
    this.pendingMaskOwner = null;
    this.editor.brushCursor.hidden = true;
  }

  override deactivate(): void {
    this.pointEditor.clear();
    this.source?.destroy();
    this.source = null;
    this.target = null;
    this.edit = undefined;
    this.hasRange = false;
    this.maskOwner = null;
    this.pendingMaskOwner = null;
    this.targetSelect = null;
    this.samplesLabel = null;
    this.fuzzinessControl = null;
    this.targetSignature = '';
  }

  pointerDown(pointer: ToolPointer): void { this.pointEditor.pointerDown(pointer); }
  pointerMove(pointer: ToolPointer): void { this.pointEditor.pointerMove(pointer); }
  finish(): void { this.pointEditor.finish(); }
  cancel(): void { this.pointEditor.cancel(); }
  override secondaryClick(pointer: ToolPointer): boolean { return this.pointEditor.secondaryClick(pointer); }
  override drawOverlay(): void { this.pointEditor.drawOverlay(); }
  drawUI(_container: HTMLElement): void {}

  override drawPopup(container: HTMLElement): void {
    const targetField = document.createElement('label');
    targetField.className = 'field';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = 'Output';
    const row = document.createElement('div');
    row.className = 'tool-window-target';
    this.targetSelect = document.createElement('select');
    this.targetSelect.setAttribute('aria-label', 'Color range output');
    this.targetSelect.onchange = () => this.editor.run(() => this.setTarget(this.targetSelect!.value));
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'New mask layer';
    create.title = this.maskOwner ? `Create and apply a mask to ${this.maskOwner.name}` : 'Create a mask layer';
    create.onclick = () => this.editor.run(() => {
      this.editor.deselect();
      const layers = this.editor.image.allLayers();
      const owner = this.maskOwner && layers.includes(this.maskOwner) ? this.maskOwner : null;
      const mask = this.editor.image.createMask(owner?.parent ?? undefined);
      this.targetId = mask.id;
      this.target = mask;
      this.edit = undefined;
      this.pendingMaskOwner = owner;
      this.targetSignature = '';
      if (this.hasRange) this.rebuild();
      this.editor.changed();
    });
    row.append(this.targetSelect, create);
    targetField.append(targetLabel, row);
    this.fuzzinessControl = new SliderInput({
      label: 'Fuzziness', min: 0, max: 200, step: 1, get: () => this.fuzziness,
      input: (value) => { this.fuzziness = value; if (this.hasRange) this.rebuild(); },
    });
    const invertLabel = document.createElement('label');
    invertLabel.className = 'generation-window-toggle';
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    invert.checked = this.invert;
    invert.onchange = () => {
      this.invert = invert.checked;
      if (this.hasRange) this.rebuild();
    };
    const invertText = document.createElement('span');
    invertText.textContent = 'Invert';
    invertLabel.append(invert, invertText);
    this.samplesLabel = document.createElement('div');
    this.samplesLabel.className = 'tool-window-samples';
    container.append(targetField, this.fuzzinessControl.element, invertLabel, this.samplesLabel);
    this.syncPopup();
  }

  override syncPopup(): void {
    if (!this.targetSelect) return;
    const targets = this.maskTargets();
    const signature = targets.map(({ id, label }) => `${id}:${label}`).join('|');
    if (signature !== this.targetSignature) {
      this.targetSignature = signature;
      this.targetSelect.replaceChildren(...targets.map(({ id, label }) => new Option(label, id)));
    }
    this.targetSelect.value = this.targetId;
    this.fuzzinessControl?.sync();
    if (this.samplesLabel) this.samplesLabel.textContent = `Samples: ${this.pointEditor.points.length}`;
  }

  applyUndo(_operation: UndoOperation, _direction: UndoDirection): void {
    throw new Error('Color range edits are stored on their output layer.');
  }

  private setTarget(id: string): void {
    const target = id === 'selection' ? this.editor.image.ensureSelection() :
      this.editor.image.allLayers().find((layer): layer is ImageLayer => layer.id === id && layer instanceof ImageLayer && layer.channels === 1) ?? null;
    if (!target) { this.targetSignature = ''; this.syncPopup(); return; }
    if (id !== 'selection') this.editor.deselect();
    this.targetId = id;
    this.target = target;
    this.edit = undefined;
    this.pendingMaskOwner = null;
    if (this.hasRange) this.rebuild();
    this.editor.changed();
  }

  private rebuild(): void {
    const target = this.resolveTarget();
    if (!this.source) this.source = this.editor.compositor.captureDocument(this.editor.image.root, this.editor.image.frame);
    const mask = this.renderer.render(this.source, this.pointEditor.points, this.fuzziness, this.invert);
    if (target.isSelection && this.pointEditor.points.length) this.editor.image.activateSelection(target);
    this.edit = this.editor.image.updatePixels(target, mask, inverse(target.parent!.worldTransform()), 'Color range', this.edit);
    if (this.pendingMaskOwner && this.editor.image.allLayers().includes(this.pendingMaskOwner) && this.pointEditor.points.length) {
      const owner = this.pendingMaskOwner;
      this.pendingMaskOwner = null;
      this.editor.setLayerMask(owner, target);
    }
    this.editor.changed();
  }

  private resolveTarget(): ImageLayer {
    const layers = this.editor.image.allLayers();
    if (this.target && layers.includes(this.target)) return this.target;
    const mask = this.targetId === 'selection' ? null :
      layers.find((layer): layer is ImageLayer => layer.id === this.targetId && layer instanceof ImageLayer && layer.channels === 1);
    if (mask) { this.target = mask; return mask; }
    this.targetId = 'selection';
    const selection = this.editor.image.ensureSelection();
    this.target = selection;
    this.edit = undefined;
    this.pendingMaskOwner = null;
    this.targetSignature = '';
    return selection;
  }

  private maskTargets(): MaskTarget[] {
    const targets = [{ id: 'selection', label: 'Selection' }];
    for (const layer of this.editor.image.allLayers()) {
      if (!(layer instanceof ImageLayer) || layer.channels !== 1 || layer.isSelection) continue;
      const path = [layer.name];
      for (let parent = layer.parent; parent && parent !== this.editor.image.root; parent = parent.parent) path.unshift(parent.name);
      targets.push({ id: layer.id, label: path.join(' / ') });
    }
    return targets;
  }
}
