export interface GenerationModel {
  id: string;
  label: string;
  source: string;
}

export interface GenerationRequest {
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

export interface GenerationProgress {
  phase: string;
  step: number;
  steps: number;
  seed?: number;
}

export interface GenerationEvents {
  progress(value: GenerationProgress): void;
  preview(image: Blob): void;
}

export interface GenerationProvider {
  readonly source: string;
  models(): Promise<readonly GenerationModel[]>;
  generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob>;
}

export class GenerationProviders {
  private readonly providers = new Map<string, GenerationProvider>();

  register(provider: GenerationProvider): void {
    if (this.providers.has(provider.source)) throw new Error('Duplicate image provider: ' + provider.source);
    this.providers.set(provider.source, provider);
  }

  async models(): Promise<readonly GenerationModel[]> {
    const lists = await Promise.all([...this.providers.values()].map((provider) => provider.models()));
    return lists.flat();
  }

  provider(model: string): GenerationProvider {
    const provider = this.providers.get(model.split('/')[0]);
    if (!provider) throw new Error('Unknown image provider: ' + model);
    return provider;
  }
}
