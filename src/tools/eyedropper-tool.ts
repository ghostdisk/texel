import type { Editor } from '../editor';
import type { Point } from '../model/geometry';
import type { UndoDirection, UndoOperation } from '../history/undo';
import { Tool } from './tool';
import type { ToolPointer } from './tool';

export class EyedropperTool extends Tool {
  readonly id = 'eyedropper';
  readonly label = 'Eyedropper';
  readonly cursor = 'crosshair';
  readonly hint = '';
  private pending: Point | null = null;
  private reading = false;
  private generation = 0;

  constructor(editor: Editor) { super(editor); }

  pointerDown(pointer: ToolPointer): void { this.sample(pointer.world); }
  pointerMove(pointer: ToolPointer): void { this.sample(pointer.world); }

  private sample(point: Point): void {
    this.pending = point;
    if (!this.reading) void this.drain().catch(this.editor.report);
  }

  private async drain(): Promise<void> {
    this.reading = true;
    try {
      while (this.pending) {
        const point = this.pending;
        this.pending = null;
        const generation = this.generation;
        const documentId = this.editor.image.id;
        const color = await this.editor.sampleColor(point);
        if (this.editor.halted || generation !== this.generation || documentId !== this.editor.image.id || !color) continue;
        const hex = '#' + color.slice(0, 3).map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
        this.editor.setBrushColor(hex, true);
      }
    } finally { this.reading = false; }
  }

  finish(): void {}
  cancel(): void { this.generation++; this.pending = null; }
  drawUI(_container: HTMLElement): void {}
  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }
  applyUndo(_operation: UndoOperation, _direction: UndoDirection): void { throw new Error('Eyedropper changes do not edit the document.'); }
}

