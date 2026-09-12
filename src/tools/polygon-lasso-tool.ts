import { inverse, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

const MAX_POINTS = 512;

export class PolygonLassoTool extends DrawingTool {
  readonly id = 'polygon-lasso';
  readonly label = 'Polygon Lasso';
  readonly cursor = 'crosshair';
  readonly hint = 'Click vertices · Enter or double-click applies · Escape cancels';
  opacity = 1;
  private points: Point[] = [];
  private preview: Point | null = null;
  private targetId: string | null = null;
  private pointLabel: HTMLElement | null = null;

  get hasPath(): boolean { return this.points.length > 0; }
  get canApply(): boolean { return this.points.length >= 3; }

  pointerDown(pointer: ToolPointer): void {
    if (!this.points.length) {
      const target = this.editor.paintTarget;
      if (!target) return;
      this.targetId = target.id;
    }
    const closeDistance = 8 / this.editor.viewport.scale;
    if (this.points.length >= 3 && Math.hypot(pointer.world.x - this.points[0].x, pointer.world.y - this.points[0].y) <= closeDistance) {
      this.apply();
      return;
    }
    const last = this.points[this.points.length - 1];
    const duplicate = last && Math.hypot(pointer.world.x - last.x, pointer.world.y - last.y) < 0.5 / this.editor.viewport.scale;
    if (!duplicate && this.points.length < MAX_POINTS) this.points.push({ ...pointer.world });
    this.preview = { ...pointer.world };
    this.sync();
  }

  pointerMove(pointer: ToolPointer): void { this.preview = { ...pointer.world }; this.editor.requestRender(); }

  hover(pointer: ToolPointer | null): void {
    this.editor.brushCursor.hidden = true;
    this.preview = pointer ? { ...pointer.world } : null;
    this.editor.requestRender();
  }

  finish(): void { this.cancel(); }

  cancel(): void {
    this.points = [];
    this.preview = null;
    this.targetId = null;
    super.cancel();
    this.sync();
  }

  apply(): void {
    if (!this.canApply) return;
    if (this.editor.paintTarget?.id !== this.targetId) { this.cancel(); return; }
    const layer = this.beginDrawing();
    if (!layer) { this.cancel(); return; }
    try {
      const worldToLayer = inverse(layer.worldTransform());
      const local = this.points.map((point) => transformPoint(worldToLayer, point));
      this.paintPath(local, this.opacity);
      this.points = [];
      this.preview = null;
      this.targetId = null;
      super.finish();
      this.sync();
    } catch (error) {
      super.cancel();
      this.points = [];
      this.preview = null;
      this.targetId = null;
      this.sync();
      throw error;
    }
  }

  removeLast(): void {
    this.points.pop();
    this.sync();
  }

  drawOverlay(): void {
    if (!this.points.length) return;
    const points = [...this.points, ...(this.preview ? [this.preview] : [])].map((point) => this.editor.viewport.worldToScreen(point));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`);
    path.setAttribute('class', 'lasso-preview');
    path.setAttribute('fill-rule', 'evenodd');
    this.editor.overlay.append(path);
    for (const point of this.points.map((item) => this.editor.viewport.worldToScreen(item))) {
      const vertex = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      vertex.setAttribute('cx', String(point.x));
      vertex.setAttribute('cy', String(point.y));
      vertex.setAttribute('r', '3.5');
      vertex.setAttribute('class', 'lasso-vertex');
      this.editor.overlay.append(vertex);
    }
  }

  drawUI(container: HTMLElement): void {
    container.classList.add('polygon-options');
    container.append(new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', get: () => this.opacity * 100,
      input: (value) => { this.opacity = value / 100; },
    }).element);
    this.pointLabel = document.createElement('span');
    this.pointLabel.className = 'polygon-points';
    container.append(this.pointLabel);
    const apply = document.createElement('button');
    apply.dataset.action = 'polygon.apply';
    apply.textContent = 'Apply';
    apply.onclick = () => this.editor.actions.execute('polygon.apply');
    container.append(apply);
    const cancel = document.createElement('button');
    cancel.dataset.action = 'polygon.cancel';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.editor.actions.execute('polygon.cancel');
    container.append(cancel);
    this.updatePointLabel();
  }

  private sync(): void {
    this.updatePointLabel();
    this.editor.changed();
  }

  private updatePointLabel(): void { if (this.pointLabel) this.pointLabel.textContent = `${this.points.length} points`; }
}
