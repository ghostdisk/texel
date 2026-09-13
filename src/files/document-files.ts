import type { Editor } from '../editor';
import type { EditorDocument } from '../editor-document';
import { TxlFormat } from './txl';
import type { LoadedDocument } from './txl';
import { multiply } from '../model/geometry';

export class DocumentFiles {
  busy = false;
  private lastWindowState = '';
  private readonly requestedFiles: DocumentFileHandle[] = [];
  private idle = Promise.resolve();
  private releaseIdle: (() => void) | null = null;
  private readonly format: TxlFormat;

  constructor(private readonly editor: Editor) {
    this.format = new TxlFormat(editor.gpu, editor.compositor, editor.filters);
    window.desktop.onCloseRequest(() => { void this.closeWindow().catch(editor.report); });
  }

  listenForOpenRequests(): void {
    window.desktop.onOpenRequest((files) => {
      this.requestedFiles.push(...files);
      void this.openNextRequestedFile().catch(this.editor.report);
    });
    void window.desktop.documentReady().catch(this.editor.report);
  }

  private async openNextRequestedFile(): Promise<void> {
    if (!this.requestedFiles.length) return;
    await this.exclusive(async () => {
      const file = this.requestedFiles.shift();
      if (file) await this.loadFile(file);
    });
  }

  whenIdle(): Promise<void> { return this.idle; }

  get name(): string { return this.editor.document.name; }
  get dirty(): boolean { return this.editor.document.dirty; }

  reset(): void {
    this.editor.document.fileHandle = null;
    this.editor.document.name = 'Untitled';
    this.editor.document.savedState = this.editor.history.stateId;
    this.sync();
  }

  sync(): void {
    if (this.requestedFiles.length && !this.busy && !this.editor.editingPixels) {
      queueMicrotask(() => { void this.openNextRequestedFile().catch(this.editor.report); });
    }
    const state = { name: this.name, dirty: this.dirty };
    const signature = JSON.stringify(state);
    document.title = this.name + (this.dirty ? ' *' : '') + ' — Texel';
    if (signature === this.lastWindowState) return;
    this.lastWindowState = signature;
    this.editor.onDocumentsChange?.();
    void window.desktop.setDocumentState(state).catch(this.editor.report);
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.busy || this.editor.editingPixels) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!this.editor.halted) this.editor.finishGesture();
    this.busy = true;
    this.idle = new Promise<void>((resolve) => { this.releaseIdle = resolve; });
    const app = document.getElementById('app');
    const wasInert = app?.inert ?? false;
    if (app) { app.inert = true; app.setAttribute('aria-busy', 'true'); }
    try { this.editor.changed(); return await work(); }
    finally {
      this.busy = false;
      this.releaseIdle?.();
      this.releaseIdle = null;
      if (app) { app.inert = wasInert || this.editor.halted; app.removeAttribute('aria-busy'); }
      this.editor.changed();
    }
  }

  async newDocument(width: number, height: number): Promise<void> {
    await this.exclusive(async () => { this.editor.createDocument(width, height); });
  }

  async open(): Promise<void> {
    await this.exclusive(async () => {
      const file = await window.desktop.openDocument();
      if (file) await this.loadFile(file);
    });
  }

  private async loadFile(file: DocumentFileHandle): Promise<void> {
    const placeholder = this.editor.documents.length === 1 && !this.editor.document.fileHandle &&
      !this.editor.document.dirty && this.editor.document.name === 'Untitled' ? this.editor.document : null;
    const bytes = await window.desktop.readDocument(file.token);
    let loaded: LoadedDocument | null = await this.format.decode(bytes);
    try {
      const document = this.editor.addLoadedDocument(loaded);
      loaded = null;
      document.fileHandle = file;
      document.name = file.name;
      document.savedState = document.history.stateId;
      if (placeholder) this.editor.closeDocument(placeholder);
      this.editor.changed();
    } finally { if (loaded) this.editor.compositor.release(loaded.root); }
  }

  async save(saveAs = false): Promise<void> { await this.exclusive(() => this.saveCurrent(saveAs)); }

  async exportImage(format: ImageExportFormat): Promise<void> {
    await this.exclusive(async () => {
      const baseName = this.name.replace(/\.txl$/i, '') || 'Untitled';
      const handle = await window.desktop.chooseImageExport(format, baseName);
      if (!handle) return;
      this.editor.flushPaint();
      const source = this.editor.compositor.captureDocument(this.editor.image.root, this.editor.image.frame);
      try {
        const bytes = await this.editor.readback.rgba(source, false, true);
        const canvas = document.createElement('canvas');
        canvas.width = this.editor.image.width;
        canvas.height = this.editor.image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create an image export canvas.');
        const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        const mime = format === 'png' ? 'image/png' : 'image/webp';
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime));
        if (!blob) throw new Error(`Could not encode the ${format.toUpperCase()} image.`);
        await window.desktop.writeImageExport(handle.token, new Uint8Array(await blob.arrayBuffer()));
      } finally { source.texture.destroy(); }
    });
  }

  private async saveCurrent(saveAs: boolean, document = this.editor.document): Promise<boolean> {
    if (document !== this.editor.document) this.editor.activateDocument(document);
    const handle = await window.desktop.chooseDocumentSave(document.fileHandle?.token ?? null, saveAs);
    if (!handle) return false;
    if (!this.editor.halted) this.editor.finishGesture();
    this.editor.flushPaint();
    const state = this.editor.history.stateId;
    const lens = this.editor.generation.lens;
    const bounds = lens.localBounds();
    const transform = multiply(lens.transform, [bounds.width / this.editor.image.width, 0, 0, bounds.height / this.editor.image.height, 0, 0]);
    const bytes = await this.format.encode(this.editor.image, transform);
    await window.desktop.writeDocument(handle.token, bytes);
    document.fileHandle = handle;
    document.name = handle.name;
    // Track the captured state so later asynchronous edits remain unsaved.
    document.savedState = state;
    this.editor.changed();
    return true;
  }

  private async confirmDocument(document: EditorDocument): Promise<boolean> {
    if (document !== this.editor.document) this.editor.activateDocument(document);
    if (!this.editor.halted) this.editor.finishGesture();
    while (document.dirty) {
      const choice = await window.desktop.confirmDocumentSave(document.name);
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true;
      if (!await this.saveCurrent(false, document)) return false;
    }
    return true;
  }

  async closeDocument(document = this.editor.document): Promise<void> {
    await this.exclusive(async () => {
      if (!this.editor.documents.includes(document) || !await this.confirmDocument(document)) return;
      this.editor.closeDocument(document);
    });
  }

  private async closeWindow(): Promise<void> {
    await this.exclusive(async () => {
      for (const document of [...this.editor.documents]) if (!await this.confirmDocument(document)) return;
      this.editor.generation.cancel();
      this.editor.disposeDocuments();
      await window.desktop.closeDocumentWindow();
    });
  }
}
