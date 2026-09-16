import type { GenerationModelType } from '../generation/provider';
import { Generator } from './generator';

export class InpaintGenerator extends Generator {
  readonly id = 'inpaint';
  readonly label = 'Inpaint';
  readonly resultName = 'Inpainted image';
  readonly modelTypes: readonly GenerationModelType[] = ['fill-inpaint'];
  protected override get requiresSelection(): boolean { return true; }
  protected override readonly supportsAutoRun = true;

  run(): Promise<void> { return this.generate(); }

  renderSpecific(container: HTMLElement): void {
    const promptField = document.createElement('label');
    promptField.className = 'field generation-prompt';
    const prompt = document.createElement('textarea');
    prompt.rows = 4;
    prompt.value = this.prompt;
    prompt.placeholder = 'Describe what should fill the selection…';
    prompt.oninput = () => { this.prompt = prompt.value; this.editor.changed(); };
    promptField.append(document.createTextNode('Prompt'), prompt);
    const auto = document.createElement('label');
    auto.className = 'generator-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = this.autoRun;
    toggle.onchange = () => { this.autoRun = toggle.checked; this.editor.changed(); };
    auto.append(toggle, document.createTextNode('Auto Run after selection changes'));
    container.append(promptField, auto);
  }
}
