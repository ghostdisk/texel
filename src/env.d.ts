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
    openImage(): Promise<ImportedImage | null>;
    generationBackend(): Promise<GenerationEndpoint>;
    restartGenerationBackend(): Promise<GenerationEndpoint>;
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}