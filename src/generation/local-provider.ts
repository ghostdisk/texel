import type { GenerationEvents, GenerationModel, GenerationProgress, GenerationProvider, GenerationRequest } from './provider';

interface PendingGeneration {
  id: string;
  events: GenerationEvents;
  resolve(image: Blob): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class LocalGenerationProvider implements GenerationProvider {
  readonly source = 'local';
  readonly label = 'Local';
  private socket: WebSocket | null = null;
  private connecting: Promise<readonly GenerationModel[]> | null = null;
  private pending: PendingGeneration | null = null;
  private recovering: Promise<void> | null = null;

  models(): Promise<readonly GenerationModel[]> {
    if (this.recovering) return this.recovering.then(() => this.models());
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    return this.connecting;
  }

  private async connect(): Promise<readonly GenerationModel[]> {
    try {
      const endpoint = await window.desktop.generationBackend();
      if (endpoint.error || !endpoint.url || !endpoint.token) throw new Error(endpoint.error ?? 'Local backend is unavailable.');
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint.url!);
        this.socket = socket;
        socket.binaryType = 'arraybuffer';
        const timer = setTimeout(() => { reject(new Error('Local backend connection timed out.')); socket.close(); }, 15000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: endpoint.token }));
        socket.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
          if (this.socket !== socket) return;
          try {
            if (typeof data === 'string') {
              const message = JSON.parse(data);
              if (message.type === 'models') {
                clearTimeout(timer);
                resolve((message.models as Omit<GenerationModel, 'capabilities'>[]).map((model) => ({
                  ...model,
                  label: model.label.startsWith('local/') ? model.label.slice('local/'.length) : model.label,
                  capabilities: model.task === 'remove' ? {
                    inputImages: 1, mask: true, negativePrompt: false, steps: false, guidance: false,
                    seed: false, denoiseStrength: false, partialPreview: true, maxDimension: 2048,
                  } : {
                    inputImages: 1, mask: true, negativePrompt: true, steps: true, guidance: true,
                    seed: true, denoiseStrength: true, partialPreview: true,
                    dimensionMultiple: 16, maxDimension: 2048,
                  },
                })));
                return;
              }
              if (!this.pending || message.id !== this.pending.id) return;
              if (message.type === 'progress') this.pending.events.progress(message as GenerationProgress);
              else if (message.type === 'cancelled') this.pending.reject(new DOMException('Generation cancelled.', 'AbortError'));
              else if (message.type === 'error') this.pending.reject(new Error(message.message));
            } else {
              const length = new DataView(data).getUint32(0, true);
              if (length > 65536 || length + 4 > data.byteLength) throw new Error('Invalid image message.');
              const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
              if (!this.pending || header.id !== this.pending.id) return;
              const image = new Blob([data.slice(4 + length)], { type: 'image/png' });
              if (header.type === 'preview') this.pending.events.preview(image);
              else if (header.type === 'result') this.pending.resolve(image);
            }
          } catch (error) {
            this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
            reject(error);
          }
        };
        const disconnected = () => {
          clearTimeout(timer);
          const error = new Error('The local generation backend disconnected.');
          if (this.socket === socket) {
            this.socket = null;
            this.connecting = null;
            this.pending?.reject(error);
          }
          reject(error);
        };
        socket.onclose = disconnected;
        socket.onerror = disconnected;
      });
    } catch (error) { this.connecting = null; throw error; }
  }

  async generate(request: GenerationRequest, events: GenerationEvents, signal: AbortSignal): Promise<Blob> {
    await this.models();
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    if (this.pending) throw new Error('Generation is already running.');
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('The local generation backend is not connected.');
    const { input, mask, operation, ...settings } = request;
    const inputBytes = input?.byteLength ?? 0;
    const header = new TextEncoder().encode(JSON.stringify({ type: operation ?? 'generate', ...settings, inputBytes, maskBytes: mask?.byteLength ?? 0 }));
    const packet = new Uint8Array(4 + header.byteLength + inputBytes + (mask?.byteLength ?? 0));
    new DataView(packet.buffer).setUint32(0, header.byteLength, true);
    packet.set(header, 4);
    if (input) packet.set(input, 4 + header.byteLength);
    if (mask) packet.set(mask, 4 + header.byteLength + inputBytes);
    return new Promise<Blob>((resolve, reject) => {
      let cancelTimer = 0;
      const finish = (error: Error | null, image?: Blob) => {
        if (this.pending?.id !== request.id) return;
        this.pending.cleanup();
        this.pending = null;
        if (error) reject(error);
        else resolve(image!);
      };
      const abort = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', id: request.id }));
        cancelTimer = window.setTimeout(() => {
          this.socket = null;
          this.connecting = null;
          socket.close();
          const recovery = window.desktop.restartGenerationBackend().then(() => {});
          this.recovering = recovery;
          void recovery.catch(() => {}).finally(() => {
            if (this.recovering === recovery) this.recovering = null;
            finish(new DOMException('Generation cancelled.', 'AbortError'));
          });
        }, 5000);
      };
      this.pending = {
        id: request.id, events,
        resolve: (image) => finish(signal.aborted ? new DOMException('Generation cancelled.', 'AbortError') : null, image),
        reject: (error) => finish(signal.aborted ? new DOMException('Generation cancelled.', 'AbortError') : error),
        cleanup: () => { signal.removeEventListener('abort', abort); clearTimeout(cancelTimer); },
      };
      signal.addEventListener('abort', abort, { once: true });
      try { socket.send(packet); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
