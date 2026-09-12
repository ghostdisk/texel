import type { Editor } from '../editor';
import type { UndoDirection, UndoOperation } from '../history/undo';
import { Tool } from './tool';
import type { ToolPointer } from './tool';
import { EYEDROPPER_CURSOR } from './cursors';

export class EyedropperTool extends Tool {
  readonly id = 'eyedropper';
  readonly label = 'Eyedropper';
  readonly cursor = EYEDROPPER_CURSOR;
  readonly hint = '';
  private pendingHover: ToolPointer | null = null;
  private pendingPick: ToolPointer | null = null;
  private hovered: ToolPointer | null = null;
  private sampledColor: string | null = null;
  private reading = false;
  private scheduled = 0;
  private generation = 0;
  private readonly preview = document.createElement('div');
  private readonly currentSwatch = document.createElement('span');
  private readonly hoverSwatch = document.createElement('span');

  constructor(editor: Editor) {
    super(editor);
    this.preview.className = 'eyedropper-preview';
    this.preview.hidden = true;
    this.preview.setAttribute('aria-hidden', 'true');
    this.currentSwatch.className = 'eyedropper-current';
    this.hoverSwatch.className = 'eyedropper-hover';
    this.preview.append(this.currentSwatch, this.hoverSwatch);
    editor.stage.append(this.preview);
  }

  pointerDown(pointer: ToolPointer): void { this.pick(pointer); }
  pointerMove(pointer: ToolPointer): void { this.pick(pointer); }

  private pick(pointer: ToolPointer): void {
    this.hover(pointer);
    this.pendingPick = pointer;
    this.schedule();
  }

  private schedule(): void {
    if (this.reading || this.scheduled || (!this.pendingPick && !this.pendingHover)) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      void this.read().catch(this.editor.report);
    });
  }

  private async read(): Promise<void> {
    const pick = !!this.pendingPick;
    const pointer = this.pendingPick ?? this.pendingHover;
    if (!pointer) return;
    if (pick) this.pendingPick = null;
    if (!pick || (this.pendingHover?.world.x === pointer.world.x && this.pendingHover.world.y === pointer.world.y)) {
      this.pendingHover = null;
    }
    const generation = this.generation;
    const documentId = this.editor.image.id;
    this.reading = true;
    try {
      const color = await this.editor.sampleColor(pointer.world);
      if (this.editor.halted || generation !== this.generation || documentId !== this.editor.image.id) return;
      const hex = color ? '#' + color.slice(0, 3).map((value) =>
        Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('') : null;
      if (pick && hex) this.editor.setBrushColor(hex, true);
      if (this.hovered?.world.x === pointer.world.x && this.hovered.world.y === pointer.world.y) {
        this.sampledColor = hex;
        this.updatePreview();
      }
    } finally {
      this.reading = false;
      this.schedule();
    }
  }

  private updatePreview(): void {
    const pointer = this.hovered;
    this.preview.hidden = !pointer || this.editor.activeTool !== this || this.editor.panHeld || this.editor.halted;
    if (this.preview.hidden || !pointer) return;
    this.currentSwatch.style.backgroundColor = this.editor.primaryColor;
    this.hoverSwatch.style.backgroundColor = this.sampledColor ?? 'transparent';
    const { width, height } = this.editor.viewport;
    const x = pointer.screen.x + 18 + 66 <= width ? pointer.screen.x + 18 : pointer.screen.x - 18 - 66;
    const y = pointer.screen.y + 18 + 34 <= height ? pointer.screen.y + 18 : pointer.screen.y - 18 - 34;
    this.preview.style.left = `${Math.max(2, Math.min(width - 68, x))}px`;
    this.preview.style.top = `${Math.max(2, Math.min(height - 36, y))}px`;
  }

  colorsChanged(): void {
    this.generation++;
    this.pendingPick = null;
    this.pendingHover = this.hovered;
    this.updatePreview();
    this.schedule();
  }

  finish(): void {}

  cancel(): void {
    this.generation++;
    this.pendingPick = null;
    this.pendingHover = null;
    this.hovered = null;
    this.sampledColor = null;
    if (this.scheduled) cancelAnimationFrame(this.scheduled);
    this.scheduled = 0;
    this.preview.hidden = true;
  }

  drawUI(_container: HTMLElement): void {}

  hover(pointer: ToolPointer | null): void {
    this.editor.brushCursor.hidden = true;
    const inside = pointer && pointer.screen.x >= 0 && pointer.screen.y >= 0 &&
      pointer.screen.x < this.editor.viewport.width && pointer.screen.y < this.editor.viewport.height;
    this.hovered = inside && !this.editor.panHeld ? pointer : null;
    this.pendingHover = this.hovered;
    if (!this.hovered) this.sampledColor = null;
    this.updatePreview();
    this.schedule();
  }

  applyUndo(_operation: UndoOperation, _direction: UndoDirection): void { throw new Error('Eyedropper changes do not edit the document.'); }
}
