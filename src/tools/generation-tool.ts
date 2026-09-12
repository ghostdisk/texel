import type { Editor } from '../editor';
import { Tool } from './tool';
import type { ToolPointer } from './tool';
import type { Matrix } from '../model/geometry';
import type { UndoDirection, UndoOperation } from '../history/undo';
import { GenerationPanel } from '../ui/generation-panel';
import { TransformControls } from './transform-controls';

export class GenerationTool extends Tool {
  readonly id = 'generation';
  readonly label = 'Generate image';
  readonly cursor = 'default';
  readonly hint = '';
  private readonly controls: TransformControls;

  constructor(editor: Editor) {
    super(editor);
    this.controls = new TransformControls(editor, () => editor.generation.displayLens, () => !editor.generation.busy);
  }

  pointerDown(pointer: ToolPointer): void { this.controls.pointerDown(pointer); }
  pointerMove(pointer: ToolPointer): void { this.controls.pointerMove(pointer); }
  finish(): void {
    const change = this.controls.finish();
    if (change) this.editor.generation.recordLensTransform(change.before);
  }
  cancel(): void { this.controls.cancel(); }
  hover(pointer: ToolPointer | null): void { this.controls.hover(pointer); }
  drawOverlay(): void { this.controls.drawOverlay(); }
  drawUI(container: HTMLElement): void { new GenerationPanel(this.editor, container); }

  applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    const payload = operation.payload(direction);
    if (payload.type !== 'tool' || payload.targetId !== this.id || payload.action !== 'lens-transform') throw new Error('Unsupported generation undo operation.');
    this.editor.generation.lens.setTransform(payload.data.transform as unknown as Matrix);
  }
}