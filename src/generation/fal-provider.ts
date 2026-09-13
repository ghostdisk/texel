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
    this.entries.clear();
    for (const entry of response.data) {
      const model: GenerationModel = { ...entry, platform: this.platform };
      this.entries.set(model.id, model);
    }
    return [...this.entries.values()];
  }

  async generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob> {
    const model = this.entries.get(request.model);
    if (!model) throw new Error('The selected fal model is unavailable. Refresh the model list.');
    if (!request.input) throw new Error('This fal model requires a color image.');
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    events.progress({ phase: 'Encoding input', step: 0, steps: 0 });
    const inputBlob = await rgbaToPng(request.input, request.width, request.height);
    const input = new Uint8Array(await inputBlob.arrayBuffer());
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
      });
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      return new Blob([result.bytes], { type: result.mediaType });
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(request.id);
    }
  }
}
