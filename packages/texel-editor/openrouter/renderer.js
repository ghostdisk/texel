export default class OpenRouterPackage {
  constructor(api) {
    this.api = api;
    this.pending = new Map();
    this.entries = new Map();
    this.removeListener = null;
    this.provider = {
      platform: 'openrouter',
      label: 'OpenRouter',
      models: () => this.models(),
      generate: (request, events, signal) => this.generate(request, events, signal),
    };
  }

  onLoad() {
    this.removeListener = this.api.messages.on('generation-event', (event) => {
      const events = this.pending.get(event.id);
      if (events && event.type === 'preview') events.preview(new Blob([event.bytes], { type: event.mediaType }));
    });
    this.api.core.models.registerProvider(this.provider);
  }

  onUnload() { this.removeListener?.(); }

  async models() {
    const response = await this.api.messages.invoke('models');
    if (!response?.data) throw new Error('OpenRouter model discovery failed.');
    this.entries.clear();
    for (const entry of response.data) {
      const model = { ...entry, platform: 'openrouter' };
      this.entries.set(model.id, model);
    }
    return [...this.entries.values()];
  }

  async generate(request, events, signal) {
    const model = this.entries.get(request.model);
    if (!model) throw new Error('The selected OpenRouter model is unavailable. Refresh the model list.');
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: request.input && model.capabilities.inputImages ? 'Encoding input' : 'Starting generation', step: 0, steps: 0 });
    const inputBlob = request.input && model.capabilities.inputImages ?
      await this.api.core.images.rgbaToPng(request.input, request.width, request.height) : null;
    const input = inputBlob ? new Uint8Array(await inputBlob.arrayBuffer()) : null;
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: 'Generating with OpenRouter', step: 0, steps: 0 });
    const abort = () => { void this.api.messages.invoke('cancel', request.id); };
    signal.addEventListener('abort', abort, { once: true });
    this.pending.set(request.id, events);
    try {
      const result = await this.api.messages.invoke('generate', {
        id: request.id,
        model: request.model.slice('openrouter/'.length),
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        input,
        seed: model.capabilities.seed ? request.seed : undefined,
        stream: model.capabilities.partialPreview && !input,
      });
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      return new Blob([result.bytes], { type: result.mediaType });
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(request.id);
    }
  }
}
