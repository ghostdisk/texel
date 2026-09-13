interface DocumentFileHandle {
  token: string;
  name: string;
}

interface ImportedImage {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

type ImageExportFormat = 'png' | 'webp';

interface ImageExportHandle {
  token: string;
  name: string;
}

interface GenerationEndpoint {
  url?: string;
  token?: string;
  protocol?: number;
  error?: string;
}

interface StoredSettings {
  theme: string;
  canvasBackground: string | null;
}

interface WindowTheme {
  dark: boolean;
  background: string;
}

interface Window {
  desktop: {
    openMenu(label: string, x: number, y: number): Promise<void>;
    openContextMenu(items: import('./actions').MenuAction[], x: number, y: number): Promise<void>;
    openImage(): Promise<ImportedImage | null>;
    chooseImageExport(format: ImageExportFormat, name: string): Promise<ImageExportHandle | null>;
    writeImageExport(token: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
    openDocument(): Promise<DocumentFileHandle | null>;
    documentReady(): Promise<void>;
    onOpenRequest(callback: (files: DocumentFileHandle[]) => void): () => void;
    readDocument(token: string): Promise<Uint8Array<ArrayBuffer>>;
    chooseDocumentSave(token: string | null, saveAs: boolean): Promise<DocumentFileHandle | null>;
    writeDocument(token: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
    confirmDocumentSave(name: string): Promise<'save' | 'discard' | 'cancel'>;
    setDocumentState(state: {
      name: string;
      dirty: boolean;
    }): Promise<void>;
    closeDocumentWindow(): Promise<void>;
    onCloseRequest(callback: () => void): () => void;
    generationBackend(): Promise<GenerationEndpoint>;
    restartGenerationBackend(): Promise<GenerationEndpoint>;
    getSettings(): Promise<StoredSettings | null>;
    updateSettings(settings: StoredSettings): Promise<StoredSettings | null>;
    setWindowTheme(theme: WindowTheme): Promise<void>;
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}
