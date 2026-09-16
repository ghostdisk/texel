const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const MODEL_DATABASE = require('./model_defs.json');

const API = 'https://openrouter.ai/api/v1';
const MODEL_DEFS = MODEL_DATABASE.models ?? {};
const CAPABILITY_PROFILES = MODEL_DATABASE.profiles ?? {};

function enumValues(parameter) { return parameter?.type === 'enum' && Array.isArray(parameter.values) ? parameter.values : []; }

function pixelArea(value) {
  const match = String(value).match(/^(512|1K|2K|4K)$/i);
  if (!match) return null;
  const side = match[1].toUpperCase() === '512' ? 512 : Number(match[1][0]) * 1024;
  return side * side;
}

function remoteSizeConstraints(parameters) {
  const aspectRatios = enumValues(parameters.aspect_ratio).filter((value) => value !== 'auto');
  const pixelAreaBuckets = enumValues(parameters.resolution).map(pixelArea).filter((value) => value !== null);
  return {
    ...(aspectRatios.length ? { aspectRatios } : {}),
    ...(pixelAreaBuckets.length ? { pixelAreaBuckets } : {}),
  };
}

function ratioValue(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return match ? Number(match[1]) / Number(match[2]) : NaN;
}

function resolutionValue(value) {
  const pixels = pixelArea(value);
  return pixels ? Math.sqrt(pixels) : NaN;
}

function closestValue(values, target, measure) {
  let closest = null, distance = Infinity;
  for (const value of values) {
    const measured = measure(value);
    if (!Number.isFinite(measured) || measured <= 0) continue;
    const difference = Math.abs(Math.log(measured / target));
    if (difference < distance) { closest = value; distance = difference; }
  }
  return closest;
}

function modelFromRemote(remote) {
  if (!remote?.id || !remote.architecture?.output_modalities?.includes('image')) return null;
  const definition = MODEL_DEFS[remote.id] ?? {};
  const profile = CAPABILITY_PROFILES[definition.profile] ?? {};
  const parameters = remote.supported_parameters ?? {};
  const references = parameters.input_references;
  const imageInput = remote.architecture.input_modalities?.includes('image');
  const size = { ...remoteSizeConstraints(parameters), ...profile.capabilities?.size, ...definition.capabilities?.size };
  return {
    id: `openrouter/${remote.id}`,
    label: definition.displayName || remote.name || remote.id,
    tags: definition.tags ?? (imageInput ? ['image-to-image'] : ['text-to-image']),
    types: definition.types ?? (imageInput ? ['general-editing', 'generate-from-image'] : ['generate-from-image']),
    ratings: definition.ratings,
    capabilities: {
      inputImages: imageInput ? Math.max(1, references?.max ?? 1) : 0,
      minimumInputImages: references?.min,
      mask: false,
      negativePrompt: false,
      steps: false,
      guidance: false,
      seed: !!parameters.seed,
      denoiseStrength: false,
      partialPreview: !!remote.supports_streaming,
      ...profile.capabilities,
      ...definition.capabilities,
      size,
    },
    sizing: {
      aspectRatios: enumValues(parameters.aspect_ratio),
      resolutions: enumValues(parameters.resolution),
    },
  };
}

function registerOpenRouter({ app, ipcMain, safeStorage, keyStore, emit }, ownerOf) {
  const jobs = new Map();
  let catalogPromise = null;
  let modelsById = new Map();

  function keyPath() { return path.join(app.getPath('userData'), 'openrouter-key.bin'); }
  function modelCachePath() { return path.join(app.getPath('userData'), 'openrouter-model-catalog.json'); }

  async function readKey() {
    if (keyStore) return await keyStore.get('api-key');
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(await readFile(keyPath()));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read OpenRouter key:', error);
      return '';
    }
  }

  async function writeKey(key) {
    if (keyStore) { await keyStore.set('api-key', key); return; }
    if (!key) { await rm(keyPath(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    await mkdir(path.dirname(keyPath()), { recursive: true });
    await writeFile(keyPath(), safeStorage.encryptString(key));
  }

  async function readModelCache() {
    try { return JSON.parse(await readFile(modelCachePath(), 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read OpenRouter model cache:', error);
      return null;
    }
  }

  async function writeModelCache(value) {
    try {
      await mkdir(path.dirname(modelCachePath()), { recursive: true });
      await writeFile(modelCachePath(), JSON.stringify(value));
    } catch (error) { console.error('Unable to write OpenRouter model cache:', error); }
  }

  async function errorMessage(response) {
    const text = await response.text();
    try { return JSON.parse(text)?.error?.message || text || `OpenRouter request failed (${response.status}).`; }
    catch { return text || `OpenRouter request failed (${response.status}).`; }
  }

  async function request(pathname, options = {}) {
    const key = await readKey();
    const headers = { 'Content-Type': 'application/json', 'X-Title': 'Texel', ...options.headers };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(API + pathname, { ...options, headers });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response;
  }

  async function models() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      let response;
      try {
        response = await request('/images/models').then((value) => value.json());
        await writeModelCache(response);
      } catch (error) {
        response = await readModelCache();
        if (!response?.data) throw error;
      }
      const data = (response.data ?? []).map(modelFromRemote).filter(Boolean);
      modelsById = new Map(data.map((model) => [model.id.slice('openrouter/'.length), model]));
      return { data };
    })();
    return catalogPromise;
  }

  ipcMain.handle('openrouter:key-status', (event) => ownerOf(event) ? readKey().then((key) => ({ configured: !!key })) : null);
  ipcMain.handle('openrouter:set-key', async (event, value) => {
    if (!ownerOf(event) || typeof value !== 'string' || value.length > 512) return null;
    const key = value.trim();
    if (key && !key.startsWith('sk-or-')) throw new Error('Enter a valid OpenRouter API key.');
    await writeKey(key);
    return { configured: !!key };
  });
  ipcMain.handle('openrouter:models', async (event) => {
    if (!ownerOf(event)) return null;
    return models();
  });
  ipcMain.handle('openrouter:cancel', (event, id) => {
    const owner = ownerOf(event);
    const job = typeof id === 'string' ? jobs.get(id) : null;
    if (!owner || !job || job.sender !== event.sender) return false;
    job.controller.abort();
    return true;
  });
  ipcMain.handle('openrouter:generate', async (event, generation) => {
    const owner = ownerOf(event);
    if (!owner || !generation || typeof generation !== 'object') throw new Error('Invalid OpenRouter generation request.');
    const { id, model, prompt, width, height, input, seed, stream } = generation;
    if (typeof id !== 'string' || !id || jobs.has(id) || typeof model !== 'string' ||
        !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model) || typeof prompt !== 'string' ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('Invalid OpenRouter generation request.');
    }
    const key = await readKey();
    if (!key) throw new Error('Add an OpenRouter API key in Settings before generating.');
    const entry = modelsById.get(model);
    const body = { model, prompt, output_format: 'png', stream: !!stream };
    const aspectRatios = entry?.sizing?.aspectRatios ?? [];
    const resolutions = entry?.sizing?.resolutions ?? [];
    const aspectRatio = closestValue(aspectRatios, width / height, ratioValue);
    const resolution = closestValue(resolutions, Math.sqrt(width * height), resolutionValue);
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    if (resolution) body.resolution = resolution;
    if (!aspectRatio && !resolution) body.size = `${width}x${height}`;
    if (input instanceof Uint8Array && input.byteLength) {
      body.input_references = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(input).toString('base64')}` } }];
    }
    if (Number.isInteger(seed) && seed >= 0) body.seed = seed;
    const controller = new AbortController();
    jobs.set(id, { controller, sender: event.sender });
    try {
      const response = await request('/images', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!body.stream) {
        const result = await response.json();
        const image = result.data?.[0];
        if (!image?.b64_json) throw new Error('OpenRouter returned no image.');
        return { bytes: new Uint8Array(Buffer.from(image.b64_json, 'base64')), mediaType: image.media_type || 'image/png', cost: result.usage?.cost };
      }
      if (!response.body) throw new Error('OpenRouter returned an empty image stream.');
      const decoder = new TextDecoder();
      let pending = '';
      let completed = null;
      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const message = JSON.parse(data);
        if (message.type === 'image_generation.partial_image' && message.b64_json) {
          const eventValue = {
            id, type: 'preview', bytes: new Uint8Array(Buffer.from(message.b64_json, 'base64')), mediaType: 'image/png',
          };
          if (emit) emit(owner.webContents, 'generation-event', eventValue);
          else if (!owner.isDestroyed()) owner.webContents.send('openrouter:generation-event', eventValue);
        } else if (message.type === 'image_generation.completed' && message.b64_json) completed = message;
        else if (message.type === 'error') throw new Error(message.error?.message || 'OpenRouter generation failed.');
      };
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) handle(line);
      }
      pending += decoder.decode();
      if (pending) handle(pending);
      if (!completed?.b64_json) throw new Error('OpenRouter returned no completed image.');
      return {
        bytes: new Uint8Array(Buffer.from(completed.b64_json, 'base64')),
        mediaType: completed.media_type || 'image/png', cost: completed.usage?.cost,
      };
    } finally { jobs.delete(id); }
  });

  return { stop: () => { for (const job of jobs.values()) job.controller.abort(); jobs.clear(); } };
}

module.exports = { registerOpenRouter };
