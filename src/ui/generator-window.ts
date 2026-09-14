import type { Editor } from '../editor';
import type { GenerationModelCapabilities } from '../generation/provider';
import type { Generator } from '../generators/generator';
import type { GeneratorManager } from '../generators/manager';
import { icon } from './icons';
import { ModelPicker } from './model-picker';
import { SliderInput } from './slider-input';

export class GeneratorWindow {
  private readonly window = document.createElement('section');
  private readonly title = document.createElement('strong');
  private readonly body = document.createElement('div');
  private readonly settings = document.createElement('fieldset');
  private readonly modelPicker: ModelPicker;
  private readonly inputCard = document.createElement('figure');
  private readonly maskCard = document.createElement('figure');
  private readonly inputPreview = document.createElement('img');
  private readonly maskPreview = document.createElement('img');
  private readonly inputToggle = document.createElement('input');
  private readonly maskToggle = document.createElement('input');
  private readonly generatedSize = document.createElement('div');
  private readonly progress = document.createElement('progress');
  private readonly status = document.createElement('div');
  private readonly error = document.createElement('div');
  private readonly resultPreview = document.createElement('img');
  private readonly generate = document.createElement('button');
  private readonly apply = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private readonly capabilityFields = new Map<keyof GenerationModelCapabilities, HTMLElement>();
  private readonly lensFields = new Map<string, HTMLInputElement>();
  private scale: SliderInput | null = null;
  private feather: SliderInput | null = null;
  private previewSignature = '';
  private previewTimer = 0;
  private previewRequest = 0;

  constructor(private readonly editor: Editor, private readonly manager: GeneratorManager) {
    this.modelPicker = new ModelPicker((id) => {
      const generator = this.manager.active;
      if (generator) void generator.selectModel(id);
    });
    this.window.className = 'generation-window generator-window';
    this.window.hidden = true;
    this.window.setAttribute('role', 'dialog');
    const header = document.createElement('header');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.append(icon('close'));
    close.setAttribute('aria-label', 'Close generator');
    close.onclick = () => this.manager.close();
    header.append(this.title, close);
    this.dragWindow(header);
    this.body.className = 'generation-window-body';
    this.settings.className = 'generation-settings';
    this.settings.oninput = this.settings.onchange = () => this.manager.active?.settingsChanged();
    this.body.append(this.settings);
    this.window.append(header, this.body);
    document.body.append(this.window);
  }

  show(generator: Generator): void {
    this.window.hidden = false;
    this.window.setAttribute('aria-label', generator.label);
    this.title.textContent = generator.label;
    this.build(generator);
    this.update();
  }

  hide(): void {
    this.window.hidden = true;
    clearTimeout(this.previewTimer);
    this.previewRequest++;
  }

  update(): void {
    const generator = this.manager.active;
    if (!generator || this.window.hidden) return;
    const models = generator.models;
    this.modelPicker.update(models, generator.model);
    const capabilities = generator.selectedModel?.capabilities;
    for (const [capability, field] of this.capabilityFields) {
      const supported = capability === 'mask' ? capabilities?.mask || generator.selectionRequired : capabilities?.[capability];
      field.hidden = !supported || capability === 'mask' && !this.editor.image.selectionMask;
    }
    const requiresInput = !!capabilities?.minimumInputImages;
    const requiresMask = !!capabilities?.maskRequired || generator.selectionRequired;
    const sendsInput = requiresInput || generator.sendInput;
    const sendsMask = requiresMask || generator.sendMask;
    this.inputToggle.checked = sendsInput;
    this.inputToggle.disabled = requiresInput;
    this.maskToggle.checked = sendsMask;
    this.maskToggle.disabled = !sendsInput || requiresMask;
    this.inputCard.classList.toggle('excluded', !sendsInput);
    this.maskCard.classList.toggle('excluded', !sendsInput || !sendsMask);
    this.capabilityFields.get('denoiseStrength')!.hidden = !capabilities?.denoiseStrength || !sendsInput;
    this.settings.disabled = generator.busy;
    this.generate.disabled = !generator.canGenerate;
    this.apply.disabled = !generator.canApply;
    this.cancel.hidden = !generator.busy;
    this.scale?.sync();
    this.feather?.sync();
    const lens = generator.lens;
    const values: Record<string, number> = {
      width: lens.width,
      height: lens.height,
      x: lens.transform[4],
      y: lens.transform[5],
      angle: lens.angle,
    };
    for (const [key, control] of this.lensFields) {
      if (document.activeElement !== control) control.value = String(Number(values[key].toFixed(2)));
    }
    const { width, height } = generator.frame;
    this.generatedSize.textContent = `Requested size: ${width} × ${height} px`;
    const progress = generator.progress;
    const result = generator.resultSize;
    this.status.textContent = progress.phase + (progress.steps ? ` · ${progress.step}/${progress.steps}` : '') +
      (result ? ` · Returned ${result.width} × ${result.height} px` : '');
    this.progress.hidden = !generator.busy;
    if (progress.steps) this.progress.value = progress.step / progress.steps;
    else this.progress.removeAttribute('value');
    this.resultPreview.hidden = !generator.resultPreviewUrl;
    if (generator.resultPreviewUrl && this.resultPreview.src !== generator.resultPreviewUrl) this.resultPreview.src = generator.resultPreviewUrl;
    this.error.textContent = generator.error || generator.sizeError || generator.requirementError || (!models.length ? this.manager.service.error : '');
    this.error.hidden = !this.error.textContent;
    this.scheduleInputPreview(generator);
  }

  private build(generator: Generator): void {
    this.capabilityFields.clear();
    this.lensFields.clear();
    this.settings.replaceChildren();
    this.body.replaceChildren(this.settings);
    const label = (name: string, control: HTMLElement) => {
      const field = document.createElement('label');
      field.className = 'field';
      field.append(document.createTextNode(name), control);
      return field;
    };
    const beforeModel = document.createElement('div');
    beforeModel.className = 'generator-before-model';
    generator.renderBeforeModel(beforeModel);
    if (beforeModel.childElementCount) this.settings.append(beforeModel);
    this.settings.append(label('Model', this.modelPicker.button));
    const specific = document.createElement('div');
    specific.className = 'generator-specific';
    generator.renderSpecific(specific);
    this.settings.append(specific);
    const negative = document.createElement('textarea');
    negative.rows = 3;
    negative.value = generator.negativePrompt;
    negative.placeholder = 'What should be excluded…';
    negative.oninput = () => { generator.negativePrompt = negative.value; };
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
      control.value = String(generator[key]);
      control.onchange = () => {
        if (Number.isFinite(control.valueAsNumber)) generator[key] = Math.max(min, Math.min(max, control.valueAsNumber));
        control.value = String(generator[key]);
      };
      const field = label(name, control);
      this.capabilityFields.set(capability, field);
      sampling.append(field);
    }
    const denoise = new SliderInput({
      label: 'Denoise',
      min: 1,
      max: 100,
      step: 1,
      unit: '%',
      get: () => generator.strength * 100,
      input: (value) => { generator.strength = value / 100; },
    });
    this.capabilityFields.set('denoiseStrength', denoise.element);
    this.scale = new SliderInput({
      label: 'Scale',
      min: 0.125,
      max: 4,
      step: 0.125,
      unit: '×',
      get: () => generator.scale,
      input: (value) => { generator.scale = value; this.editor.changed(); },
    });
    this.feather = new SliderInput({
      label: 'Feather',
      min: 0,
      max: 65536,
      sliderMax: 128,
      step: 1,
      unit: 'px',
      get: () => generator.feather,
      input: (value) => { generator.feather = value; this.editor.changed(); },
    });
    this.capabilityFields.set('mask', this.feather.element);
    const lens = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Lens geometry';
    const fields = document.createElement('div');
    fields.className = 'generation-lens-fields';
    for (const [name, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['Angle °', 'angle']] as const) {
      const control = document.createElement('input');
      control.type = 'number';
      control.step = '1';
      if (key === 'width' || key === 'height') control.min = '1';
      control.onchange = () => {
        const value = control.valueAsNumber;
        if (!Number.isFinite(value)) return;
        generator.editLens((target) => {
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
      fields.append(label(name, control));
    }
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.textContent = 'Fit canvas';
    fit.onclick = () => this.manager.fitLens();
    fields.append(fit);
    lens.append(summary, fields);
    const include = document.createElement('label');
    include.className = 'generator-toggle';
    const includeToggle = document.createElement('input');
    includeToggle.type = 'checkbox';
    includeToggle.checked = generator.includeResult;
    includeToggle.onchange = () => { generator.includeResult = includeToggle.checked; this.editor.changed(); };
    include.title = 'Include the current result layer when composing the color input sent to the model';
    include.append(includeToggle, document.createTextNode('Include result layer'));
    const heading = document.createElement('h3');
    heading.textContent = 'Model inputs';
    const previews = document.createElement('div');
    previews.className = 'generation-inputs';
    this.inputPreview.alt = 'Color image sent to the model';
    this.maskPreview.alt = 'Mask sent to the model';
    this.inputCard.replaceChildren(this.inputPreview, this.caption('Color', this.inputToggle, (checked) => {
      generator.sendInput = checked;
      this.editor.changed();
    }));
    this.maskCard.replaceChildren(this.maskPreview, this.caption('Mask', this.maskToggle, (checked) => {
      generator.sendMask = checked;
      this.editor.changed();
    }));
    previews.append(this.inputCard, this.maskCard);
    this.settings.append(negativeField, sampling, denoise.element, this.scale.element, this.generatedSize,
      this.feather.element, lens, include, heading, previews);
    this.resultPreview.className = 'generation-result-preview';
    this.progress.max = 1;
    this.status.className = 'generation-status';
    this.error.className = 'generation-error';
    const actions = document.createElement('div');
    actions.className = 'generation-actions';
    this.generate.className = 'primary';
    this.generate.replaceChildren(icon('generate'), document.createTextNode('Generate'));
    this.generate.onclick = () => void this.manager.generate();
    this.apply.textContent = 'Apply';
    this.apply.title = 'Keep this result and generate into a new layer next time';
    this.apply.onclick = () => this.manager.apply();
    this.cancel.textContent = 'Cancel';
    this.cancel.onclick = () => this.manager.cancel();
    actions.append(this.generate, this.apply, this.cancel);
    this.body.append(this.resultPreview, this.progress, this.status, this.error, actions);
    this.previewSignature = '';
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

  private scheduleInputPreview(generator: Generator): void {
    const selection = this.editor.image.selectionMask;
    const signature = JSON.stringify([
      generator.id,
      generator.model,
      generator.scale,
      generator.feather,
      generator.includeResult,
      generator.resultLayer?.id,
      generator.lens.transform,
      selection?.id,
      selection?.revision,
      this.editor.image.root.revision,
    ]);
    if (signature === this.previewSignature || generator.busy) return;
    this.previewSignature = signature;
    clearTimeout(this.previewTimer);
    const request = ++this.previewRequest;
    this.previewTimer = window.setTimeout(() => void this.renderInputPreview(generator, request), 160);
  }

  private async renderInputPreview(generator: Generator, request: number): Promise<void> {
    if (this.manager.active !== generator || this.window.hidden || generator.busy) return;
    this.inputCard.classList.add('loading');
    this.maskCard.classList.add('loading');
    try {
      const preview = await generator.inputPreview();
      if (request !== this.previewRequest || this.manager.active !== generator) return;
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
      reader.onerror = () => reject(reader.error ?? new Error('Unable to display generator input.'));
      reader.readAsDataURL(blob);
    });
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
}
