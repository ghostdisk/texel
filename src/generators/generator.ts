import type { Editor } from '../editor';
import type { GenerationVisual } from '../gpu/generation-overlay';
import { GenerationBlend } from '../gpu/generation-blend';
import { GenerationMask } from '../gpu/generation-mask';
import { importImage } from '../gpu/images';
import type { Surface } from '../gpu/surface';
import type { UndoOperation } from '../history/undo';
import { inverse, multiply } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { GroupLayer, ImageLayer } from '../model/layers';
import { rgbaToPng } from '../generation/image-codec';
import { GenerationLens, generationResultFrame } from '../generation/lens';
import type { GenerationFrame } from '../generation/lens';
import type { AIRequestService } from '../generation/service';
import type { GenerationModel, GenerationModelType, GenerationProgress } from '../generation/provider';

export interface GeneratorInputPreview {
  input: Blob | null;
  mask: Blob | null;
}

interface RunningRequest {
  id: string;
  documentId: string;
  root: GroupLayer;
  frame: GenerationFrame;
  input: Surface | null;
  mask: Surface | null;
  controller: AbortController;
  pendingPreview: Blob | null;
  previewReading: boolean;
  finishing: boolean;
  edit?: UndoOperation;
}

export abstract class Generator {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly modelTypes: readonly GenerationModelType[];
  abstract readonly resultName: string;
  readonly lens: GenerationLens;
  model = '';
  prompt = '';
  negativePrompt = '';
  steps = 20;
  guidance = 6;
  strength = 1;
  seed = -1;
  scale = 1;
  feather = 0;
  sendInput = true;
  sendMask = true;
  includeResult = false;
  autoRun = false;
  progress: GenerationProgress = { phase: 'Ready', step: 0, steps: 0 };
  error = '';
  resultPreviewUrl = '';
  onChange?: () => void;
  protected get requiresPrompt(): boolean { return true; }
  protected get requiresSelection(): boolean { return false; }
  protected readonly operation: 'remove' | undefined = undefined;
  protected readonly supportsAutoRun: boolean = false;
  private running: RunningRequest | null = null;
  private result: ImageLayer | null = null;
  private resultSource: Surface | null = null;
  private resultFrame: GenerationFrame | null = null;
  private resolvingModel = '';
  private modelRequest = 0;
  private selectionSignature = '';
  private autoTimer = 0;
  private readonly blend: GenerationBlend;
  private readonly masks: GenerationMask;

  constructor(protected readonly editor: Editor, protected readonly service: AIRequestService) {
    this.blend = new GenerationBlend(editor.gpu);
    this.masks = new GenerationMask(editor.gpu);
    this.lens = new GenerationLens(1, 1, () => this.notify());
  }

  get models(): readonly GenerationModel[] {
    return this.service.models.filter((model) => model.types?.some((type) => this.modelTypes.includes(type)));
  }
  get selectedModel(): GenerationModel | undefined { return this.service.registry.model(this.model); }
  get busy(): boolean { return !!this.running; }
  get hasResult(): boolean { return !!this.result; }
  get resultLayer(): ImageLayer | null { return this.result; }
  get canApply(): boolean { return !this.busy && !!this.result; }
  get canGenerate(): boolean {
    return !this.busy && !this.resolvingModel && !!this.model && (!this.requiresPrompt || !!this.prompt.trim()) &&
      (!this.requiresSelection || !!this.editor.image.selectionMask) && !this.sizeError && !this.requirementError;
  }
  get frame(): GenerationFrame { return this.lens.frame(this.scale, this.selectedModel?.capabilities.size); }
  get resultSize(): Pick<GenerationFrame, 'width' | 'height'> | null {
    const source = this.result?.source;
    return source ? { width: source.width, height: source.height } : null;
  }
  get visual(): GenerationVisual | null {
    const run = this.running;
    return run?.input && !run.controller.signal.aborted ? { frame: run.frame, mask: run.mask, reference: run.input } : null;
  }
  get autoRunAvailable(): boolean { return this.supportsAutoRun; }
  get promptRequired(): boolean { return this.requiresPrompt; }
  get selectionRequired(): boolean { return this.requiresSelection; }
  get sizeError(): string {
    const { width, height } = this.frame;
    const capabilities = this.selectedModel?.capabilities;
    const limit = this.editor.gpu.device.limits.maxTextureDimension2D;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width > limit || height > limit) {
      return 'Generation is limited to ' + limit + ' px per side by this GPU. Reduce Scale or resize the lens.';
    }
    return '';
  }
  get requirementError(): string {
    if (this.requiresSelection && !this.editor.image.selectionMask) return 'Create a selection before running this generator.';
    if (this.selectedModel?.capabilities.maskRequired && !this.editor.image.selectionMask) return 'This model requires a selection mask.';
    return '';
  }

  abstract renderSpecific(container: HTMLElement): void;
  abstract run(): Promise<void>;

  renderBeforeModel(_container: HTMLElement): void {}

  open(): void {
    this.fitLens();
    this.chooseDefaultModel();
    this.selectionSignature = this.currentSelectionSignature();
    this.notify();
  }

  close(): void {
    clearTimeout(this.autoTimer);
    this.cancel();
    this.releaseResult();
    this.onChange = undefined;
  }

  validate(): void {
    if (this.running && (this.running.documentId !== this.editor.image.id || this.running.root !== this.editor.image.root)) this.cancel();
    if (this.result && (!this.editor.image.allLayers().includes(this.result) || this.result.source !== this.resultSource)) {
      this.releaseResult();
      this.cancel();
    }
    const signature = this.currentSelectionSignature();
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    if (!this.supportsAutoRun || !this.autoRun || !this.editor.image.selectionMask) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = window.setTimeout(() => {
      if (this.busy) this.cancel();
      this.runWhenIdle();
    }, 220);
  }

  chooseDefaultModel(): void {
    const models = this.models;
    if (models.some((model) => model.id === this.model)) return;
    this.model = this.defaultModel(models)?.id ?? models[0]?.id ?? '';
    this.modelRequest++;
    this.resolvingModel = '';
    this.clearFailure();
  }

  protected defaultModel(models: readonly GenerationModel[]): GenerationModel | undefined { return models[0]; }

  async selectModel(id: string): Promise<boolean> {
    const request = ++this.modelRequest;
    this.model = id;
    this.resolvingModel = id;
    this.settingsChanged();
    try {
      const resolved = await this.service.resolveModel(id);
      if (this.model !== id || this.modelRequest !== request) return false;
      if (!resolved.types?.some((type) => this.modelTypes.includes(type))) {
        this.error = 'This model does not support this generator.';
        return false;
      }
      if (this.requiresSelection && !resolved.capabilities.mask) {
        this.error = 'This model does not accept a mask.';
        return false;
      }
      return true;
    } catch (error) {
      if (this.model === id && this.modelRequest === request) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (this.modelRequest === request) { this.resolvingModel = ''; this.notify(); }
    }
  }

  settingsChanged(): void { this.clearFailure(); this.notify(); }

  private clearFailure(): void {
    this.error = '';
    if (this.progress.phase === 'Generation failed') this.progress = { phase: 'Ready', step: 0, steps: 0 };
  }

  fitLens(): void {
    if (this.busy) return;
    this.lens.fit(this.editor.image.width, this.editor.image.height);
  }

  editLens(edit: (lens: GenerationLens) => void): void {
    if (this.busy) return;
    edit(this.lens);
  }

  recordLensTransform(_before: Matrix): void { this.notify(); }

  async inputPreview(): Promise<GeneratorInputPreview> {
    const model = this.selectedModel;
    if (!model || this.busy) return { input: null, mask: null };
    const frame = this.frame;
    const selection = model.capabilities.mask || this.requiresSelection ? this.editor.image.selectionMask : null;
    const excluded = !this.includeResult && this.result ? [this.result] : [];
    const capture = this.editor.compositor.captureGenerationInput(this.editor.image.root, frame, selection, excluded);
    let mask = capture.mask;
    if (mask && this.feather > 0) {
      const feathered = this.masks.create(mask, frame, this.feather, capture.input);
      if (feathered !== mask) { mask.destroy(); mask = feathered; }
    }
    try {
      const [inputPixels, maskPixels] = await Promise.all([
        model.capabilities.inputImages ? this.editor.readback.rgba(capture.input) : Promise.resolve(null),
        mask ? this.editor.readback.rgba(mask, true) : Promise.resolve(null),
      ]);
      const [input, maskImage] = await Promise.all([
        inputPixels ? rgbaToPng(inputPixels, frame.width, frame.height) : Promise.resolve(null),
        maskPixels ? rgbaToPng(maskPixels, frame.width, frame.height) : Promise.resolve(null),
      ]);
      return { input, mask: maskImage };
    } finally {
      capture.input.destroy();
      mask?.destroy();
    }
  }

  protected async generate(): Promise<void> {
    if (this.busy || !this.model || this.requiresPrompt && !this.prompt.trim()) return;
    if (!await this.selectModel(this.model) || !this.canGenerate) return;
    this.editor.finishGesture();
    const model = this.selectedModel!;
    const run: RunningRequest = {
      id: crypto.randomUUID(),
      documentId: this.editor.image.id,
      root: this.editor.image.root,
      frame: this.frame,
      input: null,
      mask: null,
      controller: new AbortController(),
      pendingPreview: null,
      previewReading: false,
      finishing: false,
    };
    this.running = run;
    this.error = '';
    this.progress = { phase: 'Preparing input', step: 0, steps: 0 };
    this.notify();
    try {
      const selection = model.capabilities.mask ? this.editor.image.selectionMask : null;
      const excluded = !this.includeResult && this.result ? [this.result] : [];
      const capture = this.editor.compositor.captureGenerationInput(run.root, run.frame, selection, excluded);
      run.input = capture.input;
      run.mask = capture.mask;
      const sourceInput = capture.input;
      const feathered = run.mask ? this.masks.create(run.mask, run.frame, this.feather, sourceInput) : null;
      if (feathered !== run.mask) { run.mask?.destroy(); run.mask = feathered; }
      const requiresInput = !!model.capabilities.minimumInputImages;
      const requiresMask = !!model.capabilities.maskRequired || this.requiresSelection;
      const includeInput = requiresInput || this.sendInput;
      const [input, mask] = await Promise.all([
        model.capabilities.inputImages && includeInput ? this.editor.readback.rgba(sourceInput) : Promise.resolve(null),
        run.mask && includeInput && (requiresMask || this.sendMask) ? this.editor.readback.rgba(run.mask, true) : Promise.resolve(null),
      ]);
      if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
      if (this.requiresSelection && (!mask || !mask.some((value, index) => index % 4 === 0 && value > 0))) {
        throw new Error('The selection does not cover the generator lens.');
      }
      const result = await this.service.request({
        id: run.id,
        model: model.id,
        operation: this.operation,
        prompt: this.prompt,
        negativePrompt: this.negativePrompt,
        width: run.frame.width,
        height: run.frame.height,
        steps: this.steps,
        guidance: this.guidance,
        strength: this.strength,
        seed: this.seed,
        input,
        mask,
      }, {
        progress: (progress) => {
          if (!this.valid(run)) return;
          this.progress = progress;
          this.onChange?.();
        },
        preview: (blob) => {
          if (!this.valid(run) || run.finishing) return;
          run.pendingPreview = blob;
          this.setResultPreview(blob);
          void this.drainPreviews(run);
        },
      }, run.controller.signal);
      run.finishing = true;
      await this.installResult(run, result);
      const steps = this.progress.steps || this.steps;
      this.progress = { phase: 'Complete', step: steps, steps };
    } catch (error) {
      const cancelled = run.controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError';
      this.progress = { phase: cancelled ? 'Cancelled' : 'Generation failed', step: 0, steps: 0 };
      if (!cancelled) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.running === run) this.running = null;
      run.mask?.destroy();
      run.input?.destroy();
      this.notify();
    }
  }

  cancel(): void {
    const run = this.running;
    if (!run || run.controller.signal.aborted) return;
    run.controller.abort();
    run.pendingPreview = null;
    this.progress = { phase: 'Cancelling', step: 0, steps: 0 };
    this.notify();
  }

  apply(): void {
    if (!this.canApply) return;
    this.releaseResult();
    this.notify();
  }

  private valid(run: RunningRequest): boolean {
    return this.running === run && !run.controller.signal.aborted && this.editor.image.id === run.documentId && this.editor.image.root === run.root;
  }

  private currentSelectionSignature(): string {
    const selection = this.editor.image.selectionMask;
    return selection ? selection.id + ':' + selection.revision : '';
  }

  private target(): { parent: GroupLayer; index: number } {
    const selected = this.editor.generatorTarget;
    if (selected.parent) return { parent: selected.parent, index: selected.parent.children.indexOf(selected) + 1 };
    return { parent: this.editor.image.root, index: this.editor.image.root.children.length };
  }

  private async installResult(run: RunningRequest, blob: Blob): Promise<void> {
    const imported = await importImage(this.editor.gpu, this.editor.compositor.quads, this.resultName, blob);
    try {
      if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
      this.installPixels(imported.source, run);
      this.setResultPreview(blob);
    } finally { imported.source.destroy(); }
  }

  private async drainPreviews(run: RunningRequest): Promise<void> {
    if (run.previewReading) return;
    run.previewReading = true;
    try {
      while (run.pendingPreview && this.valid(run) && !run.finishing) {
        const blob = run.pendingPreview;
        run.pendingPreview = null;
        const imported = await importImage(this.editor.gpu, this.editor.compositor.quads, this.resultName + ' preview', blob);
        try {
          if (!this.valid(run) || run.finishing) continue;
          this.installPixels(imported.source, run);
        } finally { imported.source.destroy(); }
      }
    } catch (error) {
      if (this.valid(run)) this.editor.report(error);
    } finally { run.previewReading = false; }
  }

  private installPixels(generated: Surface, run: RunningRequest): void {
    this.editor.finishGesture();
    if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
    const frame = generationResultFrame(run.frame, generated.width, generated.height);
    const output = this.blend.apply(generated, run.mask, multiply(inverse(frame.transform), run.frame.transform));
    const layer = this.result;
    const previousFrame = this.resultFrame;
    this.resultSource = output;
    this.resultFrame = frame;
    if (layer && previousFrame) {
      // Change the native pixel grid without resetting user placement, including moves between groups.
      const transform = multiply(layer.transform, multiply(inverse(previousFrame.transform), frame.transform));
      try { run.edit = this.editor.image.updatePixels(layer, output, transform, this.label, run.edit); }
      catch (error) { this.releaseResult(); throw error; }
    } else {
      const { parent, index } = this.target();
      const created = new ImageLayer(this.resultName, output);
      this.result = created;
      try {
        created.setTransform(multiply(inverse(parent.worldTransform()), frame.transform));
        run.edit = this.editor.image.add(created, parent, index, true, this.label);
      } catch (error) {
        if (!created.parent) this.editor.compositor.release(created);
        this.releaseResult();
        throw error;
      }
    }
    this.notify();
  }

  private releaseResult(): void {
    // The document owns the layer and its pixels; Apply/Close only ends generator ownership.
    this.result = null;
    this.resultSource = null;
    this.resultFrame = null;
    this.clearResultPreview();
  }

  private setResultPreview(blob: Blob): void {
    const previous = this.resultPreviewUrl;
    this.resultPreviewUrl = URL.createObjectURL(blob);
    if (previous) URL.revokeObjectURL(previous);
    this.onChange?.();
  }

  private clearResultPreview(): void {
    if (this.resultPreviewUrl) URL.revokeObjectURL(this.resultPreviewUrl);
    this.resultPreviewUrl = '';
  }

  protected notify(): void {
    this.onChange?.();
    this.editor.changed();
  }

  private runWhenIdle(): void {
    if (!this.autoRun || !this.editor.image.selectionMask) return;
    if (this.busy) {
      this.autoTimer = window.setTimeout(() => this.runWhenIdle(), 80);
      return;
    }
    void this.run();
  }
}
