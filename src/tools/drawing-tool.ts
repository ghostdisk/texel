import type { BrushStamp } from '../gpu/brush';
import type { MaskInput } from '../gpu/mask';
import type { Surface } from '../gpu/surface';
import { UndoOperation } from '../history/undo';
import type { UndoDirection } from '../history/undo';
import type { Point } from '../model/geometry';
import { ImageLayer } from '../model/layers';
import { Tool } from './tool';

interface DrawingGesture {
  layer: ImageLayer;
  before: string;
  snapshots: Map<string, Surface>;
  selection: MaskInput | null;
  erase: boolean;
}

/** Painting tools share their target, selection clipping, erase mode, and pixel undo. */
export abstract class DrawingTool extends Tool {
  override readonly supportsDrawingModes = true;
  protected drawing: DrawingGesture | null = null;

  protected beginDrawing(): ImageLayer | null {
    const layer = this.editor.paintTarget;
    if (!layer) return null;
    const snapshots = new Map<string, Surface>();
    let selection: MaskInput | null = null;
    try {
      selection = this.editor.captureSelection(layer);
      const before = this.editor.image.capturePixels(layer, snapshots);
      this.drawing = { layer, before, snapshots, selection, erase: this.editor.eraseMode };
      return layer;
    } catch (error) {
      selection?.surface.texture.destroy();
      for (const snapshot of snapshots.values()) snapshot.texture.destroy();
      throw error;
    }
  }

  protected paint(stamp: BrushStamp): void {
    const drawing = this.drawing;
    if (drawing) this.editor.paint(drawing.layer, stamp, drawing.erase, drawing.selection);
  }

  protected paintPath(points: readonly Point[], opacity: number): void {
    const drawing = this.drawing;
    if (!drawing) return;
    const color = this.editor.drawingColor(drawing.layer, opacity);
    this.editor.compositor.enqueue(drawing.layer, this.editor.paths.operation(points, color, drawing.erase, drawing.selection));
  }

  protected restoreBeforePreview(): void {
    if (!this.drawing) return;
    this.editor.flushPaint();
    this.drawing.layer.restorePixels(this.editor.gpu, this.drawing.snapshots.get(this.drawing.before)!);
  }

  finish(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    this.drawing = null;
    try {
      const after = this.editor.image.capturePixels(drawing.layer, drawing.snapshots);
      this.editor.history.push(new UndoOperation(
        `${drawing.erase ? 'Erase with' : 'Draw with'} ${this.label.toLowerCase()}${drawing.layer.isSelection ? ' on selection' : ''}`,
        { type: 'tool', targetId: this.id, action: 'pixels', data: { layerId: drawing.layer.id, snapshotId: drawing.before } },
        { type: 'tool', targetId: this.id, action: 'pixels', data: { layerId: drawing.layer.id, snapshotId: after } },
        drawing.snapshots,
      ));
    } catch (error) {
      drawing.layer.restorePixels(this.editor.gpu, drawing.snapshots.get(drawing.before)!);
      for (const snapshot of drawing.snapshots.values()) snapshot.texture.destroy();
      throw error;
    } finally { drawing.selection?.surface.texture.destroy(); }
  }

  cancel(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    this.drawing = null;
    try {
      this.editor.flushPaint();
      drawing.layer.restorePixels(this.editor.gpu, drawing.snapshots.get(drawing.before)!);
    } finally {
      for (const snapshot of drawing.snapshots.values()) snapshot.texture.destroy();
      drawing.selection?.surface.texture.destroy();
    }
  }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id || payload.action !== 'pixels') throw new Error('Unsupported drawing undo operation.');
    const layer = this.editor.image.find(String(payload.data.layerId));
    if (!(layer instanceof ImageLayer)) throw new Error('Drawing undo requires a pixel layer.');
    layer.restorePixels(this.editor.gpu, operation.snapshot(String(payload.data.snapshotId)));
    this.editor.image.selected = layer;
  }
}
