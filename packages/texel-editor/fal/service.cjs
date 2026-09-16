const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const MODEL_DATABASE = require('./model_defs.json');

const QUEUE_API = 'https://queue.fal.run';
const CATALOG_API = 'https://api.fal.ai/v1/models';
const MODEL_DEFS = MODEL_DATABASE.models ?? {};
const TAG_MODEL_TYPES = new Map(Object.entries(MODEL_DATABASE.tagTypes ?? {}));

function normalizeTag(value) { return String(value).trim().toLowerCase().replace(/[_\s]+/g, '-'); }

function catalogTags(record) {
  return [...new Set((Array.isArray(record.metadata?.tags) ? record.metadata.tags : []).map(normalizeTag).filter(Boolean))];
}

function fallbackTypes(tags) {
  const types = [...new Set(tags.flatMap((tag) => TAG_MODEL_TYPES.get(tag) ?? []))];
  return types.length ? types : ['general-editing'];
}

function fallbackPromptField(types) {
  const prompted = new Set([
    'general-editing', 'generate-from-image', 'fill-inpaint', 'object-removal-prompt', 'expand-reframe',
    'lighting-color', 'style-transform', 'subject-product',
  ]);
  return types.some((type) => prompted.has(type)) ? 'prompt' : null;
}

function modelFromCatalog(record) {
  if (!record?.endpoint_id) return null;
  const definition = MODEL_DEFS[record.endpoint_id] ?? {};
  const tags = definition.tags ?? catalogTags(record);
  const types = definition.types ?? fallbackTypes(tags);
  const hasPromptField = Object.prototype.hasOwnProperty.call(definition, 'promptField');
  const fields = definition.fields ?? (types.includes('fill-inpaint') ? { mask: 'mask_url' } : {});
  return {
    id: `fal/${record.endpoint_id}`,
    label: definition.displayName || record.metadata?.display_name || record.endpoint_id,
    endpoint: record.endpoint_id,
    imageField: definition.imageField ?? 'image_url',
    outputField: definition.outputField ?? 'images',
    inputImages: definition.inputImages ?? 1,
    minimumInputImages: definition.minimumInputImages ?? 1,
    tags,
    types,
    ratings: definition.ratings,
    promptField: hasPromptField ? definition.promptField : fallbackPromptField(types),
    fields,
    capabilities: definition.capabilities ?? {},
  };
}

function mappedField(value) { return typeof value === 'string' ? value : null; }

const IMAGE_OUTPUT_FIELDS = ['images', 'image', 'image_urls', 'output_images', 'output_image', 'output_url', 'output', 'result', 'data'];

function imageOutput(value, preferred, seen = new Set()) {
  if (typeof value === 'string') return { url: value };
  if (Array.isArray(value)) {
    for (const entry of value) {
      const output = imageOutput(entry, preferred, seen);
      if (output) return output;
    }
    return null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.url === 'string') return value;
  for (const field of [...new Set([preferred, ...IMAGE_OUTPUT_FIELDS])]) {
    if (!field || !Object.prototype.hasOwnProperty.call(value, field)) continue;
    const output = imageOutput(value[field], null, seen);
    if (output) return output;
  }
  return null;
}

function assignFile(body, name, dataUrl) {
  body[name] = name.endsWith('urls') ? [dataUrl] : dataUrl;
}

function closestSize(values, target, measure) {
  let closest = null, distance = Infinity;
  for (const value of values) {
    const size = measure(value);
    if (!Number.isFinite(size) || size <= 0) continue;
    const difference = Math.abs(Math.log(size / target));
    if (difference < distance) { closest = value; distance = difference; }
  }
  return closest;
}

function assignSize(body, model, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('fal generation dimensions must be positive whole numbers.');
  }
  const { fields } = model;
  const constraints = model.capabilities.size ?? {};
  if (fields.imageSize && fields.imageSizeObject) body[fields.imageSize] = { width, height };
  else if (fields.imageSize && constraints.sizeBuckets?.some((bucket) => bucket.value)) {
    const presets = constraints.sizeBuckets.filter((bucket) => bucket.value);
    const preset = closestSize(presets, width / height, (value) => value.width / value.height);
    if (preset) body[fields.imageSize] = preset.value;
  }
  else if (fields.width && fields.height) { body[fields.width] = width; body[fields.height] = height; }
  else if (fields.aspectRatio) {
    const ratio = closestSize(constraints.aspectRatios ?? [], width / height, (value) => {
      const match = typeof value === 'string' && value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
      return match ? Number(match[1]) / Number(match[2]) : NaN;
    });
    if (ratio !== null) body[fields.aspectRatio] = ratio;
  }
  if (fields.resolution) {
    // K presets are square-equivalent resolution; p presets describe the short side.
    const shortSideBuckets = constraints.shortSideBuckets ?? [];
    const areaBuckets = constraints.pixelAreaBuckets ?? [];
    const resolutions = shortSideBuckets.length ? shortSideBuckets.map((value) => `${value}p`) :
      areaBuckets.map((value) => Math.sqrt(value) === 512 ? '0.5K' : `${Math.sqrt(value) / 1024}K`);
    const target = shortSideBuckets.length ? Math.min(width, height) : Math.sqrt(width * height);
    const resolution = closestSize(resolutions, target, (value) => {
      const match = String(value).match(/^(\d+(?:\.\d+)?)(K|p|px)?$/i);
      return match ? Number(match[1]) * (match[2]?.toLowerCase() === 'k' ? 1024 : 1) : NaN;
    });
    if (resolution !== null) body[fields.resolution] = resolution;
  }
}

function queueUrl(value, field) {
  let url;
  try { url = typeof value === 'string' ? new URL(value) : null; }
  catch { url = null; }
  if (!url || url.origin !== QUEUE_API || url.username || url.password) throw new Error(`fal returned an invalid ${field}.`);
  return url;
}

function registerFal({ app, ipcMain, safeStorage, keyStore, emit }, ownerOf) {
  const jobs = new Map();
  let models = new Map();
  let catalogPromise = null;

  function keyPath() { return path.join(app.getPath('userData'), 'fal-key.bin'); }
  function catalogCachePath() { return path.join(app.getPath('userData'), 'fal-model-catalog.json'); }

  async function readJson(filePath) {
    try { return JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read model cache:', error);
      return null;
    }
  }

  async function writeJson(filePath, value) {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(value));
    } catch (error) { console.error('Unable to write model cache:', error); }
  }

  async function readKey() {
    if (keyStore) return await keyStore.get('api-key');
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(await readFile(keyPath()));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read fal API key:', error);
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

  async function errorMessage(response) {
    const text = await response.text();
    const fallback = response.statusText || `HTTP ${response.status}`;
    try {
      const value = JSON.parse(text);
      if (typeof value?.detail === 'string') return value.detail;
      if (Array.isArray(value?.detail)) return value.detail.map((item) => item.msg || JSON.stringify(item)).join('; ');
      return value?.error?.message || value?.error || value?.message || text || fallback;
    } catch { return text || fallback; }
  }

  async function request(url, key, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (key) headers.Authorization = `Key ${key}`;
    const response = await fetch(url, {
      ...options,
      headers,
    });
    if (!response.ok) {
      const operation = `${options.method ?? 'GET'} ${new URL(url).pathname}`;
      throw new Error(`fal ${operation} failed (${response.status}): ${await errorMessage(response)}`);
    }
    return response;
  }

  async function discoverModels() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const key = await readKey();
      let records;
      try {
        const url = new URL(CATALOG_API);
        url.searchParams.set('limit', '1000');
        url.searchParams.set('status', 'active');
        url.searchParams.set('category', 'image-to-image');
        const page = await request(url.href, key).then((response) => response.json());
        records = Array.isArray(page.models) ? page.models : [];
        await writeJson(catalogCachePath(), { version: 2, records });
      } catch (error) {
        const cached = await readJson(catalogCachePath());
        if (!Array.isArray(cached?.records)) throw error;
        records = cached.records;
      }
      models = new Map(records.map(modelFromCatalog).filter(Boolean).map((model) => [model.id, model]));
      return [...models.values()];
    })();
    return catalogPromise;
  }

  async function resolveModel(modelId) {
    const current = models.get(modelId);
    if (!current) throw new Error('The selected fal model is unavailable. Refresh the model list.');
    return current;
  }

  function publicModel(model) {
    const fields = model.fields;
    return {
      id: model.id,
      label: model.label,
      tags: model.tags,
      types: model.types,
      ratings: model.ratings,
      capabilities: {
        inputImages: model.inputImages ?? 1,
        minimumInputImages: model.minimumInputImages ?? 1,
        prompt: !!model.promptField,
        mask: !!fields.mask,
        maskRequired: !!model.capabilities.maskRequired,
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
    if (emit) emit(owner.webContents, 'generation-event', message);
    else if (!owner.isDestroyed()) owner.webContents.send('fal:generation-event', message);
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
    if (!job.cancelUrl) return;
    try {
      await request(job.cancelUrl, job.key, { method: 'PUT' });
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
  ipcMain.handle('fal:models', async (event) => ownerOf(event) ? { data: (await discoverModels()).map(publicModel) } : null);
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
    const { id, model: modelId, prompt, input, mask } = generation;
    let model = models.get(modelId);
    if (typeof id !== 'string' || !id || jobs.has(id) || !model || typeof prompt !== 'string' ||
        !(input instanceof Uint8Array) || !input.byteLength) throw new Error('Invalid fal generation request.');
    model = await resolveModel(modelId);
    const key = await readKey();
    if (!key) throw new Error('Add a fal API key in Settings before generating.');
    const body = {};
    if (model.promptField) body[model.promptField] = prompt;
    const image = `data:image/png;base64,${Buffer.from(input).toString('base64')}`;
    assignFile(body, model.imageField ?? 'image_url', image);
    const negativePrompt = mappedField(model.fields.negativePrompt);
    const steps = mappedField(model.fields.steps);
    const guidance = mappedField(model.fields.guidance);
    const strength = mappedField(model.fields.strength);
    const seed = mappedField(model.fields.seed);
    const maskField = mappedField(model.fields.mask);
    const outputFormat = mappedField(model.fields.outputFormat);
    const numImages = mappedField(model.fields.numImages);
    if (negativePrompt && generation.negativePrompt) body[negativePrompt] = generation.negativePrompt;
    if (steps && Number.isInteger(generation.steps)) body[steps] = generation.steps;
    if (guidance && Number.isFinite(generation.guidance)) body[guidance] = generation.guidance;
    if (strength && Number.isFinite(generation.strength)) body[strength] = generation.strength;
    if (seed && Number.isInteger(generation.seed) && generation.seed >= 0) body[seed] = generation.seed;
    if (maskField && mask instanceof Uint8Array && mask.byteLength) {
      assignFile(body, maskField, `data:image/png;base64,${Buffer.from(mask).toString('base64')}`);
    }
    if (outputFormat) body[outputFormat] = 'png';
    if (numImages) body[numImages] = 1;
    assignSize(body, model, generation.width, generation.height);
    const controller = new AbortController();
    const job = { controller, sender: event.sender, key, cancelUrl: '' };
    jobs.set(id, job);
    try {
      const submitted = await request(`${QUEUE_API}/${model.endpoint}`, key, {
        method: 'POST', body: JSON.stringify(body), signal: controller.signal,
      }).then((response) => response.json());
      if (typeof submitted?.request_id !== 'string') throw new Error('fal returned no request ID.');
      // Queue routes can differ from the submission endpoint's model subpath.
      job.cancelUrl = queueUrl(submitted.cancel_url, 'cancel_url').href;
      const statusUrl = queueUrl(submitted.status_url, 'status_url');
      statusUrl.searchParams.set('logs', '1');
      const responseUrl = queueUrl(submitted.response_url, 'response_url').href;
      if (controller.signal.aborted) {
        await cancelRemote(job);
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      while (true) {
        if (controller.signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
        const status = await request(statusUrl.href, key, { signal: controller.signal }).then((response) => response.json());
        if (status.status === 'COMPLETED') break;
        if (status.status === 'FAILED') throw new Error(status.error || 'fal generation failed.');
        const log = Array.isArray(status.logs) ? status.logs.at(-1)?.message : '';
        const queued = status.status === 'IN_QUEUE';
        const position = Number.isInteger(status.queue_position) ? ` · position ${status.queue_position}` : '';
        send(owner, { id, type: 'progress', phase: log || (queued ? `Queued on fal${position}` : 'Generating with fal') });
        await delay(600, controller.signal);
      }
      const result = await request(responseUrl, key, { signal: controller.signal }).then((response) => response.json());
      const output = imageOutput(result, model.outputField);
      if (!output) throw new Error('fal returned no image.');
      const imageResponse = await fetch(output.url, { signal: controller.signal });
      if (!imageResponse.ok) throw new Error(await errorMessage(imageResponse));
      return {
        bytes: new Uint8Array(await imageResponse.arrayBuffer()),
        mediaType: imageResponse.headers.get('content-type') || output?.content_type || 'image/png',
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
