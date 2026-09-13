import type { Editor } from '../editor';
import { GroupLayer, ImageLayer } from '../model/layers';
import { inverse, multiply, transformBounds } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import type { Surface } from '../gpu/surface';
import type { GenerationVisual } from '../gpu/generation-overlay';
import { GenerationBlend } from '../gpu/generation-blend';
import { GenerationMask } from '../gpu/generation-mask';
import { LayerReframer } from '../gpu/reframe';
import { importImage } from '../gpu/images';
import { UndoOperation } from '../history/undo';
import { GenerationModelRegistry } from './provider';
import type { GenerationModel, GenerationProgress } from './provider';
import { LocalGenerationProvider } from './local-provider';
import { OpenRouterGenerationProvider } from './openrouter-provider';
import { FalGenerationProvider } from './fal-provider';
import { GenerationLens } from './lens';
import type { GenerationFrame } from './lens';
import { rgbaToPng } from './image-codec';

export interface GenerationInputPreview {
  input: Blob | null;
  mask: Blob | null;
}

interface RunningGeneration {
  removal: boolean;
  id: string;
  documentId: string;
  root: GroupLayer;
  lens: GenerationLens;
  frame: GenerationFrame;
  input: Surface | null;
  mask: Surface | null;
  preview: ImageLayer | null;
  controller: AbortController;
  finishing: boolean;
  pendingPreview: Blob | null;
  previewReading: boolean;
}

export class ImageGeneration {
  readonly registry = new GenerationModelRegistry();
  models: readonly GenerationModel[] = [];
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
  lens: GenerationLens;
  progress: GenerationProgress = { phase: 'Connecting local backend', step: 0, steps: 0 };
  error = '';
  previewUrl = '';
  onChange?: () => void;
  private running: RunningGeneration | null = null;
  private readonly blend: GenerationBlend;
  private readonly masks: GenerationMask;
  private readonly reframer: LayerReframer;
  private removalModel = '';

  constructor(private readonly editor: Editor) {
    this.registry.register(new LocalGenerationProvider());
    this.registry.register(new OpenRouterGenerationProvider());
    this.registry.register(new FalGenerationProvider());
    this.blend = new GenerationBlend(editor.gpu);
    this.masks = new GenerationMask(editor.gpu);
    this.reframer = editor.layerReframer;
    this.lens = new GenerationLens(editor.image.width, editor.image.height, () => this.notify());
  }

  get busy(): boolean { return !!this.running; }
  get removing(): boolean { return !!this.running?.removal; }
  get selectedModel(): GenerationModel | undefined { return this.registry.model(this.model); }
  get canRemove(): boolean { return !this.busy && !!this.editor.image.selectionMask; }
  get displayLens(): GenerationLens { return this.running?.lens ?? this.lens; }
  get frame(): GenerationFrame {
    return this.running?.frame ?? this.lens.frame(this.scale, this.selectedModel?.capabilities.dimensionMultiple);
  }
  get visual(): GenerationVisual | null {
    const run = this.running;
    return run?.input && !run.controller.signal.aborted ? { frame: run.frame, mask: run.mask, reference: run.input } : null;
  }
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
      return 'This model supports aspect ratios between 1:3 and 3:1. Resize the lens.';
    }
    return '';
  }
  get canGenerate(): boolean { return !this.busy && !!this.model && !!this.prompt.trim() && !this.sizeError; }

  async inputPreview(): Promise<GenerationInputPreview> {
    const model = this.selectedModel;
    if (!model || this.busy) return { input: null, mask: null };
    const frame = this.frame;
    const selection = model.capabilities.mask ? this.editor.image.selectionMask : null;
    const capture = this.editor.compositor.captureGenerationInput(this.editor.image.root, frame, selection);
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

  private notify(): void { this.onChange?.(); this.editor.changed(); }

  resetLens(width: number, height: number): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
    this.lens = new GenerationLens(width, height, () => this.notify());
  }

  fitLens(): void {
    if (this.busy) return;
    this.editor.finishGesture();
    const before = [...this.lens.transform] as unknown as Matrix;
    this.lens.fit(this.editor.image.width, this.editor.image.height);
    this.recordLensTransform(before);
  }

  editLens(edit: (lens: GenerationLens) => void): void {
    if (this.busy) return;
    const before = [...this.lens.transform] as unknown as Matrix;
    edit(this.lens);
    this.recordLensTransform(before);
  }

  recordLensTransform(before: Matrix): void {
    const after = this.lens.transform;
    if (before.every((value, index) => value === after[index])) return;
    this.editor.history.push(new UndoOperation(
      'Transform generation lens',
      { type: 'tool', targetId: 'generation', action: 'lens-transform', data: { transform: [...before] } },
      { type: 'tool', targetId: 'generation', action: 'lens-transform', data: { transform: [...after] } },
    ));
  }

  async refreshModels(): Promise<void> {
    try {
      this.error = '';
      const models = await this.registry.refresh();
      this.models = models.filter((model) => model.task !== 'remove');
      this.removalModel = models.find((model) => model.task === 'remove')?.id ?? '';
      if (!this.models.some((model) => model.id === this.model)) this.model = this.models[0]?.id ?? '';
      if (!this.busy) this.progress = { phase: this.models.length ? 'Ready' : 'No local models found', step: 0, steps: 0 };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      if (!this.busy) this.progress = { phase: 'Backend unavailable', step: 0, steps: 0 };
    }
    this.notify();
  }

  private valid(run: RunningGeneration): boolean {
    return this.running === run && !run.controller.signal.aborted && this.editor.image.id === run.documentId && this.editor.image.root === run.root;
  }

  validate(): void { if (this.running && !this.running.controller.signal.aborted && !this.valid(this.running)) this.cancel(); }

  private clearPreview(run: RunningGeneration): void {
    this.editor.compositor.setGenerationPreview(run.root, null);
    if (run.preview) this.editor.compositor.release(run.preview);
    run.preview = null;
  }

  cancel(): void {
    const run = this.running;
    if (!run || run.controller.signal.aborted) return;
    run.controller.abort();
    run.pendingPreview = null;
    this.clearPreview(run);
    this.progress = { phase: 'Cancelling', step: 0, steps: 0 };
    this.notify();
  }

  private showPreview(blob: Blob): void {
    const previous = this.previewUrl;
    this.previewUrl = URL.createObjectURL(blob);
    if (previous) URL.revokeObjectURL(previous);
    this.onChange?.();
  }

  private async drainPreviews(run: RunningGeneration): Promise<void> {
    if (run.previewReading) return;
    run.previewReading = true;
    try {
      while (run.pendingPreview && this.valid(run) && !run.finishing) {
        const blob = run.pendingPreview;
        run.pendingPreview = null;
        const imported = await importImage(this.editor.gpu, this.editor.compositor.quads, 'Generation preview', blob);
        try {
          if (!this.valid(run) || run.finishing) continue;
          const output = this.blend.apply(imported.source, run.frame, run.mask);
          if (run.preview) run.preview.replaceSource(output);
          else run.preview = new ImageLayer('Generation preview', output);
          run.preview.setTransform(multiply(inverse(run.root.worldTransform()), run.frame.transform));
          this.editor.compositor.setGenerationPreview(run.root, run.preview);
          this.editor.requestRender();
        } finally { imported.sourceTexture.destroy(); }
      }
    } catch (error) {
      if (this.valid(run) && !run.finishing) { this.editor.report(error); this.cancel(); }
    } finally { run.previewReading = false; }
  }

  async remove(): Promise<void> {
    if (!this.canRemove) return;
    if (!this.removalModel) await this.refreshModels();
    if (!this.canRemove) return;
    if (!this.removalModel) {
      throw new Error(this.error || 'MI-GAN is unavailable. Install its weights in models/inpaint and restart the native backend.');
    }
    await this.generate(true);
  }

  private async removalLens(run: RunningGeneration): Promise<GenerationLens> {
    const selection = this.editor.image.selectionMask;
    if (!selection) throw new Error('Removal requires a selection.');
    const source = this.editor.compositor.resolve(selection, 1);
    const revision = selection.revision;
    const transform = selection.worldTransform();
    const bounds = await this.reframer.contentBounds(source);
    if (!this.valid(run)) throw new DOMException('Removal cancelled.', 'AbortError');
    if (selection !== this.editor.image.selectionMask || selection.revision !== revision ||
        transform.some((value, index) => value !== selection.worldTransform()[index])) {
      throw new Error('The selection changed while preparing removal. Try again.');
    }
    if (!bounds) throw new Error('The selection is empty.');
    const world = transformBounds(transform, {
      x: source.bounds.x + bounds.x / source.scale, y: source.bounds.y + bounds.y / source.scale,
      width: bounds.width / source.scale, height: bounds.height / source.scale,
    });
    const canvas = this.editor.image;
    const left = Math.max(0, Math.floor(world.x) - 1), top = Math.max(0, Math.floor(world.y) - 1);
    const right = Math.min(canvas.width, Math.ceil(world.x + world.width) + 1);
    const bottom = Math.min(canvas.height, Math.ceil(world.y + world.height) + 1);
    if (right <= left || bottom <= top) throw new Error('The selection does not cover the canvas.');
    const side = Math.max(512, 2 * Math.max(right - left, bottom - top));
    const width = Math.min(canvas.width, side), height = Math.min(canvas.height, side);
    const x = Math.max(0, Math.min(canvas.width - width, Math.floor((left + right - width) / 2)));
    const y = Math.max(0, Math.min(canvas.height - height, Math.floor((top + bottom - height) / 2)));
    const lens = new GenerationLens(width, height);
    lens.setTransform([1, 0, 0, 1, x, y]);
    return lens;
  }

  async generate(removal = false): Promise<void> {
    if (removal ? !this.canRemove : !this.canGenerate) return;
    this.editor.finishGesture();
    const model = removal ? this.removalModel : this.model;
    const capabilities = this.registry.model(model)?.capabilities;
    const run: RunningGeneration = {
      removal,
      id: crypto.randomUUID(), documentId: this.editor.image.id, root: this.editor.image.root,
      lens: this.lens.snapshot(),
      frame: this.lens.frame(this.scale, capabilities?.dimensionMultiple),
      input: null, mask: null, preview: null,
      controller: new AbortController(), finishing: false, pendingPreview: null, previewReading: false,
    };
    this.running = run;
    this.error = '';
    this.progress = { phase: 'Preparing input', step: 0, steps: 0 };
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
    this.notify();
    try {
      if (removal) {
        run.lens = await this.removalLens(run);
        run.frame = run.lens.frame(1);
      }
      const modelCapabilities = this.registry.model(model)?.capabilities;
      const selection = modelCapabilities?.mask ? this.editor.image.selectionMask : null;
      const capture = this.editor.compositor.captureGenerationInput(run.root, run.frame, selection);
      run.input = capture.input;
      run.mask = capture.mask;
      const feathered = run.mask ? this.masks.create(run.mask, run.frame, removal ? 0 : this.feather, run.input) : null;
      if (feathered !== run.mask) { run.mask?.texture.destroy(); run.mask = feathered; }
      // Retain full-resolution selection coverage for the resulting layer; only
      // the inference transport is reduced for large removal crops.
      const requestFrame = removal ? run.lens.frame(Math.min(1, 2048 / Math.max(run.frame.width, run.frame.height))) : run.frame;
      let inputSurface = run.input, maskSurface = run.mask;
      let input: Uint8Array<ArrayBuffer> | null, mask: Uint8Array<ArrayBuffer> | null;
      try {
        if (requestFrame.width !== run.frame.width || requestFrame.height !== run.frame.height) {
          const bounds = { x: 0, y: 0, width: requestFrame.width, height: requestFrame.height };
          inputSurface = this.reframer.normalize(run.input, bounds, [bounds.width / run.frame.width, 0, 0, bounds.height / run.frame.height, 0, 0]);
        }
        if (removal) maskSurface = this.masks.support(run.mask!, requestFrame.width, requestFrame.height);
        const requiresInput = !!modelCapabilities?.minimumInputImages;
        const includeInput = removal || requiresInput || this.sendInput;
        [input, mask] = await Promise.all([
          modelCapabilities?.inputImages && includeInput ?
            this.editor.readback.rgba(inputSurface) : Promise.resolve(null),
          maskSurface && (removal || includeInput && this.sendMask) ?
            this.editor.readback.rgba(maskSurface, true) : Promise.resolve(null),
        ]);
      } finally {
        if (inputSurface !== run.input) inputSurface.texture.destroy();
        if (maskSurface !== run.mask) maskSurface?.texture.destroy();
      }
      if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
      if (mask && !mask.some((value, index) => index % 4 === 0 && value > 0)) {
        throw new Error(removal ? 'The selection does not cover the canvas.' : 'The selection does not cover the generation lens.');
      }
      const result = await this.registry.provider(model).generate({
        id: run.id, model, operation: removal ? 'remove' : undefined,
        prompt: removal ? '' : this.prompt, negativePrompt: removal ? '' : this.negativePrompt,
        width: requestFrame.width, height: requestFrame.height,
        steps: removal ? 1 : this.steps, guidance: removal ? 0 : this.guidance, strength: removal ? 1 : this.strength, seed: this.seed, input, mask,
      }, {
        progress: (progress) => {
          if (!this.valid(run)) return;
          this.progress = progress;
          if (removal) this.notify();
          else this.onChange?.();
        },
        preview: (blob) => {
          if (!this.valid(run) || run.finishing) return;
          this.showPreview(blob);
          run.pendingPreview = blob;
          void this.drainPreviews(run);
        },
      }, run.controller.signal);
      run.finishing = true;
      run.pendingPreview = null;
      await this.editor.files.whenIdle();
      if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
      const imported = await importImage(this.editor.gpu, this.editor.compositor.quads, 'Generated image', result);
      try {
        await this.editor.files.whenIdle();
        if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
        const output = this.blend.apply(imported.source, run.frame, run.mask);
        const layer = new ImageLayer(removal ? 'Removed selection' : 'Generated image', output);
        try {
          layer.setTransform(multiply(inverse(run.root.worldTransform()), run.frame.transform));
          this.clearPreview(run);
          this.running = null;
          this.editor.image.add(layer, run.root, run.root.children.length, true, removal ? 'Remove selection' : 'Generate image');
        } catch (error) { if (!layer.parent) this.editor.compositor.release(layer); throw error; }
        this.showPreview(result);
        const steps = this.progress.steps || (removal ? 1 : this.steps);
        this.progress = { phase: 'Complete', step: steps, steps };
      } finally { imported.sourceTexture.destroy(); }
    } catch (error) {
      const cancelled = run.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.progress = { phase: cancelled ? 'Cancelled' : removal ? 'Removal failed' : 'Generation failed', step: 0, steps: 0 };
      if (!cancelled) {
        this.error = error instanceof Error ? error.message : String(error);
        if (removal) this.editor.report(error);
      }
    } finally {
      run.pendingPreview = null;
      if (this.running === run) { this.clearPreview(run); this.running = null; }
      run.mask?.texture.destroy();
      run.input?.texture.destroy();
      this.notify();
    }
  }
}
