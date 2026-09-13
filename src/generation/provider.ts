import modelRatings from './model-ratings.json';

export interface GenerationModelRatings {
  affordability: number;
  speed: number;
  quality: number;
  provisional?: string[];
  qualityScope?: string;
}

export interface GenerationModelCapabilities {
  inputImages: number;
  mask: boolean;
  negativePrompt: boolean;
  steps: boolean;
  guidance: boolean;
  seed: boolean;
  denoiseStrength: boolean;
  partialPreview: boolean;
  dimensionMultiple?: number;
  maxDimension?: number;
  maxShortDimension?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
}

export interface GenerationModel {
  id: string;
  label: string;
  displayName?: string;
  source: string;
  capabilities: GenerationModelCapabilities;
  ratings?: GenerationModelRatings;
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

  private displayName(model: GenerationModel): string {
    const candidate = model.label && model.label !== model.id ? model.label : model.id.split('/').at(-1)!;
    const withoutProvider = candidate.replace(/^[^:]+:\s*/, '');
    if (/\s/.test(withoutProvider)) return withoutProvider;
    const words: Record<string, string> = { ai: 'AI', gpt: 'GPT', flux: 'FLUX', vae: 'VAE' };
    return withoutProvider.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_-]+/)
      .map((word) => words[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  private registered(model: GenerationModel): GenerationModel {
    const ratings = (modelRatings as Record<string, GenerationModelRatings>)[model.id];
    return { ...model, displayName: this.displayName(model), ratings };
  }

  async refresh(): Promise<readonly GenerationModel[]> {
    const results = await Promise.allSettled([...this.providers.values()].map(async (provider) => ({ provider, models: await provider.models() })));
    this.entries.clear();
    let failure: unknown = null;
    for (const result of results) {
      if (result.status === 'rejected') { failure ??= result.reason; continue; }
      for (const model of result.value.models) {
        if (model.source !== result.value.provider.source || !model.id.startsWith(model.source + '/')) continue;
        this.entries.set(model.id, this.registered(model));
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
