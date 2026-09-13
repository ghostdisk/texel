const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const QUEUE_API = 'https://queue.fal.run';
const MODELS = [
  {
    id: 'fal/black-forest-labs/flux-1-dev-image-to-image',
    label: 'FLUX.1 Dev Image to Image',
    endpoint: 'fal-ai/flux/dev/image-to-image',
    fields: { steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/black-forest-labs/flux-general-image-to-image',
    label: 'FLUX General Image to Image',
    endpoint: 'fal-ai/flux-general/image-to-image',
    fields: { steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/black-forest-labs/flux-1-krea-image-to-image',
    label: 'FLUX.1 Krea Image to Image',
    endpoint: 'fal-ai/flux/krea/image-to-image',
    fields: { steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/qwen/qwen-image-image-to-image',
    label: 'Qwen Image Image to Image',
    endpoint: 'fal-ai/qwen-image/image-to-image',
    fields: { negativePrompt: true, steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/qwen/qwen-image-edit',
    label: 'Qwen Image Edit',
    endpoint: 'fal-ai/qwen-image-edit',
    fields: { negativePrompt: true, steps: true, guidance: true, seed: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/stability-ai/stable-diffusion-3-medium-image-to-image',
    label: 'Stable Diffusion 3 Medium Image to Image',
    endpoint: 'fal-ai/stable-diffusion-v3-medium/image-to-image',
    fields: { negativePrompt: true, steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 16 },
  },
  {
    id: 'fal/recraft/recraft-v3-image-to-image',
    label: 'Recraft V3 Image to Image',
    endpoint: 'fal-ai/recraft/v3/image-to-image',
    fields: { strength: true },
    capabilities: { maxDimension: 4096 },
  },
  {
    id: 'fal/playground-ai/playground-v2.5-image-to-image',
    label: 'Playground V2.5 Image to Image',
    endpoint: 'fal-ai/playground-v25/image-to-image',
    fields: { negativePrompt: true, steps: true, guidance: true, seed: true, strength: true },
    capabilities: { dimensionMultiple: 32 },
  },
];

function registerFal({ app, ipcMain, safeStorage }, ownerOf) {
  const jobs = new Map();

  function keyPath() { return path.join(app.getPath('userData'), 'fal-key.bin'); }

  async function readKey() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(await readFile(keyPath()));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read fal API key:', error);
      return '';
    }
  }

  async function writeKey(key) {
    if (!key) { await rm(keyPath(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    await mkdir(path.dirname(keyPath()), { recursive: true });
    await writeFile(keyPath(), safeStorage.encryptString(key));
  }

  async function errorMessage(response) {
    const text = await response.text();
    try {
      const value = JSON.parse(text);
      if (typeof value?.detail === 'string') return value.detail;
      if (Array.isArray(value?.detail)) return value.detail.map((item) => item.msg || JSON.stringify(item)).join('; ');
      return value?.error?.message || value?.error || value?.message || text || `fal request failed (${response.status}).`;
    } catch { return text || `fal request failed (${response.status}).`; }
  }

  async function request(url, key, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}`, ...options.headers },
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response;
  }

  function publicModel(model) {
    const fields = model.fields;
    return {
      id: model.id,
      label: model.label,
      capabilities: {
        inputImages: 1,
        minimumInputImages: 1,
        mask: false,
        negativePrompt: !!fields.negativePrompt,
        steps: !!fields.steps,
        guidance: !!fields.guidance,
        seed: !!fields.seed,
        denoiseStrength: !!fields.strength,
        partialPreview: false,
        ...model.capabilities,
      },
    };
  }

  function send(owner, message) {
    if (!owner.isDestroyed()) owner.webContents.send('fal:generation-event', message);
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Generation cancelled.', 'AbortError'));
      };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async function cancelRemote(job) {
    if (!job.requestId) return;
    try {
      await request(`${QUEUE_API}/${job.endpoint}/requests/${encodeURIComponent(job.requestId)}/cancel`, job.key, { method: 'PUT' });
    } catch (error) {
      if (!job.controller.signal.aborted) console.error('Unable to cancel fal generation:', error);
    }
  }

  ipcMain.handle('fal:key-status', (event) => ownerOf(event) ? readKey().then((key) => ({ configured: !!key })) : null);
  ipcMain.handle('fal:set-key', async (event, value) => {
    if (!ownerOf(event) || typeof value !== 'string' || value.length > 1024) return null;
    const key = value.trim();
    await writeKey(key);
    return { configured: !!key };
  });
  ipcMain.handle('fal:models', (event) => ownerOf(event) ? { data: MODELS.map(publicModel) } : null);
  ipcMain.handle('fal:cancel', (event, id) => {
    const owner = ownerOf(event);
    const job = typeof id === 'string' ? jobs.get(id) : null;
    if (!owner || !job || job.sender !== event.sender) return false;
    void cancelRemote(job);
    job.controller.abort();
    return true;
  });
  ipcMain.handle('fal:generate', async (event, generation) => {
    const owner = ownerOf(event);
    if (!owner || !generation || typeof generation !== 'object') throw new Error('Invalid fal generation request.');
    const { id, model: modelId, prompt, input } = generation;
    const model = MODELS.find((entry) => entry.id === modelId);
    if (typeof id !== 'string' || !id || jobs.has(id) || !model || typeof prompt !== 'string' ||
        !(input instanceof Uint8Array) || !input.byteLength) throw new Error('Invalid fal generation request.');
    const key = await readKey();
    if (!key) throw new Error('Add a fal API key in Settings before generating.');
    const body = { prompt, image_url: `data:image/png;base64,${Buffer.from(input).toString('base64')}` };
    if (model.fields.negativePrompt && generation.negativePrompt) body.negative_prompt = generation.negativePrompt;
    if (model.fields.steps && Number.isInteger(generation.steps)) body.num_inference_steps = generation.steps;
    if (model.fields.guidance && Number.isFinite(generation.guidance)) body.guidance_scale = generation.guidance;
    if (model.fields.strength && Number.isFinite(generation.strength)) body.strength = generation.strength;
    if (model.fields.seed && Number.isInteger(generation.seed) && generation.seed >= 0) body.seed = generation.seed;
    const controller = new AbortController();
    const job = { controller, sender: event.sender, endpoint: model.endpoint, key, requestId: '' };
    jobs.set(id, job);
    try {
      const submitted = await request(`${QUEUE_API}/${model.endpoint}`, key, {
        method: 'POST', body: JSON.stringify(body), signal: controller.signal,
      }).then((response) => response.json());
      if (typeof submitted?.request_id !== 'string') throw new Error('fal returned no request ID.');
      job.requestId = submitted.request_id;
      const requestUrl = `${QUEUE_API}/${model.endpoint}/requests/${encodeURIComponent(job.requestId)}`;
      while (true) {
        if (controller.signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
        const status = await request(`${requestUrl}/status?logs=1`, key, { signal: controller.signal }).then((response) => response.json());
        if (status.status === 'COMPLETED') break;
        if (status.status === 'FAILED') throw new Error(status.error || 'fal generation failed.');
        const log = Array.isArray(status.logs) ? status.logs.at(-1)?.message : '';
        const queued = status.status === 'IN_QUEUE';
        const position = Number.isInteger(status.queue_position) ? ` · position ${status.queue_position}` : '';
        send(owner, { id, type: 'progress', phase: log || (queued ? `Queued on fal${position}` : 'Generating with fal') });
        await delay(600, controller.signal);
      }
      const result = await request(requestUrl, key, { signal: controller.signal }).then((response) => response.json());
      const output = result.images?.[0] ?? result.data?.images?.[0] ?? result.image ?? result.data?.image;
      if (typeof output?.url !== 'string') throw new Error('fal returned no image.');
      const image = await fetch(output.url, { signal: controller.signal });
      if (!image.ok) throw new Error(await errorMessage(image));
      return {
        bytes: new Uint8Array(await image.arrayBuffer()),
        mediaType: image.headers.get('content-type') || output.content_type || 'image/png',
      };
    } finally { jobs.delete(id); }
  });

  return {
    stop: () => {
      for (const job of jobs.values()) { void cancelRemote(job); job.controller.abort(); }
      jobs.clear();
    },
  };
}

module.exports = { registerFal };
