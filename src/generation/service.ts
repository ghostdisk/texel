import { generationModelRegistry } from './provider';
import type { GenerationModel, GenerationProvider } from './provider';

export class AIRequestService {
  readonly registry = generationModelRegistry;
  error = '';
  onChange?: () => void;
  get models(): readonly GenerationModel[] { return this.registry.models(); }

  async refreshModels(): Promise<readonly GenerationModel[]> {
    try {
      this.error = '';
      await this.registry.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.onChange?.();
    return this.models;
  }

  provider(model: GenerationModel): GenerationProvider { return this.registry.provider(model.id); }
}
