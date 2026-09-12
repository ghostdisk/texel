interface ImportedImage {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface Window {
  desktop: {
    openImage(): Promise<ImportedImage | null>;
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}
