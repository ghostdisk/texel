// Maintainer-only database refresh. The Fal runtime never imports this file.
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const CATALOG_API = 'https://api.fal.ai/v1/models';
const DATABASE_PATH = path.join(__dirname, 'model_defs.json');
const MODEL_DATABASE = require('./model_defs.json');
const TAG_MODEL_TYPES = new Map(Object.entries(MODEL_DATABASE.tagTypes ?? {}));

function normalizeTag(value) { return String(value).trim().toLowerCase().replace(/[_\s]+/g, '-'); }

function tagsFor(record) {
  return [...new Set((Array.isArray(record.metadata?.tags) ? record.metadata.tags : []).map(normalizeTag).filter(Boolean))];
}

function typesFor(tags) {
  const types = [...new Set(tags.flatMap((tag) => TAG_MODEL_TYPES.get(tag) ?? []))];
  return types.length ? types : ['general-editing'];
}

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

function objectSchema(openapi, schema) {
  return schemaVariants(openapi, schema).find((candidate) => candidate.type === 'object' || candidate.properties) ?? null;
}

function requestSchema(record) {
  const paths = record.openapi?.paths ?? {};
  const preferred = paths[`/${record.endpoint_id}`]?.post?.requestBody?.content?.['application/json']?.schema;
  if (preferred) return preferred;
  return Object.values(paths).map((pathItem) => pathItem.post?.requestBody?.content?.['application/json']?.schema).find(Boolean) ?? null;
}

function resultSchema(record) {
  const paths = record.openapi?.paths ?? {};
  const preferred = paths[`/${record.endpoint_id}/requests/{request_id}`]?.get?.responses?.['200']?.content?.['application/json']?.schema;
  if (preferred) return preferred;
  const queueResult = Object.entries(paths).find(([route, pathItem]) =>
    route.endsWith('/requests/{request_id}') && pathItem.get)?.[1].get?.responses?.['200']?.content?.['application/json']?.schema;
  if (queueResult) return queueResult;
  const operations = Object.values(paths).flatMap((pathItem) => [pathItem.get, pathItem.post]).filter(Boolean);
  return operations.flatMap((operation) => [operation.responses?.['200'], operation.responses?.['201'], operation.responses?.['202']])
    .map((response) => response?.content?.['application/json']?.schema).find(Boolean) ?? null;
}

function field(properties, names) { return names.find((name) => properties[name]) ?? null; }

function arrayLimit(openapi, schema) {
  return schemaVariants(openapi, schema).find((candidate) => candidate.type === 'array')?.maxItems;
}

function enumValues(openapi, schema) {
  return [...new Set(schemaVariants(openapi, schema).flatMap((candidate) => candidate.enum ?? []))];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function numericLimits(openapi, schema) {
  const variants = schemaVariants(openapi, schema);
  const minimum = variants.map((value) => value.minimum).filter(Number.isFinite);
  const maximum = variants.map((value) => value.maximum).filter(Number.isFinite);
  const multiples = variants.map((value) => value.multipleOf).filter(Number.isFinite);
  return compact({
    min: minimum.length ? Math.max(...minimum) : undefined,
    max: maximum.length ? Math.min(...maximum) : undefined,
    multiple: multiples.length ? Math.max(...multiples) : undefined,
  });
}

function pixelArea(value) {
  const normalized = String(value).toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)K$/);
  const side = normalized === '512' ? 512 : match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isFinite(side)) return null;
  return side * side;
}

function shortSide(value) {
  const match = String(value).match(/^(\d+)p$/i);
  return match ? Number(match[1]) : null;
}

function imageSizePreset(value) {
  const presets = {
    square_hd: [1024, 1024], square: [512, 512], portrait_4_3: [768, 1024], portrait_16_9: [576, 1024],
    landscape_4_3: [1024, 768], landscape_16_9: [1024, 576],
  };
  const size = presets[value];
  return size ? { value, width: size[0], height: size[1] } : null;
}

function sizeMetadata(openapi, properties) {
  const imageSize = objectSchema(openapi, properties.image_size);
  const imageSizes = enumValues(openapi, properties.image_size).map(imageSizePreset).filter(Boolean);
  const aspectRatios = enumValues(openapi, properties.aspect_ratio).filter((value) => value !== 'auto');
  const resolutions = enumValues(openapi, properties.resolution);
  const pixelAreaBuckets = resolutions.map(pixelArea).filter((value) => value !== null);
  const shortSideBuckets = resolutions.map(shortSide).filter((value) => value !== null);
  const widthLimits = numericLimits(openapi, imageSize?.properties?.width ?? properties.width);
  const heightLimits = numericLimits(openapi, imageSize?.properties?.height ?? properties.height);
  return {
    fields: compact({
      imageSize: field(properties, ['image_size']),
      imageSizeObject: imageSize?.properties?.width && imageSize?.properties?.height ? true : undefined,
      width: field(properties, ['width']),
      height: field(properties, ['height']),
      aspectRatio: field(properties, ['aspect_ratio']),
      resolution: field(properties, ['resolution']),
    }),
    constraints: compact({
      aspectRatios: aspectRatios.length ? aspectRatios : undefined,
      minWidth: widthLimits.min,
      maxWidth: widthLimits.max,
      minHeight: heightLimits.min,
      maxHeight: heightLimits.max,
      granularity: widthLimits.multiple && widthLimits.multiple === heightLimits.multiple ? widthLimits.multiple :
        widthLimits.multiple || heightLimits.multiple ? { width: widthLimits.multiple ?? 1, height: heightLimits.multiple ?? 1 } : undefined,
      shortSideBuckets: shortSideBuckets.length ? shortSideBuckets : undefined,
      pixelAreaBuckets: pixelAreaBuckets.length ? pixelAreaBuckets : undefined,
      sizeBuckets: !imageSize && imageSizes.length ? imageSizes : undefined,
    }),
  };
}

function constraintsFromSchema(record) {
  const input = objectSchema(record.openapi, requestSchema(record));
  if (!input) return null;
  const metadata = sizeMetadata(record.openapi, input.properties ?? {});
  if (!Object.keys(metadata.constraints).length) return null;
  return { fields: metadata.fields, capabilities: { size: metadata.constraints } };
}

function definitionFromSchema(record) {
  const input = objectSchema(record.openapi, requestSchema(record));
  const output = objectSchema(record.openapi, resultSchema(record));
  if (!input || !output) return null;
  const properties = input.properties ?? {};
  const outputProperties = output.properties ?? {};
  const imageField = field(properties, ['image_urls', 'image_url', 'input_image_urls', 'input_image_url', 'input_images',
    'reference_images', 'reference_image_urls', 'source_image_url', 'input_image', 'image']);
  const outputField = field(outputProperties, ['images', 'image', 'image_urls', 'output_images', 'output_image', 'output_url', 'output', 'result']);
  if (!imageField || !outputField) return null;
  const promptField = field(properties, ['prompt', 'object_to_remove', 'objects_to_remove']);
  const maskField = field(properties, ['mask_url', 'mask_image_url', 'mask_urls', 'mask_image', 'mask']);
  const size = sizeMetadata(record.openapi, properties);
  const maximum = arrayLimit(record.openapi, properties[imageField]);
  const tags = tagsFor(record);
  let types = typesFor(tags);
  if (types.includes('object-removal-prompt')) {
    types = types.filter((type) => type !== 'object-removal-prompt');
    if (maskField) types.push('object-removal-mask');
    if (promptField) types.push('object-removal-prompt');
    if (!types.length) types.push('general-editing');
  }
  return {
    displayName: record.metadata?.display_name || record.endpoint_id,
    description: record.metadata?.description || undefined,
    tags,
    types,
    imageField,
    outputField,
    inputImages: Number.isInteger(maximum) ? Math.max(1, Math.min(16, maximum)) : 1,
    minimumInputImages: 1,
    promptField,
    fields: compact({
      negativePrompt: field(properties, ['negative_prompt']),
      steps: field(properties, ['num_inference_steps', 'steps']),
      guidance: field(properties, ['guidance_scale', 'guidance']),
      seed: field(properties, ['seed']),
      strength: field(properties, ['strength', 'denoising_strength', 'denoise_strength']),
      mask: maskField,
      outputFormat: field(properties, ['output_format']),
      ...size.fields,
      numImages: field(properties, ['num_images']),
    }),
    capabilities: compact({
      maskRequired: new Set(input.required ?? []).has(maskField) || undefined,
      size: Object.keys(size.constraints).length ? size.constraints : undefined,
    }),
  };
}

function mergeDefinition(generated, existing = {}) {
  const merged = {
    ...generated,
    ...existing,
    fields: generated.fields,
    capabilities: {
      ...generated.capabilities,
      ...existing.capabilities,
      size: { ...generated.capabilities?.size, ...existing.capabilities?.size },
    },
  };
  for (const key of ['imageField', 'outputField', 'inputImages', 'promptField']) {
    if (Object.prototype.hasOwnProperty.call(generated, key)) merged[key] = generated[key];
  }
  return merged;
}

function cleanDefinition(definition) {
  const size = definition.capabilities?.size;
  if (size) {
    for (const [key, value] of Object.entries(size)) if (Array.isArray(value) && !value.length) delete size[key];
    if (!Object.keys(size).length) delete definition.capabilities.size;
  }
  if (definition.capabilities && !Object.keys(definition.capabilities).length) delete definition.capabilities;
  return definition;
}

async function fetchJson(url, key) {
  const headers = key ? { Authorization: `Key ${key}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const error = new Error(`fal ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function listModels(key) {
  const records = [];
  const cursors = new Set();
  let cursor = '';
  do {
    const url = new URL(CATALOG_API);
    url.searchParams.set('limit', '100');
    url.searchParams.set('status', 'active');
    url.searchParams.set('category', 'image-to-image');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await fetchJson(url, key);
    records.push(...(page.models ?? []));
    const next = page.has_more && typeof page.next_cursor === 'string' ? page.next_cursor : '';
    cursor = next && !cursors.has(next) ? next : '';
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return records;
}

async function inspectModels(endpoints, key) {
  const url = new URL(CATALOG_API);
  for (const endpoint of endpoints) url.searchParams.append('endpoint_id', endpoint);
  url.searchParams.set('limit', String(endpoints.length));
  url.searchParams.set('expand', 'openapi-3.0');
  const response = await fetchJson(url, key);
  return response.models ?? [];
}

async function main() {
  const database = JSON.parse(await readFile(DATABASE_PATH, 'utf8'));
  const current = database.models ?? {};
  if (process.argv.includes('--clean')) {
    const sorted = Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right))
      .map(([endpoint, definition]) => [endpoint, cleanDefinition(definition)]));
    await writeFile(DATABASE_PATH, JSON.stringify({ schemaVersion: 1, tagTypes: database.tagTypes ?? {}, models: sorted }, null, 2) + '\n');
    process.stdout.write(`Updated ${DATABASE_PATH}\n`);
    return;
  }
  const models = { ...current };
  const key = process.env.FAL_KEY?.trim() || '';
  const records = await listModels(key);
  const discover = process.argv.includes('--discover');
  const refresh = process.argv.includes('--refresh');
  const available = new Map(records.map((record) => [record.endpoint_id, record]));
  const endpoints = discover ? [...available.keys()] : Object.keys(current).filter((endpoint) => available.has(endpoint));
  const pending = endpoints.filter((endpoint) => refresh || !current[endpoint]?.imageField || !current[endpoint]?.outputField);
  const batches = Array.from({ length: Math.ceil(pending.length / 10) }, (_, index) => pending.slice(index * 10, index * 10 + 10));
  let inspected = 0;
  for (const batch of batches) {
    if (inspected) await delay(8000);
    process.stdout.write(`\rInspecting fal models ${inspected + 1}-${inspected + batch.length}/${pending.length}`);
    try {
      const records = await inspectModels(batch, key);
      for (const record of records) {
        const generated = definitionFromSchema(record) ?? constraintsFromSchema(record);
        if (generated && current[record.endpoint_id]) models[record.endpoint_id] = mergeDefinition(generated, current[record.endpoint_id]);
      }
    } catch (error) {
      process.stderr.write(`\nUnable to inspect ${batch.join(', ')}: ${error.message}\n`);
      if (error.status === 429) {
        process.stderr.write('Fal rate limit reached; saved models can be resumed by running the updater again.\n');
        break;
      }
    }
    inspected += batch.length;
  }
  const sorted = Object.fromEntries(Object.entries(models).sort(([left], [right]) => left.localeCompare(right))
    .map(([endpoint, definition]) => [endpoint, cleanDefinition(definition)]));
  const output = { schemaVersion: 1, tagTypes: database.tagTypes ?? {}, models: sorted };
  await writeFile(DATABASE_PATH, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`\nUpdated ${DATABASE_PATH}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
