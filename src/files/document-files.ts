import type { Editor } from '../editor';
import type { EditorDocument } from '../editor-document';
import { TxlFormat } from './txl';
import type { LoadedDocument } from './txl';
import { importImage } from '../gpu/images';
import { GroupLayer } from '../model/layers';
import { IDENTITY } from '../model/geometry';
import { DEFAULT_GRID_SIZE } from '../model/precision';
import { DEFAULT_EXPORT_SETTINGS } from '../model/export';
import type { ExportLocation, ExportSettings } from '../model/export';
import type { Surface } from '../gpu/surface';

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|avif|bmp|gif)$/i;

export class DocumentFiles {
  busy = false;
  private lastWindowState = '';
  private readonly requestedFiles: DocumentFileHandle[] = [];
  private recentFiles: DocumentFileHandle[] = [];
  private rememberRecentFiles = true;
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
    void this.refreshRecent().catch(this.editor.report);
    void window.desktop.documentReady().catch(this.editor.report);
  }

  get recentEnabled(): boolean { return this.rememberRecentFiles; }
  get recentCount(): number { return this.recentFiles.length; }
  recentLabel(index: number): string { return this.recentFiles[index]?.name ?? ''; }

  setRememberRecentFiles(enabled: boolean): void {
    if (enabled === this.rememberRecentFiles) return;
    this.rememberRecentFiles = enabled;
    if (!enabled) {
      this.recentFiles = [];
      this.editor.changed();
    } else void this.refreshRecent().catch(this.editor.report);
  }

  async refreshRecent(): Promise<void> {
    this.recentFiles = this.rememberRecentFiles ? (await window.desktop.recentDocuments()).slice(0, 10) : [];
    this.editor.changed();
  }

  private async openNextRequestedFile(): Promise<void> {
    if (!this.requestedFiles.length) return;
    await this.exclusive(async () => {
      const file = this.requestedFiles.shift();
      if (file) await this.loadFile(file);
    });
  }

  whenIdle(): Promise<void> { return this.idle; }

  get name(): string { return this.editor.activeDocument?.name ?? 'Texel'; }
  get dirty(): boolean { return this.editor.activeDocument?.dirty ?? false; }

  reset(): void {
    this.editor.document.fileHandle = null;
    this.editor.document.name = 'Untitled';
    this.editor.document.markSaved();
    this.sync();
  }

  sync(): void {
    if (this.requestedFiles.length && !this.busy && !this.editor.editingPixels) {
      queueMicrotask(() => { void this.openNextRequestedFile().catch(this.editor.report); });
    }
    const state = { name: this.name, dirty: this.dirty };
    const signature = JSON.stringify(state);
    document.title = this.editor.hasDocument ? this.name + (this.dirty ? ' *' : '') + ' — Texel' : 'Texel';
    if (signature === this.lastWindowState) return;
    this.lastWindowState = signature;
    this.editor.onDocumentsChange?.();
    void window.desktop.setDocumentState(state).catch(this.editor.report);
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.busy || this.editor.editingPixels) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!this.editor.halted && this.editor.hasDocument) this.editor.finishGesture();
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

  async openRecent(index: number): Promise<void> {
    const file = this.recentFiles[index];
    if (file) await this.exclusive(() => this.loadFile(file));
  }

  async removeRecent(index: number): Promise<void> {
    const file = this.recentFiles[index];
    if (!file) return;
    await window.desktop.forgetDocument(file.token);
    await this.refreshRecent();
  }

  async openDroppedImages(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith('image/') || IMAGE_EXTENSION.test(file.name));
    if (!images.length) return;
    await this.exclusive(async () => {
      for (const file of images) {
        let loaded: LoadedDocument | null = await this.decodeImage(file.name, new Uint8Array(await file.arrayBuffer()));
        try {
          const document = this.editor.addLoadedDocument(loaded);
          loaded = null;
          document.fileHandle = null;
          document.name = file.name;
          document.markSaved();
          this.editor.changed();
        } finally { if (loaded) this.editor.compositor.release(loaded.root); }
      }
    });
  }

  private async loadFile(file: DocumentFileHandle): Promise<void> {
    const bytes = await window.desktop.readDocument(file.token);
    let loaded: LoadedDocument | null = IMAGE_EXTENSION.test(file.name) ? await this.decodeImage(file.name, bytes) : await this.format.decode(bytes);
    try {
      const document = this.editor.addLoadedDocument(loaded);
      loaded = null;
      document.fileHandle = IMAGE_EXTENSION.test(file.name) ? null : file;
      document.name = file.name;
      document.markSaved();
      this.editor.changed();
      if (this.rememberRecentFiles) {
        await window.desktop.rememberDocument(file.token);
        await this.refreshRecent();
      }
    } finally { if (loaded) this.editor.compositor.release(loaded.root); }
  }

  private async decodeImage(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<LoadedDocument> {
    const layer = await importImage(this.editor.gpu, this.editor.compositor.quads, name, new Blob([bytes]));
    const root = new GroupLayer('Document');
    root.add(layer);
    return {
      root, width: layer.width, height: layer.height, selection: { ids: [layer.id], active: layer.id },
      activeSelectionId: null, generationLens: IDENTITY, precision: { gridSize: DEFAULT_GRID_SIZE, guides: [] },
      exportSettings: structuredClone(DEFAULT_EXPORT_SETTINGS),
    };
  }

  async save(saveAs = false): Promise<void> { await this.exclusive(() => this.saveCurrent(saveAs)); }

  async chooseExportLocation(settings: ExportSettings): Promise<ExportLocation | null> {
    const current = settings.location?.key ?? null;
    const documentToken = this.editor.document.fileHandle?.token ?? null;
    const handle = settings.mode === 'single' ?
      await window.desktop.chooseImageExport(settings.format, this.name.replace(/\.(?:txl|png|jpe?g|webp|avif|bmp|gif)$/i, '') || 'Untitled', current, documentToken) :
      await window.desktop.chooseImageExportDirectory(current, documentToken);
    return handle ? { key: handle.token, name: handle.name } : null;
  }

  setExportSettings(settings: ExportSettings): void {
    const previous = this.editor.document.exportSettings;
    if (previous.mode === settings.mode && previous.format === settings.format && previous.scale === settings.scale &&
      previous.location?.key === settings.location?.key && previous.location?.name === settings.location?.name) return;
    this.editor.document.exportSettings = structuredClone(settings);
    this.editor.document.metadataChanged();
    this.editor.changed();
  }

  async quickExport(): Promise<void> {
    if (!this.editor.document.exportSettings.location) { this.editor.onExport?.(); return; }
    try { await this.exportConfigured(); }
    catch (error) {
      if (error instanceof Error && error.message === 'Choose an export location first.') {
        this.editor.document.exportSettings.location = null;
        this.editor.document.metadataChanged();
        this.editor.onExport?.();
        return;
      }
      throw error;
    }
  }

  async exportConfigured(): Promise<void> {
    await this.exclusive(async () => {
      const settings = this.editor.document.exportSettings;
      if (!settings.location) throw new Error('Choose an export location first.');
      this.editor.flushPaint();
      if (settings.mode === 'single') {
        const source = this.editor.compositor.captureDocument(this.editor.image.root, this.editor.image.frame, settings.scale);
        try { await window.desktop.writeImageExport(settings.location.key, await this.encodeImage(source, settings.format)); }
        finally { source.destroy(); }
        this.editor.onNotify?.(`Exported ${settings.location.name}`);
        return;
      }
      const layers = this.editor.image.root.children.filter((layer) => layer.visibleInStack && layer.opacity > 0);
      if (!layers.length) throw new Error('There are no visible top-level layers to export.');
      const names = new Set<string>();
      for (const layer of layers) {
        const source = this.editor.compositor.captureLayer(this.editor.image.root, layer, settings.scale);
        try {
          const base = this.exportName(layer.name);
          let name = base, suffix = 2;
          while (names.has(name.toLocaleLowerCase())) name = `${base}-${suffix++}`;
          names.add(name.toLocaleLowerCase());
          const bytes = await this.encodeImage(source, settings.format);
          await window.desktop.writeImageExportDirectory(settings.location.key, name, settings.format, bytes);
        } finally { source.destroy(); }
      }
      this.editor.onNotify?.(`Exported ${layers.length} frame${layers.length === 1 ? '' : 's'} to ${settings.location.name}`);
    });
  }

  private exportName(name: string): string {
    const cleaned = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180).replace(/[. ]+$/, '') || 'Layer';
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? '_' + cleaned : cleaned;
  }

  private async encodeImage(source: Surface, format: ImageExportFormat): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await this.editor.readback.rgba(source, false, true);
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create an image export canvas.');
    const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
    const mime = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
    if (!blob) throw new Error(`Could not encode the ${format.toUpperCase()} image.`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  private async saveCurrent(saveAs: boolean, document = this.editor.document): Promise<boolean> {
    if (document !== this.editor.document) this.editor.activateDocument(document);
    const handle = await window.desktop.chooseDocumentSave(document.fileHandle?.token ?? null, saveAs);
    if (!handle) return false;
    if (!this.editor.halted) this.editor.finishGesture();
    this.editor.flushPaint();
    const state = this.editor.history.stateId;
    const metadataState = document.metadataState;
    const bytes = await this.format.encode(this.editor.image, this.editor.generators.lens.transform, document.exportSettings);
    await window.desktop.writeDocument(handle.token, bytes);
    if (this.rememberRecentFiles) {
      await window.desktop.rememberDocument(handle.token);
      await this.refreshRecent();
    }
    document.fileHandle = handle;
    document.name = handle.name;
    // Track the captured state so later asynchronous edits remain unsaved.
    document.markSaved(state, metadataState);
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

  async closeDocument(document = this.editor.activeDocument): Promise<void> {
    if (!document) return;
    await this.exclusive(async () => {
      if (!this.editor.documents.includes(document) || !await this.confirmDocument(document)) return;
      this.editor.closeDocument(document);
    });
  }

  private async closeWindow(): Promise<void> {
    await this.exclusive(async () => {
      for (const document of [...this.editor.documents]) if (!await this.confirmDocument(document)) return;
      this.editor.generators.close();
      this.editor.disposeDocuments();
      await window.desktop.closeDocumentWindow();
    });
  }
}
