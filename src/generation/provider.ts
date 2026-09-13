import modelRatings from './model-ratings.json';
import falModelRatings from './fal-model-ratings.json';

export interface GenerationModelRatings {
  affordability: number | null;
  speed: number | null;
  quality: number | null;
  provisional?: string[];
  qualityScope?: string;
}

export interface GenerationModelCapabilities {
  inputImages: number;
  minimumInputImages?: number;
  mask: boolean;
  maskRequired?: boolean;
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
  ratingId?: string;
  label: string;
  displayName?: string;
  platform: string;
  platformName?: string;
  publisher?: string;
  publisherName?: string;
  capabilities: GenerationModelCapabilities;
  ratings?: GenerationModelRatings;
  task?: 'generate' | 'remove';
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
  readonly platform: string;
  readonly label: string;
  models(): Promise<readonly GenerationModel[]>;
  resolveModel?(id: string): Promise<GenerationModel>;
  generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob>;
}

export class GenerationModelRegistry {
  private readonly providers = new Map<string, GenerationProvider>();
  private readonly entries = new Map<string, GenerationModel>();

  register(provider: GenerationProvider): void {
    if (this.providers.has(provider.platform)) throw new Error('Duplicate generation platform: ' + provider.platform);
    this.providers.set(provider.platform, provider);
  }

  private prettyIdentifier(value: string): string {
    const known: Record<string, string> = {
      openai: 'OpenAI', 'black-forest-labs': 'Black Forest Labs', 'bytedance-seed': 'ByteDance Seed',
      'x-ai': 'xAI', qwen: 'Qwen', krea: 'Krea', local: 'Local',
    };
    if (known[value.toLowerCase()]) return known[value.toLowerCase()];
    const words: Record<string, string> = { ai: 'AI', gpt: 'GPT', flux: 'FLUX', vae: 'VAE' };
    return value.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_-]+/)
      .map((word) => words[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  private displayName(model: GenerationModel): string {
    const candidate = model.label && model.label !== model.id ? model.label : model.id.split('/').at(-1)!;
    const withoutProvider = candidate.replace(/^[^:]+:\s*/, '');
    if (/\s/.test(withoutProvider)) return withoutProvider;
    return this.prettyIdentifier(withoutProvider);
  }

  private registered(model: GenerationModel, provider: GenerationProvider): GenerationModel {
    const ratings = (modelRatings as Record<string, GenerationModelRatings>)[model.id] ??
      (falModelRatings as Record<string, GenerationModelRatings>)[model.ratingId ?? ''];
    const parts = model.id.split('/');
    const publisher = parts.length > 2 ? parts[1] : model.platform;
    return {
      ...model,
      displayName: this.displayName(model),
      platformName: provider.label,
      publisher,
      publisherName: this.prettyIdentifier(publisher),
      ratings,
    };
  }

  async refresh(): Promise<readonly GenerationModel[]> {
    const results = await Promise.allSettled([...this.providers.values()].map(async (provider) => ({ provider, models: await provider.models() })));
    this.entries.clear();
    let failure: unknown = null;
    for (const result of results) {
      if (result.status === 'rejected') { failure ??= result.reason; continue; }
      for (const model of result.value.models) {
        if (model.platform !== result.value.provider.platform || !model.id.startsWith(model.platform + '/')) continue;
        this.entries.set(model.id, this.registered(model, result.value.provider));
      }
    }
    if (!this.entries.size && failure) throw failure;
    return this.models();
  }

  models(platform?: string): readonly GenerationModel[] {
    return [...this.entries.values()].filter((model) => !platform || model.platform === platform);
  }

  model(id: string): GenerationModel | undefined { return this.entries.get(id); }

  async resolve(id: string): Promise<GenerationModel> {
    const current = this.entries.get(id);
    const provider = current && this.providers.get(current.platform);
    if (!current || !provider) throw new Error('Unknown image model: ' + id);
    if (!provider.resolveModel) return current;
    const resolved = await provider.resolveModel(id);
    if (resolved.id !== id || resolved.platform !== provider.platform) throw new Error('Image provider returned an invalid model.');
    const registered = this.registered(resolved, provider);
    this.entries.set(id, registered);
    return registered;
  }

  provider(model: string): GenerationProvider {
    const entry = this.entries.get(model);
    const provider = entry && this.providers.get(entry.platform);
    if (!provider) throw new Error('Unknown image model: ' + model);
    return provider;
  }
}
