export default class FalPackage {
  constructor(api) {
    this.api = api;
    this.entries = new Map();
    this.pending = new Map();
    this.removeListener = null;
    this.provider = {
      platform: 'fal',
      label: 'Fal.ai',
      models: () => this.models(),
      resolveModel: (id) => this.resolveModel(id),
      generate: (request, events, signal) => this.generate(request, events, signal),
    };
  }

  onLoad() {
    this.removeListener = this.api.messages.on('generation-event', (event) => {
      const events = this.pending.get(event.id);
      if (events && event.type === 'progress') events.progress({ phase: event.phase, step: 0, steps: 0 });
    });
    this.api.core.models.registerProvider(this.provider);
  }

  onUnload() { this.removeListener?.(); }

  async models() {
    const response = await this.api.messages.invoke('models');
    if (!response?.data) throw new Error('Fal.ai model discovery failed.');
    this.entries.clear();
    for (const entry of response.data) {
      const model = { ...entry, platform: 'fal' };
      this.entries.set(model.id, model);
    }
    return [...this.entries.values()];
  }

  async resolveModel(id) {
    const entry = await this.api.messages.invoke('model', id);
    if (!entry) throw new Error('Fal.ai returned no model definition.');
    const model = { ...entry, platform: 'fal' };
    this.entries.set(model.id, model);
    return model;
  }

  async generate(request, events, signal) {
    const model = this.entries.get(request.model);
    if (!model) throw new Error('The selected Fal.ai model is unavailable. Refresh the model list.');
    if (!request.input) throw new Error('This Fal.ai model requires a color image.');
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: request.mask && model.capabilities.mask ? 'Encoding inputs' : 'Encoding input', step: 0, steps: 0 });
    const [inputBlob, maskBlob] = await Promise.all([
      this.api.core.images.rgbaToPng(request.input, request.width, request.height),
      request.mask && model.capabilities.mask ?
        this.api.core.images.rgbaToPng(request.mask, request.width, request.height) : Promise.resolve(null),
    ]);
    const [input, mask] = await Promise.all([
      inputBlob.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      maskBlob?.arrayBuffer().then((buffer) => new Uint8Array(buffer)) ?? Promise.resolve(null),
    ]);
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: 'Submitting to Fal.ai', step: 0, steps: 0 });
    const abort = () => { void this.api.messages.invoke('cancel', request.id); };
    signal.addEventListener('abort', abort, { once: true });
    this.pending.set(request.id, events);
    try {
      const result = await this.api.messages.invoke('generate', {
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
