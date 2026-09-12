import { Tool } from './tool';
import type { ToolPointer } from './tool';
import type { UndoDirection, UndoOperation } from '../history/undo';
import { GenerationPanel } from '../ui/generation-panel';

export class GenerationTool extends Tool {
  readonly id = 'generation';
  readonly label = 'Generate image';
  readonly cursor = 'default';
  readonly hint = '';

  pointerDown(_pointer: ToolPointer): void {}
  pointerMove(_pointer: ToolPointer): void {}
  finish(): void {}
  cancel(): void {}
  hover(_pointer: ToolPointer | null): void { this.editor.brushCursor.hidden = true; }
  drawUI(container: HTMLElement): void { new GenerationPanel(this.editor, container); }
  applyUndo(_operation: UndoOperation, _direction: UndoDirection): void { throw new Error('Generation undo belongs to the layer.'); }
}
