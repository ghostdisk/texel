const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const QUEUE_API = 'https://queue.fal.run';
const CATALOG_API = 'https://api.fal.ai/v1/models';
const FALLBACK_MODELS = [
  {
    id: 'fal/black-forest-labs/flux-2-klein-4b-edit',
    label: 'FLUX.2 Klein 4B Edit',
    endpoint: 'fal-ai/flux-2/klein/4b/edit',
    imageField: 'image_urls',
    inputImages: 4,
    fields: { steps: true, seed: true },
    capabilities: {},
  },
  {
    id: 'fal/black-forest-labs/flux-2-klein-9b-edit',
    label: 'FLUX.2 Klein 9B Edit',
    endpoint: 'fal-ai/flux-2/klein/9b/edit',
    imageField: 'image_urls',
    inputImages: 4,
    fields: { steps: true, seed: true },
    capabilities: {},
  },
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

function resolveSchema(openapi, schema) {
  const seen = new Set();
  while (schema?.$ref?.startsWith('#/')) {
    if (seen.has(schema.$ref)) return null;
    seen.add(schema.$ref);
    schema = schema.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], openapi);
  }
  return schema ?? null;
}

function schemaVariants(openapi, schema) {
  const resolved = resolveSchema(openapi, schema);
  if (!resolved) return [];
  const branches = resolved.anyOf ?? resolved.oneOf ?? [];
  return [resolved, ...branches.map((branch) => resolveSchema(openapi, branch)).filter(Boolean)];
}

function objectProperties(openapi, schema) {
  for (const candidate of schemaVariants(openapi, schema)) {
    if (candidate.type === 'object' || candidate.properties) return candidate;
  }
  return null;
}

function requestSchema(record) {
  const pathItem = record.openapi?.paths?.[`/${record.endpoint_id}`];
  return pathItem?.post?.requestBody?.content?.['application/json']?.schema ?? null;
}

function resultSchema(record) {
  const pathItem = record.openapi?.paths?.[`/${record.endpoint_id}/requests/{request_id}`];
  return pathItem?.get?.responses?.['200']?.content?.['application/json']?.schema ?? null;
}

function field(properties, names) {
  return names.find((name) => properties[name]) ?? null;
}

function arrayLimit(openapi, schema) {
  const variant = schemaVariants(openapi, schema).find((candidate) => candidate.type === 'array');
  return variant?.maxItems;
}

function discoverModel(record) {
  if (!record?.endpoint_id || !record.openapi) return null;
  const input = objectProperties(record.openapi, requestSchema(record));
  const output = objectProperties(record.openapi, resultSchema(record));
  if (!input || !output) return null;
  const properties = input.properties ?? {};
  const outputProperties = output.properties ?? {};
  const imageField = field(properties, ['image_urls', 'image_url', 'input_image_urls', 'input_image_url', 'source_image_url']);
  const outputField = field(outputProperties, ['images', 'image', 'output_images', 'output_image']);
  if (!properties.prompt || !imageField || !outputField) return null;
  const required = new Set(input.required ?? []);
  const override = FALLBACK_MODELS.find((model) => model.endpoint === record.endpoint_id);
  const maximum = arrayLimit(record.openapi, properties[imageField]);
  return {
    id: override?.id ?? `fal/${record.endpoint_id}`,
    label: record.metadata?.display_name || override?.label || record.endpoint_id,
    endpoint: record.endpoint_id,
    imageField,
    outputField,
    inputImages: Number.isInteger(maximum) ? Math.max(1, Math.min(16, maximum)) : override?.inputImages ?? 1,
    minimumInputImages: 1,
    fields: {
      negativePrompt: field(properties, ['negative_prompt']),
      steps: field(properties, ['num_inference_steps', 'steps']),
      guidance: field(properties, ['guidance_scale', 'guidance']),
      seed: field(properties, ['seed']),
      strength: field(properties, ['strength', 'denoising_strength', 'denoise_strength']),
      mask: field(properties, ['mask_url', 'mask_image_url', 'mask_urls']),
      outputFormat: field(properties, ['output_format']),
      imageSize: field(properties, ['image_size']),
      numImages: field(properties, ['num_images']),
      ...override?.fields,
    },
    capabilities: {
      maskRequired: required.has(field(properties, ['mask_url', 'mask_image_url', 'mask_urls'])),
      ...override?.capabilities,
    },
  };
}

function mappedField(value, fallback) {
  if (typeof value === 'string') return value;
  return value ? fallback : null;
}

function assignFile(body, name, dataUrl) {
  body[name] = name.endsWith('urls') ? [dataUrl] : dataUrl;
}

function registerFal({ app, ipcMain, safeStorage }, ownerOf) {
  const jobs = new Map();
  let models = new Map(FALLBACK_MODELS.map((model) => [model.id, model]));
  let catalogPromise = null;
  let catalogExpires = 0;

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
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (key) headers.Authorization = `Key ${key}`;
    const response = await fetch(url, {
      ...options,
      headers,
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response;
  }

  async function discoverModels() {
    if (catalogPromise && Date.now() < catalogExpires) return catalogPromise;
    catalogExpires = Date.now() + 10 * 60 * 1000;
    catalogPromise = (async () => {
      const key = await readKey();
      const discovered = new Map();
      const cursors = new Set();
      let cursor = '';
      do {
        const url = new URL(CATALOG_API);
        url.searchParams.set('limit', '50');
        url.searchParams.set('status', 'active');
        url.searchParams.set('category', 'image-to-image');
        url.searchParams.set('expand', 'openapi-3.0');
        if (cursor) url.searchParams.set('cursor', cursor);
        const page = await request(url.href, key).then((response) => response.json());
        for (const record of page.models ?? []) {
          const model = discoverModel(record);
          if (model) discovered.set(model.id, model);
        }
        const nextCursor = page.has_more && typeof page.next_cursor === 'string' ? page.next_cursor : '';
        cursor = nextCursor && !cursors.has(nextCursor) ? nextCursor : '';
        if (cursor) cursors.add(cursor);
      } while (cursor);
      for (const fallback of FALLBACK_MODELS) {
        if (!discovered.has(fallback.id)) discovered.set(fallback.id, fallback);
      }
      models = discovered;
      return [...models.values()];
    })().catch((error) => {
      catalogPromise = null;
      catalogExpires = 0;
      if (models.size) return [...models.values()];
      throw error;
    });
    return catalogPromise;
  }

  function publicModel(model) {
    const fields = model.fields;
    return {
      id: model.id,
      ratingId: model.endpoint,
      label: model.label,
      capabilities: {
        inputImages: model.inputImages ?? 1,
        minimumInputImages: model.minimumInputImages ?? 1,
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
    catalogPromise = null;
    catalogExpires = 0;
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
    const model = models.get(modelId);
    if (typeof id !== 'string' || !id || jobs.has(id) || !model || typeof prompt !== 'string' ||
        !(input instanceof Uint8Array) || !input.byteLength) throw new Error('Invalid fal generation request.');
    const key = await readKey();
    if (!key) throw new Error('Add a fal API key in Settings before generating.');
    const body = { prompt };
    const image = `data:image/png;base64,${Buffer.from(input).toString('base64')}`;
    assignFile(body, model.imageField ?? 'image_url', image);
    const negativePrompt = mappedField(model.fields.negativePrompt, 'negative_prompt');
    const steps = mappedField(model.fields.steps, 'num_inference_steps');
    const guidance = mappedField(model.fields.guidance, 'guidance_scale');
    const strength = mappedField(model.fields.strength, 'strength');
    const seed = mappedField(model.fields.seed, 'seed');
    const maskField = mappedField(model.fields.mask, 'mask_url');
    const outputFormat = mappedField(model.fields.outputFormat, 'output_format');
    const numImages = mappedField(model.fields.numImages, 'num_images');
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
      const value = result[model.outputField ?? 'images'] ?? result.data?.[model.outputField ?? 'images'];
      const output = Array.isArray(value) ? value[0] : value;
      const outputUrl = typeof output === 'string' ? output : output?.url;
      if (typeof outputUrl !== 'string') throw new Error('fal returned no image.');
      const imageResponse = await fetch(outputUrl, { signal: controller.signal });
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
