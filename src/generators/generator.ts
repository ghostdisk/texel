import type { Editor } from '../editor';
import type { GenerationVisual } from '../gpu/generation-overlay';
import { GenerationBlend } from '../gpu/generation-blend';
import { GenerationMask } from '../gpu/generation-mask';
import { importImage } from '../gpu/images';
import type { Surface } from '../gpu/surface';
import { inverse, multiply } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { GroupLayer, ImageLayer } from '../model/layers';
import { rgbaToPng } from '../generation/image-codec';
import { GenerationLens } from '../generation/lens';
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
  includeTransient = false;
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
  private transient: ImageLayer | null = null;
  private transientParent: GroupLayer | null = null;
  private transientIndex = 0;
  private resolvingModel = '';
  private modelError = '';
  private selectionSignature = '';
  private autoTimer = 0;
  private readonly blend: GenerationBlend;
  private readonly masks: GenerationMask;

  constructor(protected readonly editor: Editor, protected readonly service: AIRequestService) {
    this.blend = new GenerationBlend(editor.gpu);
    this.masks = new GenerationMask(editor.gpu);
    this.lens = new GenerationLens(editor.image.width, editor.image.height, () => this.notify());
  }

  get models(): readonly GenerationModel[] {
    return this.service.models.filter((model) => model.types?.some((type) => this.modelTypes.includes(type)));
  }
  get selectedModel(): GenerationModel | undefined { return this.service.registry.model(this.model); }
  get busy(): boolean { return !!this.running; }
  get hasResult(): boolean { return !!this.transient; }
  get canApply(): boolean { return !this.busy && !!this.transient; }
  get canGenerate(): boolean {
    return !this.busy && !this.resolvingModel && !!this.model && (!this.requiresPrompt || !!this.prompt.trim()) &&
      (!this.requiresSelection || !!this.editor.image.selectionMask) && !this.sizeError && !this.requirementError;
  }
  get frame(): GenerationFrame { return this.lens.frame(this.scale, this.selectedModel?.capabilities.dimensionMultiple); }
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
    const limit = capabilities?.maxDimension ?? this.editor.gpu.device.limits.maxTextureDimension2D;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width > limit || height > limit) {
      return 'Generation is limited to ' + limit + ' px per side. Reduce Scale or resize the lens.';
    }
    const shortLimit = capabilities?.maxShortDimension;
    if (shortLimit && Math.min(width, height) > shortLimit) {
      return 'The shorter image side is limited to ' + shortLimit + ' px. Reduce Scale or resize the lens.';
    }
    const ratio = width / height;
    if (capabilities?.minAspectRatio && ratio < capabilities.minAspectRatio ||
        capabilities?.maxAspectRatio && ratio > capabilities.maxAspectRatio) {
      return 'This model does not support the lens aspect ratio.';
    }
    return '';
  }
  get requirementError(): string {
    if (this.modelError) return this.modelError;
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
    if (this.transient) this.apply(true);
    this.onChange = undefined;
  }

  validate(): void {
    if (this.running && (this.running.documentId !== this.editor.image.id || this.running.root !== this.editor.image.root)) this.cancel();
    if (this.transientParent && !this.editor.image.allLayers().includes(this.transientParent)) this.discardTransient();
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
    this.modelError = '';
  }

  protected defaultModel(models: readonly GenerationModel[]): GenerationModel | undefined { return models[0]; }

  async selectModel(id: string): Promise<boolean> {
    this.model = id;
    this.modelError = '';
    this.resolvingModel = id;
    this.notify();
    try {
      const resolved = await this.service.resolveModel(id);
      if (this.model !== id) return false;
      if (!resolved.types?.some((type) => this.modelTypes.includes(type))) {
        this.modelError = 'This model does not support this generator.';
        return false;
      }
      if (this.requiresSelection && !resolved.capabilities.mask) {
        this.modelError = 'This model does not accept a mask.';
        return false;
      }
      return true;
    } catch (error) {
      if (this.model === id) this.modelError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (this.resolvingModel === id) this.resolvingModel = '';
      this.notify();
    }
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
    const capture = this.editor.compositor.captureGenerationInput(this.editor.image.root, frame, selection, this.includeTransient);
    let mask = capture.mask;
    if (mask && this.feather > 0) {
      const feathered = this.masks.create(mask, frame, this.feather, capture.input);
      if (feathered !== mask) { mask.texture.destroy(); mask = feathered; }
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
      capture.input.texture.destroy();
      mask?.texture.destroy();
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
      const capture = this.editor.compositor.captureGenerationInput(run.root, run.frame, selection, this.includeTransient);
      run.input = capture.input;
      run.mask = capture.mask;
      const sourceInput = capture.input;
      const feathered = run.mask ? this.masks.create(run.mask, run.frame, this.feather, sourceInput) : null;
      if (feathered !== run.mask) { run.mask?.texture.destroy(); run.mask = feathered; }
      const requestScale = model.task === 'remove' ? Math.min(1, 2048 / Math.max(run.frame.width, run.frame.height)) : 1;
      const requestFrame = requestScale < 1 ? this.lens.frame(this.scale * requestScale, model.capabilities.dimensionMultiple) : run.frame;
      let inputSurface = sourceInput;
      let maskSurface = run.mask;
      try {
        if (requestFrame.width !== run.frame.width || requestFrame.height !== run.frame.height) {
          const bounds = { x: 0, y: 0, width: requestFrame.width, height: requestFrame.height };
          inputSurface = this.editor.layerReframer.normalize(sourceInput, bounds, [bounds.width / run.frame.width, 0, 0, bounds.height / run.frame.height, 0, 0]);
          if (run.mask) maskSurface = this.masks.support(run.mask, requestFrame.width, requestFrame.height);
        }
        const requiresInput = !!model.capabilities.minimumInputImages;
        const requiresMask = !!model.capabilities.maskRequired || this.requiresSelection;
        const includeInput = requiresInput || this.sendInput;
        const [input, mask] = await Promise.all([
          model.capabilities.inputImages && includeInput ? this.editor.readback.rgba(inputSurface) : Promise.resolve(null),
          maskSurface && includeInput && (requiresMask || this.sendMask) ? this.editor.readback.rgba(maskSurface, true) : Promise.resolve(null),
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
          width: requestFrame.width,
          height: requestFrame.height,
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
      } finally {
        if (inputSurface !== sourceInput) inputSurface.texture.destroy();
        if (maskSurface !== run.mask) maskSurface?.texture.destroy();
      }
    } catch (error) {
      const cancelled = run.controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError';
      this.progress = { phase: cancelled ? 'Cancelled' : 'Generation failed', step: 0, steps: 0 };
      if (!cancelled) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.running === run) this.running = null;
      run.mask?.texture.destroy();
      run.input?.texture.destroy();
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

  apply(force = false): void {
    const layer = this.transient;
    if (!layer || this.busy && !force) return;
    const parent = this.transientParent && this.editor.image.allLayers().includes(this.transientParent) ? this.transientParent : this.editor.image.root;
    const index = parent === this.transientParent ? Math.min(this.transientIndex, parent.children.length) : parent.children.length;
    this.editor.compositor.setGenerationPreview(parent, null);
    this.transient = null;
    this.transientParent = null;
    try {
      this.editor.image.add(layer, parent, index, true, this.label);
    } catch (error) {
      if (!layer.parent) this.editor.compositor.release(layer);
      throw error;
    }
    this.clearResultPreview();
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
      const output = this.blend.apply(imported.source, run.frame, run.mask);
      this.installTransient(output, run.frame);
      this.setResultPreview(blob);
    } finally { imported.sourceTexture.destroy(); }
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
          this.installTransient(this.blend.apply(imported.source, run.frame, run.mask), run.frame);
        } finally { imported.sourceTexture.destroy(); }
      }
    } catch (error) {
      if (this.valid(run)) this.editor.report(error);
    } finally { run.previewReading = false; }
  }

  private installTransient(output: Surface, frame: GenerationFrame): void {
    if (!this.transientParent) {
      const target = this.target();
      this.transientParent = target.parent;
      this.transientIndex = target.index;
    }
    if (this.transient) this.transient.replaceSource(output);
    else this.transient = new ImageLayer(this.resultName, output);
    this.transient.setTransform(multiply(inverse(this.transientParent.worldTransform()), frame.transform));
    this.editor.compositor.setGenerationPreview(this.transientParent, this.transient, this.transientIndex);
    this.editor.requestRender();
  }

  private discardTransient(): void {
    if (this.transient) this.editor.compositor.release(this.transient);
    if (this.transientParent) this.editor.compositor.setGenerationPreview(this.transientParent, null);
    this.transient = null;
    this.transientParent = null;
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
