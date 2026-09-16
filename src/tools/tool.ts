import type { Editor } from '../editor';
import type { Point } from '../model/geometry';
import type { UndoDirection, UndoOperation, UndoTarget } from '../history/undo';

export interface ToolPointer {
  screen: Point;
  world: Point;
  button: number;
  pressure: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export abstract class Tool implements UndoTarget {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly cursor: string;
  abstract readonly hint: string;
  readonly supportsDrawingModes = false;
  readonly supportsAltEyedropper = false;
  readonly coalescedPointerMoves = true;
  readonly popup = false;
  readonly temporary = false;

  constructor(protected readonly editor: Editor) {}

  abstract pointerDown(pointer: ToolPointer): void;
  abstract pointerMove(pointer: ToolPointer): void;
  abstract finish(): void;
  abstract cancel(): void;
  abstract drawUI(container: HTMLElement): void;
  abstract applyUndo(operation: UndoOperation, direction: UndoDirection): void;
  activate(): void {}
  deactivate(): void {}
  drawOverlay(): void {}
  syncUI(): void {}
  drawPopup(_container: HTMLElement): void {}
  syncPopup(): void {}
  secondaryClick(_pointer: ToolPointer): boolean { return false; }
  hover(_pointer: ToolPointer | null): void {}
}
