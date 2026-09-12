import type { Editor } from '../editor';
import type { Surface } from '../gpu/surface';
import { UndoOperation } from '../history/undo';
import type { UndoDirection } from '../history/undo';
import { ImageLayer } from '../model/layers';
import { inverse, maxScale, transformPoint } from '../model/geometry';
import type { Point } from '../model/geometry';
import { Tool } from './tool';
import { SliderInput } from '../ui/slider-input';
import type { ToolPointer } from './tool';

interface BrushGesture {
  layer: ImageLayer;
  last: Point;
  before: string;
  snapshots: Map<string, Surface>;
}

export class BrushTool extends Tool {
  readonly id = 'brush';
  readonly label = 'Brush';
  readonly cursor = 'crosshair';
  readonly hint = 'Paint on a pixel layer · Hold Space to pan · Scroll to zoom';
  size = 36;
  hardness = 0.8;
  flow = 1;
  color = '#7357ff';
  private gesture: BrushGesture | null = null;

  constructor(editor: Editor) { super(editor); }

  pointerDown(pointer: ToolPointer): void {
    const layer = this.editor.image.selected;
    if (!(layer instanceof ImageLayer)) return;
    const point = transformPoint(inverse(layer.worldTransform()), pointer.world);
    const snapshots = new Map<string, Surface>();
    const before = this.editor.image.capturePixels(layer, snapshots);
    this.gesture = { layer, last: point, before, snapshots };
    this.stamp(point, pointer.pressure);
  }

  pointerMove(pointer: ToolPointer): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const point = transformPoint(inverse(gesture.layer.worldTransform()), pointer.world);
    const spacing = Math.max(0.25, this.size * Math.max(0.05, pointer.pressure) * 0.1);
    let distance = Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y);
    while (distance >= spacing) {
      const amount = spacing / distance;
      gesture.last = { x: gesture.last.x + (point.x - gesture.last.x) * amount, y: gesture.last.y + (point.y - gesture.last.y) * amount };
      this.stamp(gesture.last, pointer.pressure);
      distance = Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y);
    }
  }

  private stamp(point: Point, pressure: number): void {
    const rgb = [1, 3, 5].map((offset) => {
      const value = parseInt(this.color.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    this.editor.paint(this.gesture!.layer, {
      x: point.x, y: point.y, radius: this.size * Math.max(0.05, pressure) / 2, hardness: this.hardness,
      color: [rgb[0], rgb[1], rgb[2], this.flow],
    });
  }

  finish(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    try {
      const after = this.editor.image.capturePixels(gesture.layer, gesture.snapshots);
      this.editor.history.push(new UndoOperation(
        'Brush stroke',
        { type: 'tool', targetId: this.id, action: 'pixels', data: { layerId: gesture.layer.id, snapshotId: gesture.before } },
        { type: 'tool', targetId: this.id, action: 'pixels', data: { layerId: gesture.layer.id, snapshotId: after } },
        gesture.snapshots,
      ));
    } catch (error) {
      gesture.layer.restorePixels(this.editor.gpu, gesture.snapshots.get(gesture.before)!);
      for (const snapshot of gesture.snapshots.values()) snapshot.texture.destroy();
      throw error;
    }
  }

  cancel(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.editor.flushPaint();
    gesture.layer.restorePixels(this.editor.gpu, gesture.snapshots.get(gesture.before)!);
    for (const snapshot of gesture.snapshots.values()) snapshot.texture.destroy();
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id || payload.action !== 'pixels') throw new Error('Unsupported brush undo operation.');
    const layer = this.editor.image.find(String(payload.data.layerId));
    if (!(layer instanceof ImageLayer)) throw new Error('Brush undo requires a pixel layer.');
    layer.restorePixels(this.editor.gpu, operation.snapshot(String(payload.data.snapshotId)));
    this.editor.image.selected = layer;
  }

  hover(pointer: ToolPointer | null): void {
    const cursor = this.editor.brushCursor;
    const layer = this.editor.image.selected;
    cursor.hidden = !pointer || !(layer instanceof ImageLayer) || this.editor.panHeld;
    if (cursor.hidden || !pointer) return;
    const diameter = this.size * maxScale(layer.worldTransform()) * this.editor.viewport.scale;
    cursor.style.left = `${pointer.screen.x}px`;
    cursor.style.top = `${pointer.screen.y}px`;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
  }

  drawUI(container: HTMLElement): void {
    const add = (label: string, key: 'size' | 'hardness' | 'flow', min: number, max: number, step: number, unit: string) => {
      const factor = key === 'size' ? 1 : 100;
      const control = new SliderInput({
        label, min, max, step, unit, get: () => this[key] * factor,
        input: (value) => { this[key] = value / factor; },
      });
      control.element.classList.add('brush-slider');
      container.append(control.element);
    };
    add('Size', 'size', 1, 400, 1, 'px');
    add('Hardness', 'hardness', 0, 100, 1, '%');
    add('Flow', 'flow', 1, 100, 1, '%');
  }
}