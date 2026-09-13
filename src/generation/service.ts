import { FalGenerationProvider } from './fal-provider';
import { LocalGenerationProvider } from './local-provider';
import { OpenRouterGenerationProvider } from './openrouter-provider';
import { GenerationModelRegistry } from './provider';
import type { GenerationEvents, GenerationModel, GenerationRequest } from './provider';

export class AIRequestService {
  readonly registry = new GenerationModelRegistry();
  models: readonly GenerationModel[] = [];
  error = '';
  onChange?: () => void;

  constructor() {
    this.registry.register(new LocalGenerationProvider());
    this.registry.register(new OpenRouterGenerationProvider());
    this.registry.register(new FalGenerationProvider());
  }

  async refreshModels(): Promise<readonly GenerationModel[]> {
    try {
      this.error = '';
      this.models = await this.registry.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.onChange?.();
    return this.models;
  }

  async resolveModel(id: string): Promise<GenerationModel> {
    const resolved = await this.registry.resolve(id);
    this.models = this.models.map((model) => model.id === id ? resolved : model);
    this.onChange?.();
    return resolved;
  }

  request(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob> {
    return this.registry.provider(request.model).generate(request, events, signal);
  }
}
