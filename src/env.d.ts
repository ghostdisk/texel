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

interface OpenRouterCapabilityDescriptor {
  type: 'enum' | 'range' | 'boolean';
  values?: string[];
  min?: number;
  max?: number;
}

interface OpenRouterKeyStatus {
  configured: boolean;
}

interface OpenRouterModelList {
  data: OpenRouterModelRecord[];
}

interface OpenRouterModelRecord {
  id: string;
  name: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: Record<string, OpenRouterCapabilityDescriptor>;
  supports_streaming?: boolean;
}

interface OpenRouterGenerationRequest {
  id: string;
  model: string;
  prompt: string;
  width: number;
  height: number;
  input: Uint8Array<ArrayBuffer> | null;
  seed?: number;
  stream: boolean;
}

interface OpenRouterGenerationResult {
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
  cost?: number;
}

interface OpenRouterGenerationEvent {
  id: string;
  type: 'preview';
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
}

interface FalKeyStatus {
  configured: boolean;
}

interface FalModelList {
  data: Array<{
    id: string;
    ratingId: string;
    label: string;
    capabilities: import('./generation/provider').GenerationModelCapabilities;
  }>;
}

interface FalGenerationRequest {
  id: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  strength: number;
  seed: number;
  input: Uint8Array<ArrayBuffer>;
  mask: Uint8Array<ArrayBuffer> | null;
}

interface FalGenerationResult {
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
}

interface FalGenerationEvent {
  id: string;
  type: 'progress';
  phase: string;
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
    openRouterKeyStatus(): Promise<OpenRouterKeyStatus | null>;
    setOpenRouterKey(key: string): Promise<OpenRouterKeyStatus | null>;
    openRouterModels(): Promise<OpenRouterModelList | null>;
    openRouterGenerate(request: OpenRouterGenerationRequest): Promise<OpenRouterGenerationResult>;
    cancelOpenRouterGeneration(id: string): Promise<boolean>;
    onOpenRouterGeneration(callback: (event: OpenRouterGenerationEvent) => void): () => void;
    falKeyStatus(): Promise<FalKeyStatus | null>;
    setFalKey(key: string): Promise<FalKeyStatus | null>;
    falModels(): Promise<FalModelList | null>;
    falGenerate(request: FalGenerationRequest): Promise<FalGenerationResult>;
    cancelFalGeneration(id: string): Promise<boolean>;
    onFalGeneration(callback: (event: FalGenerationEvent) => void): () => void;
    getSettings(): Promise<StoredSettings | null>;
    updateSettings(settings: StoredSettings): Promise<StoredSettings | null>;
    setWindowTheme(theme: WindowTheme): Promise<void>;
    setMenus(menus: import('./actions').ActionMenu[]): Promise<void>;
    onAction(callback: (id: string) => void): () => void;
  };
}
