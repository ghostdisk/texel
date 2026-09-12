import type { Point, Rect } from './model/geometry';

export class Viewport {
  scale = 1;
  offset: Point = { x: 0, y: 0 };
  width = 1;
  height = 1;
  onChange?: () => void;

  screenToWorld(point: Point): Point { return { x: (point.x - this.offset.x) / this.scale, y: (point.y - this.offset.y) / this.scale }; }
  worldToScreen(point: Point): Point { return { x: point.x * this.scale + this.offset.x, y: point.y * this.scale + this.offset.y }; }
  bounds(): Rect { return { ...this.screenToWorld({ x: 0, y: 0 }), width: this.width / this.scale, height: this.height / this.scale }; }

  resize(width: number, height: number): void {
    this.offset.x += (width - this.width) / 2;
    this.offset.y += (height - this.height) / 2;
    this.width = width;
    this.height = height;
    this.onChange?.();
  }

  fit(frame: Rect): void {
    this.scale = Math.max(0.001, Math.min((this.width - 72) / frame.width, (this.height - 72) / frame.height));
    this.offset = { x: (this.width - frame.width * this.scale) / 2 - frame.x * this.scale, y: (this.height - frame.height * this.scale) / 2 - frame.y * this.scale };
    this.onChange?.();
  }

  zoomAt(point: Point, factor: number): void {
    const world = this.screenToWorld(point);
    this.scale = Math.min(64, Math.max(0.001, this.scale * factor));
    this.offset = { x: point.x - world.x * this.scale, y: point.y - world.y * this.scale };
    this.onChange?.();
  }

  pan(dx: number, dy: number): void { this.offset.x += dx; this.offset.y += dy; this.onChange?.(); }
}
