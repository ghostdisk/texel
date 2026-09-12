import type { Editor } from '../editor';
import { ImageLayer } from '../model/layers';
import type { Surface } from '../gpu/surface';
import type { GenerationVisual } from '../gpu/generation-overlay';
import { GenerationBlend } from '../gpu/generation-blend';
import { importImage } from '../gpu/images';
import { UndoOperation } from '../history/undo';
import { GenerationProviders } from './provider';
import type { GenerationModel, GenerationProgress } from './provider';
import { LocalGenerationProvider } from './local-provider';

interface RunningGeneration {
  id: string;
  documentId: string;
  layer: ImageLayer;
  source: Surface;
  revision: number;
  world: string;
  before: string;
  snapshots: Map<string, Surface>;
  mask: Surface | null;
  preview: Surface | null;
  controller: AbortController;
  finishing: boolean;
  pendingPreview: Blob | null;
  previewReading: boolean;
}

export class ImageGeneration {
  readonly providers = new GenerationProviders();
  models: readonly GenerationModel[] = [];
  model = '';
  prompt = '';
  negativePrompt = '';
  steps = 20;
  guidance = 6;
  strength = 1;
  seed = -1;
  progress: GenerationProgress = { phase: 'Connecting local backend', step: 0, steps: 0 };
  error = '';
  previewUrl = '';
  onChange?: () => void;
  private running: RunningGeneration | null = null;
  private readonly blend: GenerationBlend;

  constructor(private readonly editor: Editor) {
    this.providers.register(new LocalGenerationProvider());
    this.blend = new GenerationBlend(editor.gpu);
  }

  get busy(): boolean { return !!this.running; }
  get visual(): GenerationVisual | null {
    const run = this.running;
    return run && !run.controller.signal.aborted ? { layer: run.layer, mask: run.mask } : null;
  }
  get canGenerate(): boolean {
    const layer = this.editor.image.selected;
    return !this.busy && !!this.model && !!this.prompt.trim() && layer instanceof ImageLayer && layer.channels === 4;
  }

  private notify(): void { this.onChange?.(); this.editor.changed(); }

  async refreshModels(): Promise<void> {
    try {
      this.error = '';
      this.models = await this.providers.models();
      if (!this.models.some((model) => model.id === this.model)) this.model = this.models[0]?.id ?? '';
      this.progress = { phase: this.models.length ? 'Ready' : 'No local models found', step: 0, steps: 0 };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.progress = { phase: 'Backend unavailable', step: 0, steps: 0 };
    }
    this.notify();
  }

  private valid(run: RunningGeneration): boolean {
    return this.running === run && !run.controller.signal.aborted && this.editor.image.id === run.documentId &&
      this.editor.image.allLayers().includes(run.layer) && run.layer.source === run.source &&
      run.layer.revision === run.revision && JSON.stringify(run.layer.worldTransform()) === run.world;
  }

  validate(): void { if (this.running && !this.running.controller.signal.aborted && !this.valid(this.running)) this.cancel(); }

  private clearPreview(run: RunningGeneration): void {
    this.editor.compositor.setGenerationPreview(run.layer, null);
    run.revision = run.layer.revision;
    run.preview?.texture.destroy();
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
          const output = this.blend.apply(run.snapshots.get(run.before)!, imported.source, run.mask);
          const previous = run.preview;
          this.editor.compositor.setGenerationPreview(run.layer, output);
          run.preview = output;
          run.revision = run.layer.revision;
          previous?.texture.destroy();
          this.editor.requestRender();
        } finally { imported.sourceTexture.destroy(); }
      }
    } catch (error) {
      if (this.valid(run) && !run.finishing) { this.editor.report(error); this.cancel(); }
    } finally { run.previewReading = false; }
  }

  async generate(): Promise<void> {
    if (!this.canGenerate) return;
    this.editor.finishGesture();
    const layer = this.editor.image.selected as ImageLayer;
    const snapshots = new Map<string, Surface>();
    const before = this.editor.image.capturePixels(layer, snapshots);
    const run: RunningGeneration = {
      id: crypto.randomUUID(), documentId: this.editor.image.id, layer, source: layer.source, revision: layer.revision,
      world: JSON.stringify(layer.worldTransform()), before, snapshots, mask: null, preview: null,
      controller: new AbortController(), finishing: false, pendingPreview: null, previewReading: false,
    };
    this.running = run;
    this.error = '';
    this.progress = { phase: 'Preparing input', step: 0, steps: 0 };
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
    this.notify();
    let committed = false;
    try {
      const capture = this.editor.compositor.captureGenerationInput(layer, this.editor.image.selectionMask);
      run.mask = capture.mask;
      let input: Uint8Array<ArrayBuffer>;
      let mask: Uint8Array<ArrayBuffer> | null;
      try {
        [input, mask] = await Promise.all([
          this.editor.readback.rgba(capture.input), capture.mask ? this.editor.readback.rgba(capture.mask, true) : Promise.resolve(null),
        ]);
      } finally { capture.input.texture.destroy(); }
      if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
      if (mask && !mask.some((value, index) => index % 4 === 0 && value > 0)) throw new Error('The selection does not cover this layer.');
      const result = await this.providers.provider(this.model).generate({
        id: run.id, model: this.model, prompt: this.prompt, negativePrompt: this.negativePrompt, width: layer.width, height: layer.height,
        steps: this.steps, guidance: this.guidance, strength: this.strength, seed: this.seed, input, mask,
      }, {
        progress: (progress) => { if (this.valid(run)) { this.progress = progress; this.onChange?.(); } },
        preview: (blob) => {
          if (!this.valid(run) || run.finishing) return;
          this.showPreview(blob);
          run.pendingPreview = blob;
          void this.drainPreviews(run);
        },
      }, run.controller.signal);
      run.finishing = true;
      run.pendingPreview = null;
      const imported = await importImage(this.editor.gpu, this.editor.compositor.quads, 'Generated image', result);
      try {
        if (!this.valid(run)) throw new DOMException('Generation cancelled.', 'AbortError');
        const output = this.blend.apply(snapshots.get(before)!, imported.source, run.mask);
        const after = crypto.randomUUID();
        snapshots.set(after, output);
        this.clearPreview(run);
        layer.restorePixels(this.editor.gpu, output);
        this.running = null;
        this.editor.history.push(new UndoOperation(
          'Generate image',
          { type: 'layer', targetId: layer.id, action: 'pixels', data: { snapshotId: before } },
          { type: 'layer', targetId: layer.id, action: 'pixels', data: { snapshotId: after } },
          snapshots,
        ));
        committed = true;
        this.showPreview(result);
        this.progress = { phase: 'Complete', step: this.steps, steps: this.steps };
      } finally { imported.sourceTexture.destroy(); }
    } catch (error) {
      const cancelled = run.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.progress = { phase: cancelled ? 'Cancelled' : 'Generation failed', step: 0, steps: 0 };
      if (!cancelled) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.pendingPreview = null;
      if (this.running === run) { this.clearPreview(run); this.running = null; }
      run.mask?.texture.destroy();
      if (!committed) for (const snapshot of snapshots.values()) snapshot.texture.destroy();
      this.notify();
    }
  }
}