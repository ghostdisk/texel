import type { GenerationModelType } from '../generation/provider';
import { Generator } from './generator';

export class ImageGenerator extends Generator {
  readonly id = 'image';
  readonly label = 'Generate image';
  readonly resultName = 'Generated image';
  readonly modelTypes: readonly GenerationModelType[] = ['general-editing', 'generate-from-image'];

  run(): Promise<void> { return this.generate(); }

  renderSpecific(container: HTMLElement): void {
    const field = document.createElement('label');
    field.className = 'field generation-prompt';
    const prompt = document.createElement('textarea');
    prompt.rows = 5;
    prompt.value = this.prompt;
    prompt.placeholder = 'Describe the image you want to generate…';
    prompt.oninput = () => { this.prompt = prompt.value; this.editor.changed(); };
    field.append(document.createTextNode('Prompt'), prompt);
    container.append(field);
  }
}
