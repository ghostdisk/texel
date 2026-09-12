import type { Editor } from '../editor';
import { UndoOperation } from '../history/undo';
import type { UndoDirection } from '../history/undo';
import { Layer } from '../model/layers';
import { inverse, multiply, transformPoint } from '../model/geometry';
import type { Matrix, Point, Rect } from '../model/geometry';
import { Tool } from './tool';
import type { ToolPointer } from './tool';

interface TransformGesture {
  layer: Layer;
  before: Matrix;
  parentInverse: Matrix;
  worldInverse: Matrix;
  start: Point;
  startLocal: Point;
  mode: 'move' | 'resize' | 'rotate';
  handle: Point;
  bounds: Rect;
  center: Point;
  angle: number;
}

const HANDLES: readonly Point[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
  { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
];

export class TransformTool extends Tool {
  readonly id = 'transform';
  readonly label = 'Move / transform';
  readonly cursor = 'default';
  readonly hint = 'Drag to move · Drag bounds to resize · Shift constrains · Hold Space to pan';
  private gesture: TransformGesture | null = null;

  constructor(editor: Editor) { super(editor); }

  private contains(layer: Layer, world: Point): boolean {
    try {
      const point = transformPoint(inverse(layer.worldTransform()), world);
      const bounds = layer.localBounds();
      return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
    } catch { return false; }
  }

  private handlePoint(layer: Layer, handle: Point): Point {
    const bounds = layer.localBounds();
    const local = { x: bounds.x + (handle.x + 1) * bounds.width / 2, y: bounds.y + (handle.y + 1) * bounds.height / 2 };
    return this.editor.viewport.worldToScreen(transformPoint(layer.worldTransform(), local));
  }

  private rotationPoint(layer: Layer): Point {
    const top = this.handlePoint(layer, { x: 0, y: -1 });
    const center = this.handlePoint(layer, { x: 0, y: 0 });
    const length = Math.max(1, Math.hypot(top.x - center.x, top.y - center.y));
    return { x: top.x + (top.x - center.x) * 26 / length, y: top.y + (top.y - center.y) * 26 / length };
  }

  private hitHandle(layer: Layer, screen: Point): Point | 'rotate' | null {
    const near = (point: Point) => Math.hypot(point.x - screen.x, point.y - screen.y) <= 9;
    if (near(this.rotationPoint(layer))) return 'rotate';
    return HANDLES.find((handle) => near(this.handlePoint(layer, handle))) ?? null;
  }

  pointerDown(pointer: ToolPointer): void {
    if (pointer.ctrl) { void this.editor.pickLayer(pointer.world).catch(this.editor.report); return; }
    const layer = this.editor.image.selected;
    if (!layer.parent) return;
    const handle = this.hitHandle(layer, pointer.screen);
    if (!handle && !this.contains(layer, pointer.world)) return;
    const parentInverse = inverse(layer.parent.worldTransform());
    const start = transformPoint(parentInverse, pointer.world);
    const bounds = layer.localBounds();
    const center = transformPoint(layer.transform, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    this.gesture = {
      layer, before: [...layer.transform], parentInverse, worldInverse: inverse(layer.worldTransform()), start,
      startLocal: transformPoint(inverse(layer.worldTransform()), pointer.world),
      mode: handle === 'rotate' ? 'rotate' : handle ? 'resize' : 'move',
      handle: handle && handle !== 'rotate' ? handle : { x: 0, y: 0 }, bounds, center,
      angle: Math.atan2(start.y - center.y, start.x - center.x),
    };
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const current = transformPoint(gesture.parentInverse, pointer.world);
    const before = gesture.before;
    let matrix: Matrix;
    if (gesture.mode === 'move') {
      let dx = current.x - gesture.start.x;
      let dy = current.y - gesture.start.y;
      if (pointer.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      matrix = [before[0], before[1], before[2], before[3], before[4] + dx, before[5] + dy];
    } else if (gesture.mode === 'resize') {
      const currentLocal = transformPoint(gesture.worldInverse, pointer.world);
      const { bounds, handle } = gesture;
      const point = {
        x: bounds.x + (handle.x + 1) * bounds.width / 2 + currentLocal.x - gesture.startLocal.x,
        y: bounds.y + (handle.y + 1) * bounds.height / 2 + currentLocal.y - gesture.startLocal.y,
      };
      const anchor = { x: bounds.x + (1 - handle.x) * bounds.width / 2, y: bounds.y + (1 - handle.y) * bounds.height / 2 };
      let sx = handle.x ? (point.x - anchor.x) / (bounds.width * handle.x) : 1;
      let sy = handle.y ? (point.y - anchor.y) / (bounds.height * handle.y) : 1;
      if (pointer.shift && handle.x && handle.y) {
        const size = Math.max(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * size;
        sy = Math.sign(sy || 1) * size;
      }
      sx = Math.sign(sx || 1) * Math.max(0.001, Math.abs(sx));
      sy = Math.sign(sy || 1) * Math.max(0.001, Math.abs(sy));
      matrix = multiply(before, [sx, 0, 0, sy, anchor.x * (1 - sx), anchor.y * (1 - sy)]);
    } else {
      let angle = Math.atan2(current.y - gesture.center.y, current.x - gesture.center.x) - gesture.angle;
      if (pointer.shift) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const { x, y } = gesture.center;
      matrix = multiply([c, s, -s, c, x - c * x + s * y, y - s * x - c * y], before);
    }
    gesture.layer.setTransform(matrix);
  }

  finish(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    const after = gesture.layer.transform;
    if (gesture.before.every((value, index) => value === after[index])) return;
    this.editor.history.push(new UndoOperation(
      gesture.mode === 'move' ? 'Move layer' : gesture.mode === 'resize' ? 'Resize layer' : 'Rotate layer',
      { type: 'tool', targetId: this.id, action: 'transform', data: { layerId: gesture.layer.id, transform: [...gesture.before] } },
      { type: 'tool', targetId: this.id, action: 'transform', data: { layerId: gesture.layer.id, transform: [...after] } },
    ));
  }

  cancel(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture) gesture.layer.setTransform(gesture.before);
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id || payload.action !== 'transform') throw new Error('Unsupported transform undo operation.');
    const layer = this.editor.image.find(String(payload.data.layerId));
    layer.setTransform(payload.data.transform as unknown as Matrix);
    this.editor.image.selected = layer;
  }

  hover(pointer: ToolPointer | null): void {
    this.editor.brushCursor.hidden = true;
    if (!pointer || this.editor.panHeld) return;
    const layer = this.editor.image.selected;
    const handle = layer.parent ? this.hitHandle(layer, pointer.screen) : null;
    this.editor.canvas.style.cursor = handle === 'rotate' ? 'crosshair' : handle ? 'nwse-resize' : layer.parent && this.contains(layer, pointer.world) ? 'move' : 'default';
  }

  drawOverlay(controls = true): void {
    const layer = this.editor.image.selected;
    const overlay = this.editor.overlay;
    const add = (tag: string, attributes: Record<string, string | number>) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      overlay.append(node);
    };
    const corners = [HANDLES[0], HANDLES[2], HANDLES[4], HANDLES[6]].map((handle) => this.handlePoint(layer, handle));
    add('polygon', { points: corners.map((point) => `${point.x},${point.y}`).join(' '), class: controls && layer.parent ? 'transform-outline' : 'selection-outline' });
    if (!controls || !layer.parent) return;
    const top = this.handlePoint(layer, { x: 0, y: -1 });
    const rotation = this.rotationPoint(layer);
    add('line', { x1: top.x, y1: top.y, x2: rotation.x, y2: rotation.y, class: 'transform-outline' });
    for (const handle of HANDLES) {
      const point = this.handlePoint(layer, handle);
      add('rect', { x: point.x - 4, y: point.y - 4, width: 8, height: 8, class: 'transform-handle' });
    }
    add('circle', { cx: rotation.x, cy: rotation.y, r: 5, class: 'transform-handle' });
  }

  drawUI(_container: HTMLElement): void {}
}
