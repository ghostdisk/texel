import type { Editor } from '../editor';
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
  private readonly fit = document.createElement('button');
  private readonly lensFields = new Map<string, HTMLInputElement>();
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
    prompt.oninput = () => { generation.prompt = prompt.value; editor.changed(); };
    this.settings.append(label('Prompt', prompt));
    const dimensions = document.createElement('div');
    dimensions.className = 'field-pair';
    const position = document.createElement('details');
    const positionTitle = document.createElement('summary');
    positionTitle.textContent = 'Position & rotation';
    position.append(positionTitle);
    const coordinates = document.createElement('div');
    coordinates.className = 'generation-numbers';
    position.append(coordinates);
    for (const [name, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['Angle °', 'angle']] as const) {
      const control = document.createElement('input');
      control.type = 'number';
      control.step = '1';
      control.setAttribute('aria-label', 'Lens ' + name);
      control.title = key === 'angle' ? 'Rotation in degrees' : 'Canvas units';
      if (key === 'width' || key === 'height') control.min = '1';
      control.onchange = () => {
        const value = control.valueAsNumber;
        if (Number.isFinite(value)) generation.editLens((lens) => {
          if (key === 'width') lens.setSize(value, lens.height);
          else if (key === 'height') lens.setSize(lens.width, value);
          else if (key === 'angle') lens.setAngle(value);
          else {
            const matrix = [...lens.transform] as [number, number, number, number, number, number];
            matrix[key === 'x' ? 4 : 5] = value;
            lens.setTransform(matrix);
          }
        });
        this.update();
      };
      this.lensFields.set(key, control);
      (key === 'width' || key === 'height' ? dimensions : coordinates).append(label(name, control));
    }
    const scale = document.createElement('input');
    scale.type = 'number';
    scale.min = '0.0625'; scale.max = '16'; scale.step = 'any';
    scale.value = String(generation.scale);
    scale.setAttribute('list', 'generation-scale-values');
    scale.setAttribute('aria-label', 'Generation scale');
    scale.onchange = () => {
      if (Number.isFinite(scale.valueAsNumber)) generation.scale = Math.max(0.0625, Math.min(16, scale.valueAsNumber));
      scale.value = String(generation.scale);
      editor.changed();
    };
    const scales = document.createElement('datalist');
    scales.id = 'generation-scale-values';
    scales.append(...[0.125, 0.25, 0.5, 1, 2, 4, 8].map((value) => new Option(value + '×', String(value))));
    const scaleRow = document.createElement('div');
    scaleRow.className = 'field-pair';
    this.fit.textContent = 'Fit canvas';
    this.fit.dataset.action = 'generation.fit';
    this.fit.onclick = () => editor.actions.execute('generation.fit');
    const fitLabel = label('Lens', this.fit);
    scaleRow.append(label('Scale ×', scale), fitLabel);
    const feather = new SliderInput({
      label: 'Feather', min: 0, max: 65536, sliderMax: 128, step: 1, unit: 'px', get: () => generation.feather,
      input: (value) => { generation.feather = value; editor.changed(); },
    });
    feather.element.title = 'Fade the lens edges in canvas units';
    this.settings.append(dimensions, position, scaleRow, scales, feather.element);
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
    actions.append(this.generate, this.cancel);
    this.preview.className = 'generation-preview';
    this.preview.alt = 'Generation preview';
    this.progress.max = 1;
    this.status.className = 'generation-status';
    this.error.className = 'generation-error';
    container.append(this.settings, actions, this.preview, this.progress, this.status, this.error);
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
    this.fit.disabled = generation.busy;
    this.generate.disabled = !generation.canGenerate;
    this.cancel.hidden = !generation.busy;
    const lens = generation.displayLens;
    const values: Record<string, number> = { width: lens.width, height: lens.height, x: lens.transform[4], y: lens.transform[5], angle: lens.angle };
    for (const [key, control] of this.lensFields) {
      if (document.activeElement !== control) control.value = String(Number(values[key].toFixed(2)));
    }
    const { width, height } = generation.frame;
    const progress = generation.progress;
    this.status.textContent = progress.phase + (progress.steps ? ' · ' + progress.step + '/' + progress.steps : '') + ' · ' + width + ' × ' + height + ' px';
    this.progress.hidden = !generation.busy;
    if (progress.steps) this.progress.value = progress.step / progress.steps;
    else this.progress.removeAttribute('value');
    this.preview.hidden = !generation.previewUrl;
    if (generation.previewUrl && this.preview.getAttribute('src') !== generation.previewUrl) this.preview.src = generation.previewUrl;
    this.error.textContent = generation.error || generation.sizeError;
    this.error.hidden = !this.error.textContent;
  }
}