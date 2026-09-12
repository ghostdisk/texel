import type { Surface } from '../gpu/surface';

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}
export type UndoDirection = 'undo' | 'redo';
export type UndoType = 'image' | 'layer' | 'filter' | 'tool';

export interface UndoPayload {
  type: UndoType;
  targetId: string;
  action: string;
  data: JsonObject;
}

export interface SerializedUndoOperation {
  label: string;
  undo: UndoPayload;
  redo: UndoPayload;
}

/** JSON describes the edit; referenced pixel snapshots remain GPU resources. */
export class UndoOperation {
  constructor(
    readonly label: string,
    readonly undo: UndoPayload,
    readonly redo: UndoPayload,
    readonly snapshots = new Map<string, Surface>(),
  ) {}

  payload(direction: UndoDirection): UndoPayload { return this[direction]; }
  serialize(): SerializedUndoOperation { return structuredClone({ label: this.label, undo: this.undo, redo: this.redo }); }

  static deserialize(json: SerializedUndoOperation, snapshots = new Map<string, Surface>()): UndoOperation {
    const data = structuredClone(json);
    return new UndoOperation(data.label, data.undo, data.redo, snapshots);
  }

  snapshot(id: string): Surface {
    const surface = this.snapshots.get(id);
    if (!surface) throw new Error(`Missing undo pixel snapshot: ${id}`);
    return surface;
  }

  get bytes(): number {
    let bytes = 0;
    for (const surface of this.snapshots.values()) bytes += surface.texture.width * surface.texture.height * 8;
    return bytes;
  }

  dispose(): void {
    for (const surface of this.snapshots.values()) surface.texture.destroy();
    this.snapshots.clear();
  }
}

export interface UndoTarget {
  applyUndo(operation: UndoOperation, direction: UndoDirection): void;
}

export class UndoStack {
  private entries: UndoOperation[] = [];
  private position = 0;
  onChange?: () => void;

  constructor(private readonly apply: (operation: UndoOperation, direction: UndoDirection) => void) {}

  get canUndo(): boolean { return this.position > 0; }
  get canRedo(): boolean { return this.position < this.entries.length; }
  get undoLabel(): string { return this.entries[this.position - 1]?.label ?? ''; }
  get redoLabel(): string { return this.entries[this.position]?.label ?? ''; }

  /** Record an edit already applied by a completed gesture or command. */
  push(operation: UndoOperation): void {
    for (const entry of this.entries.splice(this.position)) entry.dispose();
    this.entries.push(operation);
    this.position = this.entries.length;
    let bytes = this.entries.reduce((total, entry) => total + entry.bytes, 0);
    while (this.entries.length > 1 && (this.entries.length > 100 || bytes > 256 * 1024 * 1024)) {
      const removed = this.entries.shift()!;
      bytes -= removed.bytes;
      removed.dispose();
      this.position--;
    }
    this.onChange?.();
  }

  undo(): void {
    if (!this.canUndo) return;
    this.apply(this.entries[this.position - 1], 'undo');
    this.position--;
    this.onChange?.();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.apply(this.entries[this.position], 'redo');
    this.position++;
    this.onChange?.();
  }

  clear(): void {
    for (const operation of this.entries) operation.dispose();
    this.entries = [];
    this.position = 0;
    this.onChange?.();
  }
}
