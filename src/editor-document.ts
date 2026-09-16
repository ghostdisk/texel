import type { FilterRegistry } from './filters/filter';
import type { Compositor } from './gpu/compositor';
import type { Gpu } from './gpu/device';
import type { MaskRenderer } from './gpu/mask';
import type { LayerReframer } from './gpu/reframe';
import type { UndoDirection, UndoOperation } from './history/undo';
import { UndoStack } from './history/undo';
import { ImageDocument } from './model/image-document';
import type { Matrix } from './model/geometry';
import { Viewport } from './viewport';
import { DEFAULT_EXPORT_SETTINGS } from './model/export';
import type { ExportSettings } from './model/export';

export class EditorDocument {
  readonly id = crypto.randomUUID();
  readonly history: UndoStack;
  readonly image: ImageDocument;
  readonly viewport = new Viewport();
  name = 'Untitled';
  fileHandle: DocumentFileHandle | null = null;
  savedState = '';
  private metadataRevision = 0;
  private savedMetadataRevision = 0;
  exportSettings: ExportSettings = structuredClone(DEFAULT_EXPORT_SETTINGS);
  generationLens: Matrix | null = null;
  selectionMode = false;
  selectionReturnId: string | null = null;
  editedMaskId: string | null = null;
  showGrid = false;
  showGuides = true;
  snapping = true;

  constructor(
    gpu: Gpu, compositor: Compositor, filters: FilterRegistry, reframer: LayerReframer, masks: MaskRenderer, flush: () => void,
    applyUndo: (document: EditorDocument, operation: UndoOperation, direction: UndoDirection) => void,
  ) {
    this.history = new UndoStack((operation, direction) => applyUndo(this, operation, direction));
    this.image = new ImageDocument(gpu, compositor, filters, reframer, masks, this.history, flush);
    this.savedState = this.history.stateId;
  }

  get dirty(): boolean { return this.history.stateId !== this.savedState || this.metadataRevision !== this.savedMetadataRevision; }
  metadataChanged(): void { this.metadataRevision++; }

  markSaved(stateId = this.history.stateId, metadataRevision = this.metadataRevision): void {
    this.savedState = stateId;
    this.savedMetadataRevision = metadataRevision;
  }

  get metadataState(): number { return this.metadataRevision; }

  dispose(compositor: Compositor): void {
    this.image.onChange = undefined;
    this.image.onInvalidated = undefined;
    this.history.onChange = undefined;
    this.viewport.onChange = undefined;
    this.history.clear();
    compositor.release(this.image.root);
  }
}
