export interface GenerationModelCapabilities {
  inputImages: number;
  mask: boolean;
  negativePrompt: boolean;
  steps: boolean;
  guidance: boolean;
  seed: boolean;
  denoiseStrength: boolean;
  partialPreview: boolean;
  maxDimension?: number;
}

export interface GenerationModel {
  id: string;
  label: string;
  source: string;
  capabilities: GenerationModelCapabilities;
  task?: 'generate' | 'remove';
}

export interface GenerationSource {
  id: string;
  label: string;
}

export interface GenerationRequest {
  operation?: 'remove';
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
  input: Uint8Array<ArrayBuffer> | null;
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
  readonly label: string;
  models(): Promise<readonly GenerationModel[]>;
  generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob>;
}

export class GenerationModelRegistry {
  private readonly providers = new Map<string, GenerationProvider>();
  private readonly entries = new Map<string, GenerationModel>();

  register(provider: GenerationProvider): void {
    if (this.providers.has(provider.source)) throw new Error('Duplicate image provider: ' + provider.source);
    this.providers.set(provider.source, provider);
  }

  async refresh(): Promise<readonly GenerationModel[]> {
    const results = await Promise.allSettled([...this.providers.values()].map(async (provider) => ({ provider, models: await provider.models() })));
    this.entries.clear();
    let failure: unknown = null;
    for (const result of results) {
      if (result.status === 'rejected') { failure ??= result.reason; continue; }
      for (const model of result.value.models) {
        if (model.source !== result.value.provider.source || !model.id.startsWith(model.source + '/')) continue;
        this.entries.set(model.id, model);
      }
    }
    if (!this.entries.size && failure) throw failure;
    return this.models();
  }

  models(source?: string): readonly GenerationModel[] {
    return [...this.entries.values()].filter((model) => !source || model.source === source);
  }

  sources(): readonly GenerationSource[] {
    return [...this.providers.values()].filter((provider) => this.models(provider.source).some((model) => model.task !== 'remove'))
      .map((provider) => ({ id: provider.source, label: provider.label }));
  }

  model(id: string): GenerationModel | undefined { return this.entries.get(id); }

  provider(model: string): GenerationProvider {
    const entry = this.entries.get(model);
    const provider = entry && this.providers.get(entry.source);
    if (!provider) throw new Error('Unknown image model: ' + model);
    return provider;
  }
}
