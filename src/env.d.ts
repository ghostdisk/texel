interface DocumentFileHandle {
  token: string;
  name: string;
}

interface ImportedImage {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface GenerationEndpoint {
  url?: string;
  token?: string;
  protocol?: number;
  error?: string;
}

interface Window {
  desktop: {
    openMenu(label: string, x: number, y: number): Promise<void>;
    openImage(): Promise<ImportedImage | null>;
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
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}
