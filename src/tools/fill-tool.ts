import { SpanFill } from '../gpu/span-fill';
import type { Surface } from '../gpu/surface';
import { inverse, transformPoint } from '../model/geometry';
import { SliderInput } from '../ui/slider-input';
import { DrawingTool } from './drawing-tool';
import type { ToolPointer } from './tool';

export class FillTool extends DrawingTool {
  readonly id = 'fill';
  readonly label = 'Fill';
  readonly cursor = 'crosshair';
  readonly hint = 'Fill matching pixels · Escape cancels a pending fill';
  private renderer: SpanFill | null = null;
  private pending: AbortController | null = null;
  private status: HTMLElement | null = null;
  private tolerance = 0.1;
  private opacity = 1;
  private contiguous = true;

  pointerDown(pointer: ToolPointer): void {
    const layer = this.editor.paintTarget;
    if (!layer || this.pending || this.opacity === 0) return;
    const local = transformPoint(inverse(layer.worldTransform()), pointer.world);
    const point = { x: Math.floor(local.x), y: Math.floor(local.y) };
    if (point.x < 0 || point.y < 0 || point.x >= layer.width || point.y >= layer.height) return;
    void this.editor.editPixels(async () => {
      if (this.editor.paintTarget !== layer || !this.beginDrawing() || !this.drawing) return;
      const drawing = this.drawing;
      const documentId = this.editor.image.id;
      const source = layer.source;
      const revision = layer.revision;
      const world = layer.worldTransform();
      const controller = new AbortController();
      this.pending = controller;
      if (this.status) this.status.textContent = 'Filling… · Escape cancels';
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        controller.abort();
      };
      window.addEventListener('keydown', escape, true);
      let coverage: Surface | undefined;
      let painted = false;
      try {
        this.renderer ??= new SpanFill(this.editor.gpu);
        coverage = await this.renderer.region(drawing.snapshots.get(drawing.before)!, point, this.tolerance, this.contiguous, drawing.selection, controller.signal);
        controller.signal.throwIfAborted();
        if (this.editor.image.id !== documentId || !this.editor.image.allLayers().includes(layer) || layer.source !== source || layer.revision !== revision ||
          layer.worldTransform().some((value, index) => value !== world[index])) throw new Error('The layer changed while filling. Retry the fill.');
        this.editor.compositor.enqueue(layer, this.editor.paths.coverageOperation(coverage, this.editor.drawingColor(layer, this.opacity), drawing.erase, drawing.selection));
        painted = true;
        this.editor.flushPaint();
        super.finish();
      } catch (error) {
        if (painted) super.cancel();
        else {
          this.drawing = null;
          drawing.selection?.surface.texture.destroy();
          for (const snapshot of drawing.snapshots.values()) snapshot.texture.destroy();
        }
        if (!controller.signal.aborted) throw error;
      } finally {
        coverage?.texture.destroy();
        this.pending = null;
        if (this.status) this.status.textContent = '';
        window.removeEventListener('keydown', escape, true);
      }
    }).catch(this.editor.report);
  }

  pointerMove(_pointer: ToolPointer): void {}
  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }
  finish(): void {}
  cancel(): void { if (this.pending) this.pending.abort(); else super.cancel(); }

  drawUI(container: HTMLElement): void {
    container.append(new SliderInput({
      label: 'Tolerance', min: 0, max: 100, step: 1, unit: '%', get: () => this.tolerance * 100,
      input: (value) => { this.tolerance = value / 100; },
    }).element, new SliderInput({
      label: 'Opacity', min: 0, max: 100, step: 1, unit: '%', get: () => this.opacity * 100,
      input: (value) => { this.opacity = value / 100; },
    }).element);
    const label = document.createElement('label');
    label.className = 'tool-checkbox';
    const contiguous = document.createElement('input');
    contiguous.type = 'checkbox';
    contiguous.checked = this.contiguous;
    contiguous.onchange = () => { this.contiguous = contiguous.checked; };
    label.append(contiguous, document.createTextNode('Contiguous'));
    this.status = document.createElement('span');
    this.status.className = 'tool-status';
    this.status.setAttribute('role', 'status');
    container.append(label, this.status);
  }
}
