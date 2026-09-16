import type { Editor } from '../editor';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection } from '../history/undo';
import { inverse, multiply } from '../model/geometry';
import type { Matrix, Point, Rect } from '../model/geometry';
import { MAX_IMAGE_SIZE } from '../gpu/surface';
import type { CanvasLayerState } from '../model/image-document';
import { validatePrecision } from '../model/precision';
import type { PrecisionState } from '../model/precision';
import { Tool } from './tool';
import type { ToolPointer } from './tool';

type CropAspect = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9' | 'custom';

interface CropGesture {
  mode: 'new' | 'move' | 'resize';
  start: Point;
  before: Rect;
  handle: Point;
}

interface CropState {
  width: number;
  height: number;
  layers: CanvasLayerState[];
  selection: JsonObject;
  lens: Matrix;
  precision: PrecisionState;
}

const HANDLES: readonly Point[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
  { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
];

export class CropTool extends Tool {
  readonly id = 'crop';
  readonly label = 'Crop';
  readonly cursor = 'crosshair';
  readonly hint = 'Drag a crop · Drag handles to adjust · Shift preserves aspect · Alt resizes from center · Enter applies · Escape cancels';
  private rect: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private gesture: CropGesture | null = null;
  private aspect: CropAspect = 'free';
  private originalRatio = 1;
  private customWidth = 1;
  private customHeight = 1;
  private documentSignature = '';
  private defined = false;
  private applyButton: HTMLButtonElement | null = null;
  private sizeLabel: HTMLElement | null = null;
  private customFields: HTMLElement | null = null;

  private sync(): void {
    const image = this.editor.image;
    const signature = `${image.id}:${image.width}:${image.height}`;
    if (signature === this.documentSignature) return;
    this.documentSignature = signature;
    this.originalRatio = image.width / image.height;
    this.rect = { ...image.frame };
    this.gesture = null;
    this.defined = false;
    this.updateUI();
  }

  private handlePoint(handle: Point): Point {
    const point = {
      x: this.rect.x + (handle.x + 1) * this.rect.width / 2,
      y: this.rect.y + (handle.y + 1) * this.rect.height / 2,
    };
    return this.editor.viewport.worldToScreen(point);
  }

  private hitHandle(screen: Point): Point | null {
    return HANDLES.find((handle) => {
      const point = this.handlePoint(handle);
      return Math.hypot(point.x - screen.x, point.y - screen.y) <= 9;
    }) ?? null;
  }

  private contains(point: Point): boolean {
    return point.x >= this.rect.x && point.y >= this.rect.y &&
      point.x <= this.rect.x + this.rect.width && point.y <= this.rect.y + this.rect.height;
  }

  private ratio(): number | null {
    if (this.aspect === 'free') return null;
    if (this.aspect === 'original') return this.originalRatio;
    if (this.aspect === 'custom') return this.customWidth / this.customHeight;
    const [width, height] = this.aspect.split(':').map(Number);
    return width / height;
  }

  private dragRatio(before: Rect, shift: boolean): number | null {
    return this.ratio() ?? (shift ? before.width > 0 && before.height > 0 ? before.width / before.height : this.originalRatio : null);
  }

  private resized(pointer: ToolPointer, gesture: CropGesture): Rect {
    const { before, handle, start } = gesture;
    const ratio = this.dragRatio(before, pointer.shift);
    const factor = pointer.alt ? 2 : 1;
    let width = before.width + handle.x * (pointer.world.x - start.x) * factor;
    let height = before.height + handle.y * (pointer.world.y - start.y) * factor;
    if (ratio) {
      width = Math.max(0, width);
      height = Math.max(0, height);
      if (!handle.y) height = width / ratio;
      else if (!handle.x) width = height * ratio;
      else if (Math.abs(width / Math.max(before.width, 1) - 1) >= Math.abs(height / Math.max(before.height, 1) - 1)) height = width / ratio;
      else width = height * ratio;
    }
    const left = before.x, top = before.y, right = left + before.width, bottom = top + before.height;
    const x = pointer.alt || !handle.x ? (left + right - width) / 2 : handle.x > 0 ? left : right - width;
    const y = pointer.alt || !handle.y ? (top + bottom - height) / 2 : handle.y > 0 ? top : bottom - height;
    return { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
  }

  pointerDown(pointer: ToolPointer): void {
    this.sync();
    const handle = this.hitHandle(pointer.screen);
    const point = pointer.world;
    if (handle) {
      this.defined = true;
      this.gesture = { mode: 'resize', start: point, before: { ...this.rect }, handle };
    } else if (this.defined && this.contains(pointer.world)) {
      this.gesture = { mode: 'move', start: point, before: { ...this.rect }, handle: { x: 0, y: 0 } };
    } else {
      this.gesture = { mode: 'new', start: point, before: { ...this.rect }, handle: { x: 1, y: 1 } };
    }
    this.pointerMove(pointer);
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const point = pointer.world;
    if (gesture.mode === 'resize') this.rect = this.resized(pointer, gesture);
    else if (gesture.mode === 'move') {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      this.rect = { ...gesture.before, x: gesture.before.x + dx, y: gesture.before.y + dy };
    } else {
      const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      const ratio = this.dragRatio(gesture.before, pointer.shift);
      if (point.x === gesture.start.x && point.y === gesture.start.y) this.rect = { ...gesture.before };
      else {
        this.defined = true;
        const factor = pointer.alt ? 2 : 1;
        let width = Math.abs(dx) * factor, height = Math.abs(dy) * factor;
        if (ratio) { if (width / ratio > height) height = width / ratio; else width = height * ratio; }
        this.rect = {
          x: pointer.alt ? gesture.start.x - width / 2 : dx >= 0 ? gesture.start.x : gesture.start.x - width,
          y: pointer.alt ? gesture.start.y - height / 2 : dy >= 0 ? gesture.start.y : gesture.start.y - height,
          width, height,
        };
      }
    }
    this.updateUI();
    this.editor.requestRender();
  }

  finish(): void { this.gesture = null; }

  cancel(): void {
    this.sync();
    this.rect = { ...this.editor.image.frame };
    this.gesture = null;
    this.defined = false;
    this.updateUI();
    this.editor.requestRender();
  }

  private normalized(): Rect {
    const x = Math.round(this.rect.x), y = Math.round(this.rect.y);
    const right = Math.max(x + 1, Math.round(this.rect.x + this.rect.width));
    const bottom = Math.max(y + 1, Math.round(this.rect.y + this.rect.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  get canApply(): boolean {
    this.sync();
    if (this.editor.generators.busy || this.rect.width <= 0 || this.rect.height <= 0) return false;
    const rect = this.normalized();
    if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || rect.width > MAX_IMAGE_SIZE || rect.height > MAX_IMAGE_SIZE) return false;
    return rect.x !== 0 || rect.y !== 0 || rect.width !== this.editor.image.width || rect.height !== this.editor.image.height;
  }

  private state(): CropState {
    return {
      width: this.editor.image.width,
      height: this.editor.image.height,
      layers: this.editor.image.root.children.map((layer) => ({
        layerId: layer.id,
        transform: [...layer.transform] as unknown as Matrix,
      })),
      selection: this.editor.image.selectionState(),
      lens: [...this.editor.generators.lens.transform] as unknown as Matrix,
      precision: this.editor.image.precisionState(),
    };
  }

  private applyState(state: CropState): void {
    const precision = validatePrecision(state.precision);
    this.editor.image.setCanvasState(state.width, state.height, state.layers, state.selection);
    this.editor.image.setPrecisionState(precision);
    this.editor.generators.resetLens(state.width, state.height);
    this.editor.generators.lens.setTransform(state.lens);
    this.editor.viewport.fit(this.editor.image.frame);
    this.documentSignature = '';
    this.sync();
  }

  apply(): void {
    if (!this.canApply) return;
    const rect = this.normalized();
    const before = this.state();
    const shift: Matrix = [1, 0, 0, 1, -rect.x, -rect.y];
    const root = this.editor.image.root.transform;
    const localShift = multiply(inverse(root), multiply(shift, root));
    const after: CropState = {
      width: rect.width,
      height: rect.height,
      layers: before.layers.map((entry) => ({ layerId: entry.layerId, transform: multiply(localShift, entry.transform) })),
      selection: structuredClone(before.selection),
      lens: multiply(shift, multiply(before.lens, [
        before.width / rect.width, 0, 0, before.height / rect.height, 0, 0,
      ])),
      precision: {
        gridSize: before.precision.gridSize,
        guides: before.precision.guides.map((guide) => ({
          axis: guide.axis,
          position: guide.position - (guide.axis === 'vertical' ? rect.x : rect.y),
        })),
      },
    };
    this.applyState(after);
    const extended = rect.x < 0 || rect.y < 0 || rect.x + rect.width > before.width || rect.y + rect.height > before.height;
    this.editor.history.push(new UndoOperation(
      extended ? 'Extend canvas' : 'Crop canvas',
      { type: 'tool', targetId: this.id, action: 'crop', data: before as unknown as JsonObject },
      { type: 'tool', targetId: this.id, action: 'crop', data: after as unknown as JsonObject },
    ));
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id || payload.action !== 'crop') throw new Error('Unsupported crop undo operation.');
    const data = payload.data;
    this.applyState({
      width: Number(data.width),
      height: Number(data.height),
      layers: data.layers as unknown as CanvasLayerState[],
      selection: data.selection as JsonObject,
      lens: data.lens as unknown as Matrix,
      precision: data.precision as unknown as PrecisionState,
    });
  }

  private setAspect(aspect: CropAspect): void {
    this.aspect = aspect;
    const ratio = this.ratio();
    if (ratio) {
      const before = this.rect;
      const center = { x: this.rect.x + this.rect.width / 2, y: this.rect.y + this.rect.height / 2 };
      let width = this.rect.width, height = width / ratio;
      if (height > this.rect.height) { height = this.rect.height; width = height * ratio; }
      this.rect = { x: center.x - width / 2, y: center.y - height / 2, width, height };
      if (this.rect.x !== before.x || this.rect.y !== before.y || this.rect.width !== before.width || this.rect.height !== before.height) {
        this.defined = true;
      }
    }
    this.updateUI();
    this.editor.requestRender();
  }

  private updateUI(): void {
    if (this.applyButton) this.applyButton.disabled = !this.canApply;
    if (this.customFields) this.customFields.hidden = this.aspect !== 'custom';
    if (this.sizeLabel) {
      const rect = this.normalized();
      this.sizeLabel.textContent = `${rect.width} × ${rect.height} px`;
    }
  }

  hover(pointer: ToolPointer | null): void {
    this.editor.brushCursor.hidden = true;
    if (!pointer || this.editor.panHeld) return;
    const handle = this.hitHandle(pointer.screen);
    if (!handle) this.editor.canvas.style.cursor = 'crosshair';
    else if (!handle.x) this.editor.canvas.style.cursor = 'ns-resize';
    else if (!handle.y) this.editor.canvas.style.cursor = 'ew-resize';
    else this.editor.canvas.style.cursor = handle.x === handle.y ? 'nwse-resize' : 'nesw-resize';
    if (!handle && this.defined && this.contains(pointer.world)) this.editor.canvas.style.cursor = 'move';
  }

  drawOverlay(): void {
    this.sync();
    const overlay = this.editor.overlay;
    const add = (tag: string, attributes: Record<string, string | number>) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      overlay.append(node);
    };
    const topLeft = this.editor.viewport.worldToScreen({ x: this.rect.x, y: this.rect.y });
    const bottomRight = this.editor.viewport.worldToScreen({ x: this.rect.x + this.rect.width, y: this.rect.y + this.rect.height });
    const x = topLeft.x, y = topLeft.y, width = bottomRight.x - topLeft.x, height = bottomRight.y - topLeft.y;
    const frameTopLeft = this.editor.viewport.worldToScreen({ x: 0, y: 0 });
    const frameBottomRight = this.editor.viewport.worldToScreen({ x: this.editor.image.width, y: this.editor.image.height });
    const outerLeft = Math.min(frameTopLeft.x, x), outerTop = Math.min(frameTopLeft.y, y);
    const outerRight = Math.max(frameBottomRight.x, x + width), outerBottom = Math.max(frameBottomRight.y, y + height);
    const shadePath = `M${outerLeft} ${outerTop}H${outerRight}V${outerBottom}H${outerLeft}Z ` +
      `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
    add('path', { d: shadePath, class: 'crop-shade', 'fill-rule': 'evenodd' });
    add('rect', { x, y, width, height, class: 'crop-outline' });
    for (const fraction of [1 / 3, 2 / 3]) {
      add('line', { x1: x + width * fraction, y1: y, x2: x + width * fraction, y2: y + height, class: 'crop-grid' });
      add('line', { x1: x, y1: y + height * fraction, x2: x + width, y2: y + height * fraction, class: 'crop-grid' });
    }
    for (const handle of HANDLES) {
      const point = this.handlePoint(handle);
      add('rect', { x: point.x - 4, y: point.y - 4, width: 8, height: 8, class: 'crop-handle' });
    }
  }

  drawUI(container: HTMLElement): void {
    this.sync();
    container.classList.add('crop-options');
    const label = document.createElement('label');
    label.append(document.createTextNode('Aspect'));
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Crop aspect ratio');
    select.append(
      new Option('Free', 'free'),
      new Option('Original', 'original'),
      new Option('1 : 1', '1:1'),
      new Option('4 : 3', '4:3'),
      new Option('3 : 2', '3:2'),
      new Option('16 : 9', '16:9'),
      new Option('Custom', 'custom'),
    );
    select.value = this.aspect;
    select.onchange = () => this.editor.run(() => this.setAspect(select.value as CropAspect));
    label.append(select);
    this.customFields = document.createElement('span');
    this.customFields.className = 'crop-custom-aspect';
    const customInput = (value: number, name: 'width' | 'height') => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0.01';
      input.max = '10000';
      input.step = '0.01';
      input.value = String(value);
      input.setAttribute('aria-label', `Custom crop aspect ${name}`);
      input.oninput = () => this.editor.run(() => {
        if (!Number.isFinite(input.valueAsNumber) || input.valueAsNumber <= 0) return;
        if (name === 'width') this.customWidth = input.valueAsNumber;
        else this.customHeight = input.valueAsNumber;
        this.setAspect('custom');
      });
      return input;
    };
    this.customFields.append(customInput(this.customWidth, 'width'), document.createTextNode(':'), customInput(this.customHeight, 'height'));
    this.sizeLabel = document.createElement('span');
    this.sizeLabel.className = 'crop-size';
    this.applyButton = document.createElement('button');
    this.applyButton.className = 'primary';
    this.applyButton.textContent = 'Apply';
    this.applyButton.dataset.action = 'crop.apply';
    this.applyButton.onclick = () => this.editor.actions.execute('crop.apply');
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.dataset.action = 'crop.cancel';
    cancel.onclick = () => this.editor.actions.execute('crop.cancel');
    container.append(label, this.customFields, this.sizeLabel, this.applyButton, cancel);
    this.updateUI();
  }
}
