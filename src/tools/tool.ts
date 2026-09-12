import type { Editor } from '../editor';
import type { Point } from '../model/geometry';
import type { UndoDirection, UndoOperation, UndoTarget } from '../history/undo';

export interface ToolPointer {
  screen: Point;
  world: Point;
  pressure: number;
  shift: boolean;
  ctrl: boolean;
}

export abstract class Tool implements UndoTarget {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly cursor: string;
  abstract readonly hint: string;

  constructor(protected readonly editor: Editor) {}

  abstract pointerDown(pointer: ToolPointer): void;
  abstract pointerMove(pointer: ToolPointer): void;
  abstract finish(): void;
  abstract cancel(): void;
  abstract drawUI(container: HTMLElement): void;
  abstract applyUndo(operation: UndoOperation, direction: UndoDirection): void;
  drawOverlay(): void {}
  hover(_pointer: ToolPointer | null): void {}
}
