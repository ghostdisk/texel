import type { Editor } from '../editor';
import type { GenerationModelType } from '../generation/provider';
import type { AIRequestService } from '../generation/service';
import { Generator } from './generator';

export interface ModelTypeGeneratorOptions {
  id: string;
  label: string;
  resultName: string;
  modelTypes: readonly GenerationModelType[];
  prompt?: string;
  promptRequired?: boolean;
}

export class ModelTypeGenerator extends Generator {
  readonly id: string;
  readonly label: string;
  readonly resultName: string;
  readonly modelTypes: readonly GenerationModelType[];
  private readonly promptLabel: string | undefined;
  private readonly promptIsRequired: boolean;

  constructor(editor: Editor, service: AIRequestService, options: ModelTypeGeneratorOptions) {
    super(editor, service);
    this.id = options.id;
    this.label = options.label;
    this.resultName = options.resultName;
    this.modelTypes = options.modelTypes;
    this.promptLabel = options.prompt;
    this.promptIsRequired = options.promptRequired ?? false;
  }

  protected override get requiresPrompt(): boolean { return this.promptIsRequired; }

  run(): Promise<void> { return this.generate(); }

  renderSpecific(container: HTMLElement): void {
    if (!this.promptLabel) return;
    const field = document.createElement('label');
    field.className = 'field generation-prompt';
    const prompt = document.createElement('textarea');
    prompt.rows = 4;
    prompt.value = this.prompt;
    prompt.oninput = () => { this.prompt = prompt.value; this.settingsChanged(); };
    field.append(document.createTextNode(this.promptLabel), prompt);
    container.append(field);
  }
}
