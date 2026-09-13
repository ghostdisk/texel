import type { Editor } from '../editor';
import type { GenerationModelCapabilities } from '../generation/provider';
import { GenerationModelPicker } from './generation-model-picker';
import { SliderInput } from './slider-input';
import { icon } from './icons';

export class GenerationPanel {
  private readonly window = document.createElement('section');
  private readonly settings = document.createElement('fieldset');
  private readonly provider = document.createElement('select');
  private readonly modelPicker: GenerationModelPicker;
  private readonly status = document.createElement('div');
  private readonly resultPreview = document.createElement('img');
  private readonly inputPreview = document.createElement('img');
  private readonly maskPreview = document.createElement('img');
  private readonly inputCard = document.createElement('figure');
  private readonly maskCard = document.createElement('figure');
  private readonly inputToggle = document.createElement('input');
  private readonly maskToggle = document.createElement('input');
  private readonly progress = document.createElement('progress');
  private readonly error = document.createElement('p');
  private readonly generate = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private readonly fit = document.createElement('button');
  private readonly generatedSize = document.createElement('div');
  private readonly capabilityFields = new Map<keyof GenerationModelCapabilities, HTMLElement>();
  private readonly lensFields = new Map<string, HTMLInputElement>();
  private readonly scale: SliderInput;
  private readonly feather: SliderInput;
  private modelSignature = '';
  private previewSignature = '';
  private previewTimer = 0;
  private previewRequest = 0;

  constructor(private readonly editor: Editor, container: HTMLElement) {
    const generation = editor.generation;
    this.modelPicker = new GenerationModelPicker((id) => {
      generation.model = id;
      editor.changed();
    });
    container.classList.add('generation-options');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'generation-window-toggle';
    toggle.append(icon('settings'), document.createTextNode('Generation settings'));
    toggle.onclick = () => { this.window.hidden = !this.window.hidden; };
    this.window.className = 'generation-window';
    this.window.setAttribute('role', 'dialog');
    this.window.setAttribute('aria-label', 'Image generation');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Generate image';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.append(icon('close'));
    close.setAttribute('aria-label', 'Hide generation settings');
    close.onclick = () => { this.window.hidden = true; };
    header.append(title, close);
    this.dragWindow(header);
    const body = document.createElement('div');
    body.className = 'generation-window-body';
    this.settings.className = 'generation-settings';
    const label = (name: string, control: HTMLElement) => {
      const field = document.createElement('label');
      field.className = 'field';
      field.append(document.createTextNode(name), control);
      return field;
    };
    this.provider.setAttribute('aria-label', 'Generation provider');
    this.provider.onchange = () => {
      generation.model = generation.registry.models(this.provider.value).find((model) => model.task !== 'remove')?.id ?? '';
      this.modelSignature = '';
      editor.changed();
    };
    const selectors = document.createElement('div');
    selectors.className = 'generation-selectors';
    selectors.append(label('Provider', this.provider), label('Model', this.modelPicker.button));
    const prompt = document.createElement('textarea');
    prompt.rows = 5;
    prompt.value = generation.prompt;
    prompt.placeholder = 'Describe the image you want to generate…';
    prompt.oninput = () => { generation.prompt = prompt.value; editor.changed(); };
    const promptField = label('Prompt', prompt);
    promptField.classList.add('generation-prompt');
    const negative = document.createElement('textarea');
    negative.rows = 3;
    negative.value = generation.negativePrompt;
    negative.placeholder = 'What should be excluded…';
    negative.oninput = () => { generation.negativePrompt = negative.value; };
    const negativeField = label('Negative prompt', negative);
    this.capabilityFields.set('negativePrompt', negativeField);
    const sampling = document.createElement('div');
    sampling.className = 'generation-numbers';
    for (const [name, key, capability, min, max, step] of [
      ['Steps', 'steps', 'steps', 1, 100, 1],
      ['Guidance', 'guidance', 'guidance', 0, 30, 0.5],
      ['Seed', 'seed', 'seed', -1, 2147483647, 1],
    ] as const) {
      const control = document.createElement('input');
      control.type = 'number';
      control.min = String(min);
      control.max = String(max);
      control.step = String(step);
      control.value = String(generation[key]);
      if (key === 'seed') control.title = '-1 chooses a random seed';
      control.onchange = () => {
        if (Number.isFinite(control.valueAsNumber)) generation[key] = Math.max(min, Math.min(max, control.valueAsNumber));
        control.value = String(generation[key]);
      };
      const field = label(name, control);
      this.capabilityFields.set(capability, field);
      sampling.append(field);
    }
    const denoise = new SliderInput({
      label: 'Denoise', min: 1, max: 100, step: 1, unit: '%', get: () => generation.strength * 100,
      input: (value) => { generation.strength = value / 100; },
    });
    this.capabilityFields.set('denoiseStrength', denoise.element);
    this.scale = new SliderInput({
      label: 'Scale', min: 0.125, max: 4, step: 0.125, unit: '×', get: () => generation.scale,
      input: (value) => { generation.scale = value; editor.changed(); },
    });
    this.generatedSize.className = 'generation-size';
    this.feather = new SliderInput({
      label: 'Feather', min: 0, max: 65536, sliderMax: 128, step: 1, unit: 'px', get: () => generation.feather,
      input: (value) => { generation.feather = value; editor.changed(); },
    });
    this.feather.element.title = 'Fade the selection edge in canvas units';
    this.capabilityFields.set('mask', this.feather.element);
    const lens = document.createElement('details');
    const lensTitle = document.createElement('summary');
    lensTitle.textContent = 'Lens geometry';
    const dimensions = document.createElement('div');
    dimensions.className = 'generation-lens-fields';
    for (const [name, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['Angle °', 'angle']] as const) {
      const control = document.createElement('input');
      control.type = 'number';
      control.step = '1';
      if (key === 'width' || key === 'height') control.min = '1';
      control.onchange = () => {
        const value = control.valueAsNumber;
        if (Number.isFinite(value)) generation.editLens((target) => {
          if (key === 'width') target.setSize(value, target.height);
          else if (key === 'height') target.setSize(target.width, value);
          else if (key === 'angle') target.setAngle(value);
          else {
            const matrix = [...target.transform] as [number, number, number, number, number, number];
            matrix[key === 'x' ? 4 : 5] = value;
            target.setTransform(matrix);
          }
        });
      };
      this.lensFields.set(key, control);
      dimensions.append(label(name, control));
    }
    this.fit.type = 'button';
    this.fit.textContent = 'Fit canvas';
    this.fit.dataset.action = 'generation.fit';
    this.fit.onclick = () => editor.actions.execute('generation.fit');
    dimensions.append(this.fit);
    lens.append(lensTitle, dimensions);
    const previews = document.createElement('div');
    previews.className = 'generation-inputs';
    this.inputPreview.alt = 'Image sent to the generation model';
    this.maskPreview.alt = 'Mask sent to the generation model';
    this.inputCard.append(this.inputPreview, this.caption('Color', this.inputToggle, (checked) => {
      generation.sendInput = checked;
      editor.changed();
    }));
    this.maskCard.append(this.maskPreview, this.caption('Mask', this.maskToggle, (checked) => {
      generation.sendMask = checked;
      editor.changed();
    }));
    previews.append(this.inputCard, this.maskCard);
    const previewHeading = document.createElement('h3');
    previewHeading.textContent = 'Model inputs';
    const actions = document.createElement('div');
    actions.className = 'generation-actions';
    this.generate.append(icon('generate'), document.createTextNode('Generate'));
    this.generate.className = 'primary';
    this.generate.dataset.action = 'generation.generate';
    this.generate.onclick = () => editor.actions.execute('generation.generate');
    this.cancel.textContent = 'Cancel';
    this.cancel.dataset.action = 'generation.cancel';
    this.cancel.onclick = () => editor.actions.execute('generation.cancel');
    actions.append(this.generate, this.cancel);
    this.resultPreview.className = 'generation-result-preview';
    this.resultPreview.alt = 'Current generation preview';
    this.progress.max = 1;
    this.status.className = 'generation-status';
    this.error.className = 'generation-error';
    this.settings.append(selectors, promptField, negativeField, sampling, denoise.element, this.scale.element,
      this.generatedSize, this.feather.element, lens, previewHeading, previews);
    body.append(this.settings, this.resultPreview, this.progress, this.status, this.error, actions);
    this.window.append(header, body);
    container.append(toggle, this.window);
    generation.onChange = () => this.update();
    this.update();
  }

  private caption(text: string, toggle: HTMLInputElement, change: (checked: boolean) => void): HTMLElement {
    const caption = document.createElement('figcaption');
    const label = document.createElement('label');
    toggle.type = 'checkbox';
    toggle.onchange = () => change(toggle.checked);
    label.append(toggle, document.createTextNode(text));
    caption.append(label);
    return caption;
  }

  private dragWindow(handle: HTMLElement): void {
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || event.target instanceof Element && event.target.closest('button')) return;
      const bounds = this.window.getBoundingClientRect();
      const offsetX = event.clientX - bounds.left;
      const offsetY = event.clientY - bounds.top;
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = (move) => {
        this.window.style.right = 'auto';
        this.window.style.left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, move.clientX - offsetX)) + 'px';
        this.window.style.top = Math.max(42, Math.min(window.innerHeight - 80, move.clientY - offsetY)) + 'px';
      };
      handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
    };
  }

  update(): void {
    const generation = this.editor.generation;
    const sources = generation.registry.sources();
    const signature = JSON.stringify(generation.models.map((model) => [model.id, model.capabilities]));
    if (signature !== this.modelSignature || !this.provider.options.length) {
      this.modelSignature = signature;
      this.provider.replaceChildren(...sources.map((source) => new Option(source.label, source.id)));
    }
    const source = generation.selectedModel?.source ?? sources[0]?.id ?? '';
    this.provider.value = source;
    const models = generation.registry.models(source).filter((model) => model.task !== 'remove');
    this.modelPicker.update(models, generation.model);
    const capabilities = generation.selectedModel?.capabilities;
    for (const [capability, field] of this.capabilityFields) {
      field.hidden = !capabilities?.[capability] || capability === 'mask' && !this.editor.image.selectionMask;
    }
    this.inputToggle.checked = generation.sendInput;
    this.maskToggle.checked = generation.sendMask;
    this.maskToggle.disabled = !generation.sendInput;
    this.inputCard.classList.toggle('excluded', !generation.sendInput);
    this.maskCard.classList.toggle('excluded', !generation.sendInput || !generation.sendMask);
    this.capabilityFields.get('denoiseStrength')!.hidden =
      !capabilities?.denoiseStrength || !generation.sendInput;
    this.settings.disabled = generation.busy;
    this.fit.disabled = generation.busy;
    this.generate.disabled = !generation.canGenerate;
    this.cancel.hidden = !generation.busy;
    this.scale.sync();
    this.feather.sync();
    const lens = generation.displayLens;
    const values: Record<string, number> = {
      width: lens.width, height: lens.height, x: lens.transform[4], y: lens.transform[5], angle: lens.angle,
    };
    for (const [key, control] of this.lensFields) {
      if (document.activeElement !== control) control.value = String(Number(values[key].toFixed(2)));
    }
    const { width, height } = generation.frame;
    this.generatedSize.textContent = `Output size: ${width} × ${height} px`;
    const progress = generation.progress;
    this.status.textContent = progress.phase + (progress.steps ? ` · ${progress.step}/${progress.steps}` : '') + ` · ${width} × ${height} px`;
    this.progress.hidden = !generation.busy;
    if (progress.steps) this.progress.value = progress.step / progress.steps;
    else this.progress.removeAttribute('value');
    this.resultPreview.hidden = !generation.previewUrl;
    if (generation.previewUrl && this.resultPreview.getAttribute('src') !== generation.previewUrl) this.resultPreview.src = generation.previewUrl;
    this.error.textContent = generation.error || generation.sizeError;
    this.error.hidden = !this.error.textContent;
    this.scheduleInputPreview();
  }

  private scheduleInputPreview(): void {
    const generation = this.editor.generation;
    const selection = this.editor.image.selectionMask;
    const signature = JSON.stringify([
      generation.model, generation.scale, generation.feather, generation.lens.transform,
      selection?.id, selection?.revision, this.editor.image.root.revision,
    ]);
    if (signature === this.previewSignature || generation.busy) return;
    this.previewSignature = signature;
    clearTimeout(this.previewTimer);
    const request = ++this.previewRequest;
    this.previewTimer = window.setTimeout(() => void this.renderInputPreview(request), 160);
  }

  private async renderInputPreview(request: number): Promise<void> {
    if (!this.window.isConnected || this.editor.generation.busy) return;
    this.inputCard.classList.add('loading');
    this.maskCard.classList.add('loading');
    try {
      const preview = await this.editor.generation.inputPreview();
      if (request !== this.previewRequest || !this.window.isConnected) return;
      this.inputCard.hidden = !preview.input;
      this.maskCard.hidden = !preview.mask;
      if (preview.input) this.inputPreview.src = await this.dataUrl(preview.input);
      if (preview.mask) this.maskPreview.src = await this.dataUrl(preview.mask);
    } catch (error) {
      if (request === this.previewRequest) this.error.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.previewRequest) {
        this.inputCard.classList.remove('loading');
        this.maskCard.classList.remove('loading');
      }
    }
  }

  private dataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('Unable to display generation input.'));
      reader.readAsDataURL(blob);
    });
  }
}
