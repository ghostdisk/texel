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

interface StoredSettings {
  theme: string;
  canvasBackground: string | null;
  rememberRecentFiles: boolean;
}

interface WindowTheme {
  dark: boolean;
  background: string;
}

interface ApplicationInfo {
  name: string;
  version: string;
  license: string;
}

interface Window {
  texel: import('./package-runtime').TexelRendererGlobal;
  desktop: {
    openMenu(label: string, x: number, y: number): Promise<void>;
    openContextMenu(items: import('./actions').MenuAction[], x: number, y: number): Promise<void>;
    isWindowMaximized(): Promise<boolean>;
    appInfo(): Promise<ApplicationInfo | null>;
    openRepository(): Promise<boolean>;
    onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void;
    openImage(): Promise<ImportedImage | null>;
    writeClipboard(value: {
      metadata: string;
      image: Uint8Array<ArrayBuffer> | null;
    }): Promise<boolean>;
    readClipboard(): Promise<{
      metadata: string;
      image: Uint8Array<ArrayBuffer> | null;
      mediaType: string;
    } | null>;
    chooseImageExport(format: ImageExportFormat, name: string): Promise<ImageExportHandle | null>;
    writeImageExport(token: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
    openDocument(): Promise<DocumentFileHandle | null>;
    recentDocuments(): Promise<DocumentFileHandle[]>;
    rememberDocument(token: string): Promise<void>;
    forgetDocument(token: string): Promise<void>;
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
    listPackages(): Promise<import('./package-runtime').PackageManifest[]>;
    invokePackage(packageName: string, message: string, ...args: unknown[]): Promise<unknown>;
    packageSettings(): Promise<import('./package-runtime').PackageSettingGroup[]>;
    setPackageSetting(packageName: string, key: string, value: unknown): Promise<unknown>;
    onPackageMessage(callback: (message: import('./package-runtime').PackageMessage) => void): () => void;
    getSettings(): Promise<StoredSettings | null>;
    updateSettings(settings: StoredSettings): Promise<StoredSettings | null>;
    setWindowTheme(theme: WindowTheme): Promise<void>;
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}
