import type { Editor } from '../editor';
import { UndoOperation } from '../history/undo';
import type { JsonObject, UndoDirection } from '../history/undo';
import { inverse, multiply } from '../model/geometry';
import type { Matrix, Point, Rect } from '../model/geometry';
import type { CanvasLayerState } from '../model/image-document';
import { Tool } from './tool';
import type { ToolPointer } from './tool';

type CropAspect = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9';

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
}

const HANDLES: readonly Point[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
  { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export class CropTool extends Tool {
  readonly id = 'crop';
  readonly label = 'Crop';
  readonly cursor = 'crosshair';
  readonly hint = 'Drag a crop · Drag handles to adjust · Enter applies · Escape cancels';
  private rect: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private gesture: CropGesture | null = null;
  private aspect: CropAspect = 'free';
  private originalRatio = 1;
  private documentSignature = '';
  private defined = false;
  private applyButton: HTMLButtonElement | null = null;
  private sizeLabel: HTMLElement | null = null;

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

  private point(pointer: ToolPointer): Point {
    const frame = this.editor.image.frame;
    return {
      x: clamp(pointer.world.x, frame.x, frame.x + frame.width),
      y: clamp(pointer.world.y, frame.y, frame.y + frame.height),
    };
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
    const [width, height] = this.aspect.split(':').map(Number);
    return width / height;
  }

  private ratioCorner(anchor: Point, point: Point, direction: Point, ratio: number): Rect {
    let width = Math.max(0, direction.x * (point.x - anchor.x));
    let height = Math.max(0, direction.y * (point.y - anchor.y));
    if (width / ratio > height) height = width / ratio;
    else width = height * ratio;
    const frame = this.editor.image.frame;
    const maxWidth = direction.x > 0 ? frame.width - anchor.x : anchor.x;
    const maxHeight = direction.y > 0 ? frame.height - anchor.y : anchor.y;
    const scale = Math.min(
      1,
      maxWidth / Math.max(width, 0.000001),
      maxHeight / Math.max(height, 0.000001),
    );
    width *= scale;
    height *= scale;
    return { x: direction.x > 0 ? anchor.x : anchor.x - width, y: direction.y > 0 ? anchor.y : anchor.y - height, width, height };
  }

  private resized(point: Point, handle: Point, before: Rect): Rect {
    const ratio = this.ratio();
    const left = before.x, top = before.y, right = before.x + before.width, bottom = before.y + before.height;
    if (!ratio) {
      const x1 = handle.x < 0 ? point.x : left, x2 = handle.x > 0 ? point.x : right;
      const y1 = handle.y < 0 ? point.y : top, y2 = handle.y > 0 ? point.y : bottom;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
    if (handle.x && handle.y) {
      const anchor = { x: handle.x > 0 ? left : right, y: handle.y > 0 ? top : bottom };
      return this.ratioCorner(anchor, point, handle, ratio);
    }
    const frame = this.editor.image.frame;
    if (handle.x) {
      const anchorX = handle.x > 0 ? left : right;
      const centerY = top + before.height / 2;
      let width = Math.max(0, handle.x * (point.x - anchorX)), height = width / ratio;
      const maxWidth = handle.x > 0 ? frame.width - anchorX : anchorX;
      const maxHeight = 2 * Math.min(centerY, frame.height - centerY);
      const scale = Math.min(
        1,
        maxWidth / Math.max(width, 0.000001),
        maxHeight / Math.max(height, 0.000001),
      );
      width *= scale;
      height *= scale;
      return { x: handle.x > 0 ? anchorX : anchorX - width, y: centerY - height / 2, width, height };
    }
    const anchorY = handle.y > 0 ? top : bottom;
    const centerX = left + before.width / 2;
    let height = Math.max(0, handle.y * (point.y - anchorY)), width = height * ratio;
    const maxHeight = handle.y > 0 ? frame.height - anchorY : anchorY;
    const maxWidth = 2 * Math.min(centerX, frame.width - centerX);
    const scale = Math.min(
      1,
      maxWidth / Math.max(width, 0.000001),
      maxHeight / Math.max(height, 0.000001),
    );
    width *= scale;
    height *= scale;
    return { x: centerX - width / 2, y: handle.y > 0 ? anchorY : anchorY - height, width, height };
  }

  pointerDown(pointer: ToolPointer): void {
    this.sync();
    const handle = this.hitHandle(pointer.screen);
    const point = this.point(pointer);
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
    const point = this.point(pointer);
    if (gesture.mode === 'resize') this.rect = this.resized(point, gesture.handle, gesture.before);
    else if (gesture.mode === 'move') {
      const frame = this.editor.image.frame;
      const dx = clamp(
        point.x - gesture.start.x,
        frame.x - gesture.before.x,
        frame.x + frame.width - gesture.before.x - gesture.before.width,
      );
      const dy = clamp(
        point.y - gesture.start.y,
        frame.y - gesture.before.y,
        frame.y + frame.height - gesture.before.y - gesture.before.height,
      );
      this.rect = { ...gesture.before, x: gesture.before.x + dx, y: gesture.before.y + dy };
    } else {
      const direction = { x: Math.sign(point.x - gesture.start.x) || 1, y: Math.sign(point.y - gesture.start.y) || 1 };
      const ratio = this.ratio();
      if (point.x === gesture.start.x && point.y === gesture.start.y) this.rect = { ...gesture.before };
      else {
        this.defined = true;
        this.rect = ratio ? this.ratioCorner(gesture.start, point, direction, ratio) : {
          x: Math.min(gesture.start.x, point.x), y: Math.min(gesture.start.y, point.y),
          width: Math.abs(point.x - gesture.start.x), height: Math.abs(point.y - gesture.start.y),
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
    const image = this.editor.image;
    let x = clamp(Math.round(this.rect.x), 0, image.width - 1);
    let y = clamp(Math.round(this.rect.y), 0, image.height - 1);
    const right = clamp(Math.round(this.rect.x + this.rect.width), x + 1, image.width);
    const bottom = clamp(Math.round(this.rect.y + this.rect.height), y + 1, image.height);
    if (right <= x) x = Math.max(0, right - 1);
    if (bottom <= y) y = Math.max(0, bottom - 1);
    return { x, y, width: right - x, height: bottom - y };
  }

  get canApply(): boolean {
    this.sync();
    if (this.editor.generation.busy || this.rect.width <= 0 || this.rect.height <= 0) return false;
    const rect = this.normalized();
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
      lens: [...this.editor.generation.lens.transform] as unknown as Matrix,
    };
  }

  private applyState(state: CropState): void {
    this.editor.image.setCanvasState(state.width, state.height, state.layers, state.selection);
    this.editor.generation.resetLens(state.width, state.height);
    this.editor.generation.lens.setTransform(state.lens);
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
    };
    this.applyState(after);
    this.editor.history.push(new UndoOperation(
      'Crop canvas',
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
    const shadePath = `M0 0H${this.editor.viewport.width}V${this.editor.viewport.height}H0Z M${x} ${y}H${x + width}V${y + height}H${x}Z`;
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
    );
    select.value = this.aspect;
    select.onchange = () => this.editor.run(() => this.setAspect(select.value as CropAspect));
    label.append(select);
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
    container.append(label, this.sizeLabel, this.applyButton, cancel);
    this.updateUI();
  }
}
