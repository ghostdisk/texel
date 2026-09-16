import type { Editor } from '../editor';
import type { Point, Rect } from '../model/geometry';
import type { ToolPointer } from './tool';

export interface EditablePoint<T = null> extends Point {
  id: string;
  data: T;
}

export interface PointEditorOptions<T> {
  changed(points: readonly EditablePoint<T>[]): void;
  createData(pointer: ToolPointer): T;
  bounds?(): Rect;
  radius?: number;
}

/** Reusable canvas point creation, dragging, removal, and overlay rendering. */
export class PointEditor<T = null> {
  private readonly values: EditablePoint<T>[] = [];
  private dragging: EditablePoint<T> | null = null;

  constructor(private readonly editor: Editor, private readonly options: PointEditorOptions<T>) {}

  get points(): readonly EditablePoint<T>[] { return this.values; }

  pointerDown(pointer: ToolPointer): void {
    const hit = this.hit(pointer.screen);
    if (pointer.button !== 0) return;
    if (hit) {
      this.dragging = hit;
      this.editor.requestRender();
      return;
    }
    const world = this.constrain(pointer.world);
    if (!world) return;
    this.dragging = { id: crypto.randomUUID(), ...world, data: this.options.createData(pointer) };
    this.values.push(this.dragging);
    this.notify();
  }

  secondaryClick(pointer: ToolPointer): boolean {
    const hit = this.hit(pointer.screen);
    if (!hit) return false;
    this.values.splice(this.values.indexOf(hit), 1);
    if (this.dragging === hit) this.dragging = null;
    this.notify();
    return true;
  }

  pointerMove(pointer: ToolPointer): void {
    if (!this.dragging || pointer.button === 2) return;
    const world = this.constrain(pointer.world);
    if (!world || world.x === this.dragging.x && world.y === this.dragging.y) return;
    this.dragging.x = world.x;
    this.dragging.y = world.y;
    this.notify();
  }

  finish(): void { this.dragging = null; this.editor.requestRender(); }
  cancel(): void { this.finish(); }

  clear(notify = false): void {
    this.dragging = null;
    this.values.length = 0;
    if (notify) this.notify();
    else this.editor.requestRender();
  }

  drawOverlay(): void {
    const namespace = this.editor.overlay.namespaceURI;
    for (const point of this.values) {
      const screen = this.editor.viewport.worldToScreen(point);
      const group = document.createElementNS(namespace, 'g');
      group.classList.add('point-editor-point');
      if (point === this.dragging) group.classList.add('active');
      group.setAttribute('transform', `translate(${screen.x} ${screen.y})`);
      const outer = document.createElementNS(namespace, 'circle');
      outer.setAttribute('r', '7');
      const inner = document.createElementNS(namespace, 'circle');
      inner.setAttribute('r', '3');
      group.append(outer, inner);
      this.editor.overlay.append(group);
    }
  }

  private hit(screen: Point): EditablePoint<T> | null {
    const radius = this.options.radius ?? 11;
    let closest: EditablePoint<T> | null = null, distance = radius;
    for (const point of this.values) {
      const position = this.editor.viewport.worldToScreen(point);
      const candidate = Math.hypot(screen.x - position.x, screen.y - position.y);
      if (candidate <= distance) { closest = point; distance = candidate; }
    }
    return closest;
  }

  private constrain(point: Point): Point | null {
    const bounds = this.options.bounds?.();
    if (!bounds) return point;
    if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) return null;
    return point;
  }

  private notify(): void {
    this.options.changed(this.values);
    this.editor.requestRender();
  }
}
