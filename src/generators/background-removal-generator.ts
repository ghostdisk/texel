import type { GenerationModel, GenerationModelType } from '../generation/provider';
import { Generator } from './generator';

export class BackgroundRemovalGenerator extends Generator {
  readonly id = 'background-removal';
  readonly label = 'Remove background';
  readonly resultName = 'Background removed';
  readonly modelTypes: readonly GenerationModelType[] = ['background-removal'];

  protected override get requiresPrompt(): boolean { return false; }

  protected override defaultModel(models: readonly GenerationModel[]): GenerationModel | undefined {
    return models.find((model) => model.id.endsWith('/ideogram/remove-background')) ?? models[0];
  }

  run(): Promise<void> { return this.generate(); }

  renderSpecific(_container: HTMLElement): void {}
}
