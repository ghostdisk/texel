import type { GenerationEvents, GenerationModel, GenerationProvider, GenerationRequest } from './provider';
import { rgbaToPng } from './image-codec';

export class FalGenerationProvider implements GenerationProvider {
  readonly platform = 'fal';
  readonly label = 'fal';
  private readonly entries = new Map<string, GenerationModel>();
  private readonly pending = new Map<string, GenerationEvents>();

  constructor() {
    window.desktop.onFalGeneration((event) => {
      const events = this.pending.get(event.id);
      if (events && event.type === 'progress') events.progress({ phase: event.phase, step: 0, steps: 0 });
    });
  }

  async models(): Promise<readonly GenerationModel[]> {
    const response = await window.desktop.falModels();
    if (!response?.data) throw new Error('fal model discovery failed.');
    const inspected = await Promise.all(response.data.map(async (entry) => {
      const needsObjectInspection = this.objectRemovalCandidate(entry.id) && !entry.types?.some((type) =>
        type === 'object-removal-mask' || type === 'object-removal-prompt');
      const needsInpaintInspection = this.inpaintCandidate(entry.id) &&
        (!entry.types?.includes('fill-inpaint') || !entry.capabilities.mask);
      if (!needsObjectInspection && !needsInpaintInspection) return entry;
      try { return await window.desktop.falModel(entry.id) ?? entry; }
      catch { return entry; }
    }));
    this.entries.clear();
    for (const entry of inspected) {
      const model = this.normalize({ ...entry, platform: this.platform });
      this.entries.set(model.id, model);
    }
    return [...this.entries.values()];
  }

  async resolveModel(id: string): Promise<GenerationModel> {
    const entry = await window.desktop.falModel(id);
    if (!entry) throw new Error('fal returned no model schema.');
    const model = this.normalize({ ...entry, platform: this.platform });
    this.entries.set(model.id, model);
    return model;
  }

  private objectRemovalCandidate(id: string): boolean {
    const endpoint = id.slice('fal/'.length).toLowerCase();
    if (endpoint.includes('background') || endpoint.includes('text-removal') || endpoint.endsWith('/bbox')) return false;
    return /(^|\/)object-removal(\/|$)/.test(endpoint) || /(^|[-_/])eraser([-_/]|$)/.test(endpoint) ||
      /(^|\/)erase(_by_text)?$/.test(endpoint) || /(^|[-_/])remove-element([-_/]|$)/.test(endpoint);
  }

  private inpaintCandidate(id: string): boolean {
    const endpoint = id.slice('fal/'.length).toLowerCase();
    if (['outpaint', 'expand', 'reframe', 'uncrop'].some((word) => endpoint.includes(word))) return false;
    return ['inpaint', 'genfill', '/fill', '-fill'].some((word) => endpoint.includes(word));
  }

  private normalize(model: GenerationModel): GenerationModel {
    const originalTypes = model.types as readonly string[] | undefined;
    const legacyRemoval = originalTypes?.includes('remove-replace') ?? false;
    const legacyInpaint = originalTypes?.includes('fill-inpaint') ?? false;
    const types = new Set((model.types ?? []).filter((type) => type !== 'fill-inpaint'));
    if (this.objectRemovalCandidate(model.id)) {
      if (model.capabilities.mask) types.add('object-removal-mask');
      if (model.capabilities.prompt || legacyRemoval && !model.capabilities.mask) types.add('object-removal-prompt');
    }
    if (this.inpaintCandidate(model.id) && model.capabilities.mask && (model.capabilities.prompt || legacyInpaint)) {
      types.add('fill-inpaint');
    }
    return { ...model, types: [...types] };
  }

  async generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob> {
    const model = this.entries.get(request.model);
    if (!model) throw new Error('The selected fal model is unavailable. Refresh the model list.');
    if (!request.input) throw new Error('This fal model requires a color image.');
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: request.mask && model.capabilities.mask ? 'Encoding inputs' : 'Encoding input', step: 0, steps: 0 });
    const [inputBlob, maskBlob] = await Promise.all([
      rgbaToPng(request.input, request.width, request.height),
      request.mask && model.capabilities.mask ? rgbaToPng(request.mask, request.width, request.height) : Promise.resolve(null),
    ]);
    const [input, mask] = await Promise.all([
      inputBlob.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      maskBlob?.arrayBuffer().then((buffer) => new Uint8Array(buffer)) ?? Promise.resolve(null),
    ]);
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: 'Submitting to fal', step: 0, steps: 0 });
    const abort = () => { void window.desktop.cancelFalGeneration(request.id); };
    signal.addEventListener('abort', abort, { once: true });
    this.pending.set(request.id, events);
    try {
      const result = await window.desktop.falGenerate({
        id: request.id,
        model: request.model,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        width: request.width,
        height: request.height,
        steps: request.steps,
        guidance: request.guidance,
        strength: request.strength,
        seed: request.seed,
        input,
        mask,
      });
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      return new Blob([result.bytes], { type: result.mediaType });
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(request.id);
    }
  }
}
