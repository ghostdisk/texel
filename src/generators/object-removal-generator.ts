import type { GenerationModel, GenerationModelType } from '../generation/provider';
import { Generator } from './generator';

export class ObjectRemovalGenerator extends Generator {
  readonly id = 'object-removal';
  readonly label = 'Remove object';
  readonly resultName = 'Removed object';
  protected override readonly operation = 'remove' as const;
  protected override readonly supportsAutoRun = true;
  private mode: 'mask' | 'prompt' = 'mask';
  private promptField: HTMLElement | null = null;
  private autoRunFieldElement: HTMLElement | null = null;

  get modelTypes(): readonly GenerationModelType[] {
    return [this.mode === 'mask' ? 'object-removal-mask' : 'object-removal-prompt'];
  }
  protected override get requiresPrompt(): boolean { return this.mode === 'prompt'; }
  protected override get requiresSelection(): boolean { return this.mode === 'mask'; }

  run(): Promise<void> { return this.generate(); }

  protected override defaultModel(models: readonly GenerationModel[]): GenerationModel | undefined {
    return models.find((model) => model.id === 'local/migan-512-places2') ?? models[0];
  }

  override renderBeforeModel(container: HTMLElement): void {
    const field = document.createElement('label');
    field.className = 'field';
    const select = document.createElement('select');
    select.append(new Option('Mask', 'mask'), new Option('Prompt', 'prompt'));
    select.value = this.mode;
    select.onchange = () => {
      this.mode = select.value === 'prompt' ? 'prompt' : 'mask';
      this.autoRun = false;
      this.chooseDefaultModel();
      this.syncModeFields();
      this.notify();
    };
    field.append(document.createTextNode('Mode'), select);
    container.append(field);
  }

  renderSpecific(container: HTMLElement): void {
    const promptField = document.createElement('label');
    promptField.className = 'field generation-prompt';
    const prompt = document.createElement('textarea');
    prompt.rows = 4;
    prompt.value = this.prompt;
    prompt.placeholder = 'Describe the object to remove…';
    prompt.oninput = () => { this.prompt = prompt.value; this.editor.changed(); };
    promptField.append(document.createTextNode('Object to remove'), prompt);
    this.promptField = promptField;
    this.autoRunFieldElement = this.autoRunField();
    container.append(promptField, this.autoRunFieldElement);
    this.syncModeFields();
  }

  private autoRunField(): HTMLElement {
    const label = document.createElement('label');
    label.className = 'generator-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.autoRun;
    input.onchange = () => { this.autoRun = input.checked; this.editor.changed(); };
    label.append(input, document.createTextNode('Auto Run after selection changes'));
    return label;
  }

  private syncModeFields(): void {
    if (this.promptField) this.promptField.hidden = this.mode !== 'prompt';
    if (this.autoRunFieldElement) this.autoRunFieldElement.hidden = this.mode !== 'mask';
  }
}
