interface ImportedImage {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

interface Window {
  desktop: {
    openImage(): Promise<ImportedImage | null>;
  };
}
