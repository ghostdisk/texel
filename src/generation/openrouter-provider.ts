import type { GenerationEvents, GenerationModel, GenerationProvider, GenerationRequest } from './provider';

async function encodePng(pixels: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to encode the OpenRouter input image.');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export class OpenRouterGenerationProvider implements GenerationProvider {
  readonly source = 'openrouter';
  readonly label = 'OpenRouter';
  private readonly entries = new Map<string, GenerationModel>();
  private readonly pending = new Map<string, GenerationEvents>();

  constructor() {
    window.desktop.onOpenRouterGeneration((event) => {
      const events = this.pending.get(event.id);
      if (events && event.type === 'preview') events.preview(new Blob([event.bytes], { type: event.mediaType }));
    });
  }

  async models(): Promise<readonly GenerationModel[]> {
    const response = await window.desktop.openRouterModels();
    if (!response?.data) throw new Error('OpenRouter model discovery failed.');
    this.entries.clear();
    for (const remote of response.data) {
      if (!remote.id || !remote.architecture?.output_modalities?.includes('image')) continue;
      const parameters = remote.supported_parameters ?? {};
      const references = parameters.input_references;
      const model: GenerationModel = {
        id: `${this.source}/${remote.id}`,
        label: remote.name || remote.id,
        source: this.source,
        capabilities: {
          inputImages: remote.architecture.input_modalities?.includes('image') ? Math.max(1, references?.max ?? 1) : 0,
          mask: false,
          negativePrompt: false,
          steps: false,
          guidance: false,
          seed: !!parameters.seed,
          denoiseStrength: false,
          partialPreview: !!remote.supports_streaming,
        },
      };
      this.entries.set(model.id, model);
    }
    return [...this.entries.values()];
  }

  async generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob> {
    const model = this.entries.get(request.model);
    if (!model) throw new Error('The selected OpenRouter model is unavailable. Refresh the model list.');
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: request.input && model.capabilities.inputImages ? 'Encoding input' : 'Starting generation', step: 0, steps: 0 });
    const input = request.input && model.capabilities.inputImages ? await encodePng(request.input, request.width, request.height) : null;
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: 'Generating with OpenRouter', step: 0, steps: 0 });
    const abort = () => { void window.desktop.cancelOpenRouterGeneration(request.id); };
    signal.addEventListener('abort', abort, { once: true });
    this.pending.set(request.id, events);
    try {
      const result = await window.desktop.openRouterGenerate({
        id: request.id,
        model: request.model.slice(this.source.length + 1),
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        input,
        seed: model.capabilities.seed ? request.seed : undefined,
        stream: model.capabilities.partialPreview,
      });
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      return new Blob([result.bytes], { type: result.mediaType });
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(request.id);
    }
  }
}
