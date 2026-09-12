import type { Editor } from '../editor';
import { TxlFormat } from './txl';
import type { LoadedDocument } from './txl';
import { multiply } from '../model/geometry';

export class DocumentFiles {
  name = 'Untitled';
  busy = false;
  private handle: DocumentFileHandle | null = null;
  private savedState: string;
  private lastWindowState = '';
  private readonly requestedFiles: DocumentFileHandle[] = [];
  private idle = Promise.resolve();
  private releaseIdle: (() => void) | null = null;
  private readonly format: TxlFormat;

  constructor(private readonly editor: Editor) {
    this.savedState = editor.history.stateId;
    this.format = new TxlFormat(editor.gpu, editor.compositor, editor.filters);
    window.desktop.onCloseRequest(() => { void this.close().catch(editor.report); });
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

  get dirty(): boolean { return this.editor.history.stateId !== this.savedState; }

  reset(): void {
    this.handle = null;
    this.name = 'Untitled';
    this.savedState = this.editor.history.stateId;
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
    await this.exclusive(async () => {
      if (await this.confirmReplacement()) this.editor.reset(width, height);
    });
  }

  async open(): Promise<void> {
    await this.exclusive(async () => {
      const file = await window.desktop.openDocument();
      if (file) await this.loadFile(file);
    });
  }

  private async loadFile(file: DocumentFileHandle): Promise<void> {
    while (true) {
      if (!await this.confirmReplacement()) return;
      const state = this.editor.history.stateId;
      // Read after a possible Save/Save As, which might have written this same path.
      const bytes = await window.desktop.readDocument(file.token);
      let loaded: LoadedDocument | null = await this.format.decode(bytes);
      try {
        if (state !== this.editor.history.stateId) continue;
        this.editor.loadDocument(loaded);
        loaded = null; // The image now owns these GPU resources.
        this.handle = file;
        this.name = file.name;
        this.savedState = this.editor.history.stateId;
        this.editor.changed();
        return;
      } finally { if (loaded && this.editor.image.root !== loaded.root) this.editor.compositor.release(loaded.root); }
    }
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

  private async saveCurrent(saveAs: boolean): Promise<boolean> {
    const handle = await window.desktop.chooseDocumentSave(this.handle?.token ?? null, saveAs);
    if (!handle) return false;
    if (!this.editor.halted) this.editor.finishGesture();
    this.editor.flushPaint();
    const state = this.editor.history.stateId;
    const lens = this.editor.generation.lens;
    const bounds = lens.localBounds();
    const transform = multiply(lens.transform, [bounds.width / this.editor.image.width, 0, 0, bounds.height / this.editor.image.height, 0, 0]);
    const bytes = await this.format.encode(this.editor.image, transform);
    await window.desktop.writeDocument(handle.token, bytes);
    this.handle = handle;
    this.name = handle.name;
    // Track the captured state so later asynchronous edits remain unsaved.
    this.savedState = state;
    this.editor.changed();
    return true;
  }

  private async confirmReplacement(): Promise<boolean> {
    if (!this.editor.halted) this.editor.finishGesture();
    while (this.dirty) {
      const choice = await window.desktop.confirmDocumentSave(this.name);
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true;
      if (!await this.saveCurrent(false)) return false;
    }
    return true;
  }

  private async close(): Promise<void> {
    await this.exclusive(async () => {
      if (!await this.confirmReplacement()) return;
      this.editor.generation.cancel();
      await window.desktop.closeDocumentWindow();
    });
  }
}
