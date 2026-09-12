import type { Editor } from '../editor';
import { ImageLayer } from '../model/layers';
import { SliderInput } from './slider-input';

export class GenerationPanel {
  private readonly model = document.createElement('select');
  private readonly status = document.createElement('div');
  private readonly preview = document.createElement('img');
  private readonly progress = document.createElement('progress');
  private readonly error = document.createElement('p');
  private readonly settings = document.createElement('fieldset');
  private readonly generate = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private modelSignature = '';

  constructor(private readonly editor: Editor, container: HTMLElement) {
    const generation = editor.generation;
    container.classList.add('generation-options');
    this.settings.className = 'generation-settings';
    const label = (name: string, control: HTMLElement) => {
      const field = document.createElement('label');
      field.className = 'field';
      field.append(document.createTextNode(name), control);
      return field;
    };
    this.model.setAttribute('aria-label', 'Generation model');
    this.model.onchange = () => { generation.model = this.model.value; editor.changed(); };
    this.settings.append(label('Model', this.model));
    const prompt = document.createElement('textarea');
    prompt.rows = 3;
    prompt.value = generation.prompt;
    prompt.placeholder = 'Describe the image…';
    prompt.oninput = () => { generation.prompt = prompt.value; this.update(); editor.changed(); };
    this.settings.append(label('Prompt', prompt));
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Negative prompt';
    const negative = document.createElement('textarea');
    negative.rows = 2;
    negative.value = generation.negativePrompt;
    negative.setAttribute('aria-label', 'Negative prompt');
    negative.oninput = () => { generation.negativePrompt = negative.value; };
    details.append(summary, negative);
    this.settings.append(details);
    const fields = document.createElement('div');
    fields.className = 'generation-numbers';
    for (const [name, key, min, max, step] of [
      ['Steps', 'steps', 1, 100, 1], ['Guidance', 'guidance', 0, 30, 0.5], ['Seed', 'seed', -1, 2147483647, 1],
    ] as const) {
      const control = document.createElement('input');
      control.type = 'number';
      control.min = String(min); control.max = String(max); control.step = String(step);
      control.value = String(generation[key]);
      if (key === 'seed') control.title = '-1 chooses a random seed';
      control.onchange = () => {
        if (Number.isFinite(control.valueAsNumber)) generation[key] = Math.max(min, Math.min(max, control.valueAsNumber));
        control.value = String(generation[key]);
      };
      fields.append(label(name, control));
    }
    this.settings.append(fields);
    const denoise = new SliderInput({
      label: 'Denoise', min: 1, max: 100, step: 1, unit: '%', get: () => generation.strength * 100,
      input: (value) => { generation.strength = value / 100; },
    });
    this.settings.append(denoise.element);
    const actions = document.createElement('div');
    actions.className = 'generation-actions';
    this.generate.textContent = 'Generate';
    this.generate.className = 'primary';
    this.generate.dataset.action = 'generation.generate';
    this.generate.onclick = () => editor.actions.execute('generation.generate');
    this.cancel.textContent = 'Cancel';
    this.cancel.dataset.action = 'generation.cancel';
    this.cancel.onclick = () => editor.actions.execute('generation.cancel');
    const sized = document.createElement('button');
    sized.textContent = 'New sized layer…';
    sized.dataset.action = 'layer.new-sized';
    sized.onclick = () => editor.actions.execute('layer.new-sized');
    actions.append(this.generate, this.cancel);
    this.preview.className = 'generation-preview';
    this.preview.alt = 'Generation preview';
    this.progress.max = 1;
    this.status.className = 'generation-status';
    this.error.className = 'generation-error';
    container.append(this.settings, sized, actions, this.preview, this.progress, this.status, this.error);
    generation.onChange = () => this.update();
    this.update();
  }

  update(): void {
    const generation = this.editor.generation;
    const signature = generation.models.map((model) => model.id).join('|');
    if (signature !== this.modelSignature || !this.model.options.length) {
      this.modelSignature = signature;
      this.model.replaceChildren(...generation.models.map((model) => new Option(model.label, model.id)));
      if (!this.model.options.length) this.model.add(new Option('No models available', ''));
    }
    this.model.value = generation.model;
    this.settings.disabled = generation.busy;
    this.generate.disabled = !generation.canGenerate;
    this.cancel.hidden = !generation.busy;
    const layer = generation.visual?.layer ?? this.editor.image.selected;
    const dimensions = layer instanceof ImageLayer ? ' · ' + layer.width + ' × ' + layer.height : '';
    const progress = generation.progress;
    this.status.textContent = progress.phase + (progress.steps ? ' · ' + progress.step + '/' + progress.steps : '') + dimensions;
    this.progress.hidden = !generation.busy;
    if (progress.steps) this.progress.value = progress.step / progress.steps;
    else this.progress.removeAttribute('value');
    this.preview.hidden = !generation.previewUrl;
    if (generation.previewUrl && this.preview.getAttribute('src') !== generation.previewUrl) this.preview.src = generation.previewUrl;
    this.error.textContent = generation.error;
    this.error.hidden = !generation.error;
  }
}
