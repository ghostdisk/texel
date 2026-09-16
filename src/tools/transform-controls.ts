import type { Editor } from '../editor';
import { IDENTITY, inverse, multiply, transformPoint } from '../model/geometry';
import type { Matrix, Point, Rect } from '../model/geometry';
import type { ToolPointer } from './tool';
import { ROTATE_CURSOR } from './cursors';

export interface TransformTarget {
  readonly transform: Matrix;
  readonly parent: {
    worldTransform(): Matrix;
  } | null;
  worldTransform(): Matrix;
  localBounds(): Rect;
  setTransform(matrix: Matrix): void;
}

export interface TransformChange {
  target: TransformTarget;
  before: Matrix;
  after: Matrix;
  mode: 'move' | 'resize' | 'rotate';
}

export interface TransformControlOptions {
  interiorHit?: boolean;
  preserveAspectByDefault?: boolean;
}

interface TransformGesture {
  layer: TransformTarget;
  before: Matrix;
  parentInverse: Matrix;
  worldInverse: Matrix;
  start: Point;
  startWorld: Point;
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

export class TransformControls {
  private gesture: TransformGesture | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly target: () => TransformTarget,
    private readonly enabled: () => boolean,
    private readonly snapMove?: (target: TransformTarget, matrix: Matrix, pointer: ToolPointer, axis: 'x' | 'y' | null) => Matrix,
    private readonly options: TransformControlOptions = {},
  ) {}

  private contains(layer: TransformTarget, world: Point): boolean {
    try {
      const point = transformPoint(inverse(layer.worldTransform()), world);
      const bounds = layer.localBounds();
      return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
    } catch { return false; }
  }

  private handlePoint(layer: TransformTarget, handle: Point): Point {
    const bounds = layer.localBounds();
    const local = { x: bounds.x + (handle.x + 1) * bounds.width / 2, y: bounds.y + (handle.y + 1) * bounds.height / 2 };
    return this.editor.viewport.worldToScreen(transformPoint(layer.worldTransform(), local));
  }

  private rotationPoint(layer: TransformTarget): Point {
    const top = this.handlePoint(layer, { x: 0, y: -1 });
    const center = this.handlePoint(layer, { x: 0, y: 0 });
    const length = Math.max(1, Math.hypot(top.x - center.x, top.y - center.y));
    return { x: top.x + (top.x - center.x) * 26 / length, y: top.y + (top.y - center.y) * 26 / length };
  }

  private hitHandle(layer: TransformTarget, screen: Point): Point | 'rotate' | null {
    const near = (point: Point) => Math.hypot(point.x - screen.x, point.y - screen.y) <= 9;
    if (near(this.rotationPoint(layer))) return 'rotate';
    return HANDLES.find((handle) => near(this.handlePoint(layer, handle))) ?? null;
  }

  private resizeCursor(layer: TransformTarget, handle: Point): string {
    const [a, b, c, d] = layer.worldTransform();
    const xLength = Math.hypot(a, b) || 1;
    const yLength = Math.hypot(c, d) || 1;
    const x = handle.x * a / xLength + handle.y * c / yLength;
    const y = handle.x * b / xLength + handle.y * d / yLength;
    const direction = Math.round(Math.atan2(y, x) / (Math.PI / 4));
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][((direction % 4) + 4) % 4];
  }

  pointerDown(pointer: ToolPointer): boolean {
    if (!this.enabled()) return false;
    const layer = this.target();
    const handle = this.hitHandle(layer, pointer.screen);
    if (!handle && !this.hitBody(layer, pointer)) return false;
    const parentInverse = inverse(layer.parent?.worldTransform() ?? IDENTITY);
    const start = transformPoint(parentInverse, pointer.world);
    const bounds = layer.localBounds();
    const center = transformPoint(layer.transform, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    this.gesture = {
      layer, before: [...layer.transform], parentInverse, worldInverse: inverse(layer.worldTransform()), start, startWorld: pointer.world,
      startLocal: transformPoint(inverse(layer.worldTransform()), pointer.world),
      mode: handle === 'rotate' ? 'rotate' : handle ? 'resize' : 'move',
      handle: handle && handle !== 'rotate' ? handle : { x: 0, y: 0 }, bounds, center,
      angle: Math.atan2(start.y - center.y, start.x - center.x),
    };
    return true;
  }

  private hitBody(layer: TransformTarget, pointer: ToolPointer): boolean {
    if (!this.contains(layer, pointer.world)) return false;
    if (this.options.interiorHit ?? true) return true;
    const bounds = layer.localBounds();
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    const scale = Math.max(0.0001, this.editor.viewport.scale);
    const edge = 7 / scale;
    return Math.min(Math.abs(point.x - bounds.x), Math.abs(point.y - bounds.y),
      Math.abs(point.x - bounds.x - bounds.width), Math.abs(point.y - bounds.y - bounds.height)) <= edge;
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const current = transformPoint(gesture.parentInverse, pointer.world);
    const before = gesture.before;
    let matrix: Matrix;
    if (gesture.mode === 'move') {
      if (this.snapMove) {
        let dx = pointer.world.x - gesture.startWorld.x;
        let dy = pointer.world.y - gesture.startWorld.y;
        let axis: 'x' | 'y' | null = null;
        if (pointer.shift) {
          if (Math.abs(dx) > Math.abs(dy)) { dy = 0; axis = 'x'; }
          else { dx = 0; axis = 'y'; }
        }
        const parentWorld = gesture.layer.parent?.worldTransform() ?? IDENTITY;
        matrix = multiply(inverse(parentWorld), multiply([1, 0, 0, 1, dx, dy], multiply(parentWorld, before)));
        if (!pointer.alt) matrix = this.snapMove(gesture.layer, matrix, pointer, axis);
      } else {
        let dx = current.x - gesture.start.x;
        let dy = current.y - gesture.start.y;
        if (pointer.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        matrix = [before[0], before[1], before[2], before[3], before[4] + dx, before[5] + dy];
      }
    } else if (gesture.mode === 'resize') {
      const currentLocal = transformPoint(gesture.worldInverse, pointer.world);
      const { bounds, handle } = gesture;
      const factor = pointer.alt ? 2 : 1;
      const anchor = pointer.alt ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } :
        { x: bounds.x + (1 - handle.x) * bounds.width / 2, y: bounds.y + (1 - handle.y) * bounds.height / 2 };
      let sx = handle.x ? 1 + (currentLocal.x - gesture.startLocal.x) * factor / (bounds.width * handle.x) : 1;
      let sy = handle.y ? 1 + (currentLocal.y - gesture.startLocal.y) * factor / (bounds.height * handle.y) : 1;
      if ((this.options.preserveAspectByDefault ?? true) !== pointer.shift && handle.x && handle.y) {
        const scale = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
        sx = scale;
        sy = scale;
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

  finish(): TransformChange | null {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture || gesture.before.every((value, index) => value === gesture.layer.transform[index])) return null;
    return { target: gesture.layer, before: gesture.before, after: [...gesture.layer.transform], mode: gesture.mode };
  }

  cancel(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture) gesture.layer.setTransform(gesture.before);
  }

  get active(): boolean { return !!this.gesture; }

  wantsPointer(pointer: ToolPointer): boolean {
    if (!this.enabled()) return false;
    const layer = this.target();
    return !!this.hitHandle(layer, pointer.screen) || this.hitBody(layer, pointer);
  }

  hover(pointer: ToolPointer | null): void {
    this.editor.brushCursor.hidden = true;
    if (!pointer || this.editor.panHeld) return;
    const layer = this.target();
    const handle = this.enabled() ? this.hitHandle(layer, pointer.screen) : null;
    this.editor.canvas.style.cursor = handle === 'rotate' ? ROTATE_CURSOR : handle ? this.resizeCursor(layer, handle) :
      this.enabled() && this.hitBody(layer, pointer) ? 'move' : 'default';
  }

  drawOverlay(controls = true): void {
    const layer = this.target();
    const overlay = this.editor.overlay;
    const add = (tag: string, attributes: Record<string, string | number>) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      overlay.append(node);
    };
    const corners = [HANDLES[0], HANDLES[2], HANDLES[4], HANDLES[6]].map((handle) => this.handlePoint(layer, handle));
    add('polygon', { points: corners.map((point) => `${point.x},${point.y}`).join(' '), class: controls && this.enabled() ? 'transform-outline' : 'selection-outline' });
    if (!controls || !this.enabled()) return;
    const top = this.handlePoint(layer, { x: 0, y: -1 });
    const rotation = this.rotationPoint(layer);
    add('line', { x1: top.x, y1: top.y, x2: rotation.x, y2: rotation.y, class: 'transform-outline' });
    for (const handle of HANDLES) {
      const point = this.handlePoint(layer, handle);
      add('rect', { x: point.x - 4, y: point.y - 4, width: 8, height: 8, class: 'transform-handle' });
    }
    add('circle', { cx: rotation.x, cy: rotation.y, r: 5, class: 'transform-handle' });
  }

}
