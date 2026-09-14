const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const QUEUE_API = 'https://queue.fal.run';
const CATALOG_API = 'https://api.fal.ai/v1/models';
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

function schemaFields(properties) {
  const names = Object.keys(properties ?? {});
  if (!names.length) return 'no fields';
  const visible = names.slice(0, 20);
  return visible.join(', ') + (names.length > visible.length ? `, and ${names.length - visible.length} more` : '');
}

function incompatibleModelError(record) {
  const endpoint = record?.endpoint_id ?? 'unknown endpoint';
  if (!record?.openapi) return `fal endpoint "${endpoint}" has no OpenAPI schema.`;
  const request = requestSchema(record);
  if (!request) return `fal endpoint "${endpoint}" has no JSON request schema at POST /${endpoint}.`;
  const input = objectProperties(record.openapi, request);
  if (!input) return `fal endpoint "${endpoint}" has a request schema Texel could not resolve to an object.`;
  const result = resultSchema(record);
  if (!result) return `fal endpoint "${endpoint}" has no JSON result schema at GET /${endpoint}/requests/{request_id}.`;
  const output = objectProperties(record.openapi, result);
  if (!output) return `fal endpoint "${endpoint}" has a result schema Texel could not resolve to an object.`;
  const inputFields = input.properties ?? {};
  const outputFields = output.properties ?? {};
  const imageField = field(inputFields, ['image_urls', 'image_url', 'input_image_urls', 'input_image_url', 'source_image_url', 'input_image', 'image']);
  if (!imageField) {
    return `fal endpoint "${endpoint}" has no supported input image field. Request fields: ${schemaFields(inputFields)}.`;
  }
  const outputField = field(outputFields, ['images', 'image', 'output_images', 'output_image', 'output', 'result']);
  if (!outputField) {
    return `fal endpoint "${endpoint}" has no supported output image field. Result fields: ${schemaFields(outputFields)}.`;
  }
  return `fal endpoint "${endpoint}" uses an unsupported schema.`;
}

function classifyModel(record) {
  const metadata = record.metadata ?? {};
  const tags = [...new Set((Array.isArray(metadata.tags) ? metadata.tags : [])
    .map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
  const group = typeof metadata.group === 'string' ? metadata.group : [metadata.group?.key, metadata.group?.label].filter(Boolean).join(' ');
  const text = [record.endpoint_id, metadata.display_name, metadata.description, group, ...tags].filter(Boolean).join(' ').toLowerCase();
  const has = (...words) => words.some((word) => text.includes(word));
  const types = [];
  const expansion = has('outpaint', 'expand', 'reframe', 'uncrop');
  if (expansion) types.push('expand-reframe');
  if (has('upscale', 'upscaler', 'super resolution', 'super-resolution', 'enhance resolution')) types.push('upscale');
  if (has('restore', 'deblur', 'denoise', 'old photo', 'face enhance', 'scratch', 'restoration')) types.push('restore');
  if (has('relight', 'lighting', 'colorize', 'colourize', 'white balance', 'color correction', 'reseason')) types.push('lighting-color');
  if (has('style', 'stylized', 'toon', 'anime', 'sketch', 'transfer', 'perspective', 'expression change', 'multiple angles')) types.push('style-transform');
  if (has('product', 'fashion', 'try-on', 'tryon', 'portrait', 'headshot', 'subject', 'face', 'age progression')) types.push('subject-product');
  if (has('segment', 'detect', 'caption', 'vision', 'classif', 'background removal', 'matting')) types.push('selection-analysis');
  if (has('depth', 'normal map', 'pose', 'edge', 'canny', 'lineart', 'structure', 'extract')) types.push('structure-extraction');
  if (!types.length && has('/edit', 'edit-image', 'image edit', 'image-edit', '/modify', '/remix')) types.push('general-editing');
  if (!types.length && has('image-to-image', 'img2img', 'reference-to-image', 'variation')) types.push('generate-from-image');
  return { tags, types: [...new Set(types)] };
}

function objectRemovalCandidate(record) {
  const metadata = record.metadata ?? {};
  const text = [record.endpoint_id, metadata.display_name, metadata.description, ...(metadata.tags ?? [])]
    .filter(Boolean).join(' ').toLowerCase();
  if (text.includes('background removal') || text.includes('background remover') || text.includes('remove background') ||
      text.includes('replace background') || text.includes('background replace') || text.includes('text removal')) return false;
  return /(^|\/)object-removal(\/|$)/.test(record.endpoint_id) || /(^|[-_/ ])eraser([-_/ ]|$)/.test(text) ||
    /(^|\/)erase(_by_text)?$/.test(record.endpoint_id) || /(^|[-_/ ])remove-element([-_/ ]|$)/.test(text);
}

function inpaintCandidate(record) {
  const metadata = record.metadata ?? {};
  const group = typeof metadata.group === 'string' ? metadata.group : [metadata.group?.key, metadata.group?.label].filter(Boolean).join(' ');
  const text = [record.endpoint_id, metadata.display_name, metadata.description, group, ...(metadata.tags ?? [])]
    .filter(Boolean).join(' ').toLowerCase();
  if (['outpaint', 'expand', 'reframe', 'uncrop'].some((word) => text.includes(word))) return false;
  return ['inpaint', 'genfill', '/fill', '-fill', ' fill '].some((word) => text.includes(word));
}

function arrayLimit(openapi, schema) {
  const variant = schemaVariants(openapi, schema).find((candidate) => candidate.type === 'array');
  return variant?.maxItems;
}

function enumValues(openapi, schema) {
  return [...new Set(schemaVariants(openapi, schema).flatMap((candidate) => candidate.enum ?? []))];
}

function discoverModel(record) {
  if (!record?.endpoint_id || !record.openapi) return null;
  const input = objectProperties(record.openapi, requestSchema(record));
  const output = objectProperties(record.openapi, resultSchema(record));
  if (!input || !output) return null;
  const properties = input.properties ?? {};
  const outputProperties = output.properties ?? {};
  const imageField = field(properties, ['image_urls', 'image_url', 'input_image_urls', 'input_image_url', 'source_image_url', 'input_image', 'image']);
  const outputField = field(outputProperties, ['images', 'image', 'output_images', 'output_image', 'output', 'result']);
  if (!imageField || !outputField) return null;
  const promptField = field(properties, ['prompt', 'object_to_remove', 'objects_to_remove']);
  const maskField = field(properties, ['mask_url', 'mask_image_url', 'mask_urls', 'mask_image', 'mask']);
  const required = new Set(input.required ?? []);
  const maximum = arrayLimit(record.openapi, properties[imageField]);
  const imageSize = objectProperties(record.openapi, properties.image_size);
  const classification = classifyModel(record);
  if (objectRemovalCandidate(record)) {
    if (maskField) classification.types.push('object-removal-mask');
    if (promptField) classification.types.push('object-removal-prompt');
  }
  if (inpaintCandidate(record) && imageField && maskField && promptField) classification.types.push('fill-inpaint');
  return {
    id: `fal/${record.endpoint_id}`,
    label: record.metadata?.display_name || record.endpoint_id,
    endpoint: record.endpoint_id,
    imageField,
    outputField,
    inputImages: Number.isInteger(maximum) ? Math.max(1, Math.min(16, maximum)) : 1,
    minimumInputImages: 1,
    tags: classification.tags,
    types: classification.types,
    promptField,
    fields: {
      negativePrompt: field(properties, ['negative_prompt']),
      steps: field(properties, ['num_inference_steps', 'steps']),
      guidance: field(properties, ['guidance_scale', 'guidance']),
      seed: field(properties, ['seed']),
      strength: field(properties, ['strength', 'denoising_strength', 'denoise_strength']),
      mask: maskField,
      outputFormat: field(properties, ['output_format']),
      imageSize: field(properties, ['image_size']),
      width: field(properties, ['width']),
      height: field(properties, ['height']),
      aspectRatio: field(properties, ['aspect_ratio']),
      resolution: field(properties, ['resolution']),
      numImages: field(properties, ['num_images']),
    },
    sizing: {
      customImageSize: !!imageSize?.properties?.width && !!imageSize?.properties?.height,
      aspectRatios: enumValues(record.openapi, properties.aspect_ratio),
      resolutions: enumValues(record.openapi, properties.resolution),
    },
    capabilities: {
      maskRequired: required.has(maskField),
    },
  };
}

function catalogModel(record) {
  if (!record?.endpoint_id) return null;
  const classification = classifyModel(record);
  return {
    id: `fal/${record.endpoint_id}`,
    label: record.metadata?.display_name || record.endpoint_id,
    endpoint: record.endpoint_id,
    inputImages: 1,
    minimumInputImages: 1,
    tags: classification.tags,
    types: classification.types,
    fields: {},
    capabilities: {},
    resolved: false,
  };
}

function mappedField(value) { return typeof value === 'string' ? value : null; }

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
  const { fields, sizing } = model;
  if (fields.imageSize && sizing.customImageSize) body[fields.imageSize] = { width, height };
  else if (fields.width && fields.height) { body[fields.width] = width; body[fields.height] = height; }
  else if (fields.aspectRatio) {
    const ratio = closestSize(sizing.aspectRatios, width / height, (value) => {
      const match = typeof value === 'string' && value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
      return match ? Number(match[1]) / Number(match[2]) : NaN;
    });
    if (ratio !== null) body[fields.aspectRatio] = ratio;
  }
  if (fields.resolution) {
    // K presets describe approximate square-equivalent resolution, not the longest side.
    const resolution = closestSize(sizing.resolutions, Math.sqrt(width * height), (value) => {
      const match = String(value).match(/^(\d+(?:\.\d+)?)(K|px)?$/i);
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
  let catalogExpires = 0;
  let schemaCachePromise = null;

  function keyPath() { return path.join(app.getPath('userData'), 'fal-key.bin'); }
  function catalogCachePath() { return path.join(app.getPath('userData'), 'fal-model-catalog.json'); }
  function schemaCachePath() { return path.join(app.getPath('userData'), 'fal-model-schemas.json'); }

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

  async function fetchModelRecord(endpoint, key) {
    const url = new URL(CATALOG_API);
    url.searchParams.set('endpoint_id', endpoint);
    url.searchParams.set('expand', 'openapi-3.0');
    const response = await request(url.href, key).then((value) => value.json());
    const record = response.models?.find((candidate) => candidate.endpoint_id === endpoint);
    if (!record?.openapi) throw new Error(`fal returned no OpenAPI schema for endpoint "${endpoint}".`);
    return record;
  }

  async function discoverModels() {
    if (catalogPromise && Date.now() < catalogExpires) return catalogPromise;
    catalogExpires = Date.now() + 10 * 60 * 1000;
    catalogPromise = (async () => {
      const key = await readKey();
      let records;
      try {
        records = [];
        const cursors = new Set();
        let cursor = '';
        do {
          const url = new URL(CATALOG_API);
          url.searchParams.set('limit', '100');
          url.searchParams.set('status', 'active');
          url.searchParams.set('category', 'image-to-image');
          if (cursor) url.searchParams.set('cursor', cursor);
          const page = await request(url.href, key).then((response) => response.json());
          records.push(...(page.models ?? []));
          const nextCursor = page.has_more && typeof page.next_cursor === 'string' ? page.next_cursor : '';
          cursor = nextCursor && !cursors.has(nextCursor) ? nextCursor : '';
          if (cursor) cursors.add(cursor);
        } while (cursor);
        await writeJson(catalogCachePath(), { version: 1, records });
      } catch (error) {
        const cached = await readJson(catalogCachePath());
        if (!Array.isArray(cached?.records)) throw error;
        records = cached.records;
      }
      const cache = await schemaCache();
      let cacheChanged = false;
      const detailed = await Promise.all(records.map(async (record) => {
        if (!objectRemovalCandidate(record) && !inpaintCandidate(record)) return record;
        if (cache.models[record.endpoint_id]?.openapi) return cache.models[record.endpoint_id];
        try {
          const resolved = await fetchModelRecord(record.endpoint_id, key);
          cache.models[record.endpoint_id] = resolved;
          cacheChanged = true;
          return resolved;
        } catch (error) {
          console.error(`Unable to inspect fal image-editing endpoint "${record.endpoint_id}":`, error);
          return record;
        }
      }));
      if (cacheChanged) await writeJson(schemaCachePath(), cache);
      models = new Map(detailed.map((record) => record.openapi ? discoverModel(record) : catalogModel(record))
        .filter(Boolean).map((model) => [model.id, model]));
      return [...models.values()];
    })().catch((error) => {
      catalogPromise = null;
      catalogExpires = 0;
      if (models.size) return [...models.values()];
      throw error;
    });
    return catalogPromise;
  }

  async function schemaCache() {
    schemaCachePromise ??= readJson(schemaCachePath()).then((cached) => cached?.version === 1 && cached.models ? cached : { version: 1, models: {} });
    return schemaCachePromise;
  }

  async function resolveModel(modelId) {
    const current = models.get(modelId);
    if (!current) throw new Error('The selected fal model is unavailable. Refresh the model list.');
    if (current.resolved) return current;
    const key = await readKey();
    const cache = await schemaCache();
    let record;
    try {
      record = await fetchModelRecord(current.endpoint, key);
      cache.models[current.endpoint] = record;
      await writeJson(schemaCachePath(), cache);
    } catch (error) {
      record = cache.models[current.endpoint];
      if (!record?.openapi) throw error;
    }
    const resolved = discoverModel(record);
    if (!resolved) throw new Error(incompatibleModelError(record));
    resolved.resolved = true;
    models.set(modelId, resolved);
    return resolved;
  }

  function publicModel(model) {
    const fields = model.fields;
    return {
      id: model.id,
      ratingId: model.endpoint,
      label: model.label,
      tags: model.tags,
      types: model.types,
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
    catalogPromise = null;
    catalogExpires = 0;
    return { configured: !!key };
  });
  ipcMain.handle('fal:models', async (event) => ownerOf(event) ? { data: (await discoverModels()).map(publicModel) } : null);
  ipcMain.handle('fal:model', async (event, id) => {
    if (!ownerOf(event) || typeof id !== 'string') return null;
    return publicModel(await resolveModel(id));
  });
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
