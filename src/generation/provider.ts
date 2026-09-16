export interface GenerationModelRatings {
  affordability: number | null;
  speed: number | null;
  quality: number | null;
  provisional?: string[];
  qualityScope?: string;
}

export interface GenerationSizeBucket {
  width: number;
  height: number;
  value?: string;
}

export interface GenerationSizeConstraints {
  minAspectRatio?: number;
  maxAspectRatio?: number;
  aspectRatios?: string[];
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minShortSide?: number;
  maxShortSide?: number;
  minLongSide?: number;
  maxLongSide?: number;
  minPixels?: number;
  maxPixels?: number;
  shortSideBuckets?: number[];
  pixelAreaBuckets?: number[];
  sizeBuckets?: GenerationSizeBucket[];
  outputSizeBuckets?: GenerationSizeBucket[];
  granularity?: number | { width: number; height: number };
}

export interface GenerationExpandConstraints {
  maxPerSide?: number;
  maxPixels?: number;
  aspectRatios?: string[];
  outputSizeBuckets?: GenerationSizeBucket[];
  centered?: boolean;
  fitSource?: boolean;
}

export interface GenerationExpansion {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type GenerationModelType =
  | 'general-editing'
  | 'generate-from-image'
  | 'fill-inpaint'
  | 'background-removal'
  | 'object-removal-mask'
  | 'object-removal-prompt'
  | 'expand-reframe'
  | 'restore'
  | 'upscale'
  | 'lighting-color'
  | 'style-transform'
  | 'subject-product'
  | 'selection-analysis'
  | 'structure-extraction';

export interface GenerationModelCapabilities {
  inputImages: number;
  minimumInputImages?: number;
  prompt?: boolean;
  mask: boolean;
  maskRequired?: boolean;
  negativePrompt: boolean;
  steps: boolean;
  guidance: boolean;
  seed: boolean;
  denoiseStrength: boolean;
  partialPreview: boolean;
  size?: GenerationSizeConstraints;
  expand?: GenerationExpandConstraints;
}

export interface GenerationModel {
  id: string;
  label: string;
  displayName?: string;
  platform: string;
  platformName?: string;
  publisher?: string;
  publisherName?: string;
  capabilities: GenerationModelCapabilities;
  ratings?: GenerationModelRatings;
  tags?: string[];
  types?: GenerationModelType[];
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
  expand?: GenerationExpansion;
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
  generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob>;
}

export class GenerationModelRegistry {
  private readonly providers = new Map<string, GenerationProvider>();
  private readonly owners = new Map<string, string>();
  private readonly contributed = new Map<string, { model: GenerationModel; owner: string }>();
  private readonly entries = new Map<string, GenerationModel>();

  register(provider: GenerationProvider, owner = 'texel-editor/core'): void {
    if (this.providers.has(provider.platform)) throw new Error('Duplicate generation platform: ' + provider.platform);
    this.providers.set(provider.platform, provider);
    this.owners.set(provider.platform, owner);
  }

  registerModel(model: GenerationModel, owner = 'texel-editor/core'): void {
    const provider = this.providers.get(model.platform);
    if (!provider || !model.id.startsWith(model.platform + '/')) throw new Error('Model provider is unavailable: ' + model.platform);
    if (this.contributed.has(model.id)) throw new Error('Duplicate generation model: ' + model.id);
    this.contributed.set(model.id, { model, owner });
    this.entries.set(model.id, this.registered(model, provider));
  }

  unregisterOwner(owner: string): void {
    const platforms = [...this.owners].filter(([, candidate]) => candidate === owner).map(([platform]) => platform);
    for (const platform of platforms) {
      this.providers.delete(platform);
      this.owners.delete(platform);
      for (const [id, model] of this.entries) if (model.platform === platform) this.entries.delete(id);
    }
    for (const [id, contribution] of this.contributed) {
      if (contribution.owner !== owner) continue;
      this.contributed.delete(id);
      this.entries.delete(id);
    }
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
    const ratings = model.ratings;
    const parts = model.id.split('/');
    const publisher = parts.length > 2 ? parts[1] : model.platform;
    return {
      ...model,
      displayName: this.displayName(model),
      platformName: provider.label,
      publisher,
      publisherName: this.prettyIdentifier(publisher),
      ratings,
      tags: [...new Set(model.tags ?? [])],
      types: [...new Set(model.types ?? ['general-editing'])],
    };
  }

  async refresh(): Promise<readonly GenerationModel[]> {
    const results = await Promise.allSettled([...this.providers.values()].map(async (provider) => ({ provider, models: await provider.models() })));
    const entries = new Map<string, GenerationModel>();
    let failure: unknown = null;
    for (const result of results) {
      if (result.status === 'rejected') { failure ??= result.reason; continue; }
      for (const model of result.value.models) {
        if (model.platform !== result.value.provider.platform || !model.id.startsWith(model.platform + '/')) continue;
        entries.set(model.id, this.registered(model, result.value.provider));
      }
    }
    for (const { model } of this.contributed.values()) {
      const provider = this.providers.get(model.platform);
      if (provider) entries.set(model.id, this.registered(model, provider));
    }
    if (!entries.size && failure) throw failure;
    this.entries.clear();
    for (const [id, model] of entries) this.entries.set(id, model);
    return this.models();
  }

  models(platform?: string): readonly GenerationModel[] {
    return [...this.entries.values()].filter((model) => !platform || model.platform === platform);
  }

  model(id: string): GenerationModel | undefined { return this.entries.get(id); }

  private providerForModel(id: string): GenerationProvider | undefined {
    const separator = id.indexOf('/');
    return separator > 0 ? this.providers.get(id.slice(0, separator)) : undefined;
  }

  provider(model: string): GenerationProvider {
    const entry = this.entries.get(model);
    const provider = entry ? this.providerForModel(entry.id) : undefined;
    if (!provider) throw new Error('Unknown image model: ' + model);
    return provider;
  }
}

export const generationModelRegistry = new GenerationModelRegistry();
