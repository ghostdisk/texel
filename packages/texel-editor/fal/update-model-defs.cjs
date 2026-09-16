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
  return record.openapi?.paths?.[`/${record.endpoint_id}`]?.post?.requestBody?.content?.['application/json']?.schema ?? null;
}

function resultSchema(record) {
  const pathItem = record.openapi?.paths?.[`/${record.endpoint_id}/requests/{request_id}`];
  return pathItem?.get?.responses?.['200']?.content?.['application/json']?.schema ?? null;
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

function definitionFromSchema(record) {
  const input = objectSchema(record.openapi, requestSchema(record));
  const output = objectSchema(record.openapi, resultSchema(record));
  if (!input || !output) return null;
  const properties = input.properties ?? {};
  const outputProperties = output.properties ?? {};
  const imageField = field(properties, ['image_urls', 'image_url', 'input_image_urls', 'input_image_url', 'source_image_url', 'input_image', 'image']);
  const outputField = field(outputProperties, ['images', 'image', 'output_images', 'output_image', 'output', 'result']);
  if (!imageField || !outputField) return null;
  const promptField = field(properties, ['prompt', 'object_to_remove', 'objects_to_remove']);
  const maskField = field(properties, ['mask_url', 'mask_image_url', 'mask_urls', 'mask_image', 'mask']);
  const imageSize = objectSchema(record.openapi, properties.image_size);
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
      imageSize: field(properties, ['image_size']),
      width: field(properties, ['width']),
      height: field(properties, ['height']),
      aspectRatio: field(properties, ['aspect_ratio']),
      resolution: field(properties, ['resolution']),
      numImages: field(properties, ['num_images']),
    }),
    sizing: {
      customImageSize: !!imageSize?.properties?.width && !!imageSize?.properties?.height,
      aspectRatios: enumValues(record.openapi, properties.aspect_ratio),
      resolutions: enumValues(record.openapi, properties.resolution),
    },
    capabilities: compact({ maskRequired: new Set(input.required ?? []).has(maskField) || undefined }),
  };
}

function mergeDefinition(generated, existing = {}) {
  return {
    ...generated,
    ...existing,
    fields: { ...generated.fields, ...existing.fields },
    sizing: { ...generated.sizing, ...existing.sizing },
    capabilities: { ...generated.capabilities, ...existing.capabilities },
  };
}

async function fetchJson(url, key) {
  const headers = key ? { Authorization: `Key ${key}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`fal ${response.status}: ${await response.text()}`);
  return response.json();
}

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

async function inspectModel(endpoint, key) {
  const url = new URL(CATALOG_API);
  url.searchParams.set('endpoint_id', endpoint);
  url.searchParams.set('expand', 'openapi-3.0');
  const response = await fetchJson(url, key);
  return response.models?.find((record) => record.endpoint_id === endpoint) ?? null;
}

async function main() {
  const database = JSON.parse(await readFile(DATABASE_PATH, 'utf8'));
  const current = database.models ?? {};
  const models = { ...current };
  const key = process.env.FAL_KEY?.trim() || '';
  const records = await listModels(key);
  for (const [index, summary] of records.entries()) {
    process.stdout.write(`\rInspecting fal models ${index + 1}/${records.length}`);
    try {
      const record = await inspectModel(summary.endpoint_id, key);
      const generated = record && definitionFromSchema(record);
      if (generated) models[summary.endpoint_id] = mergeDefinition(generated, current[summary.endpoint_id]);
    } catch (error) {
      process.stderr.write(`\nUnable to inspect ${summary.endpoint_id}: ${error.message}\n`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(models).sort(([left], [right]) => left.localeCompare(right)));
  const output = { schemaVersion: 1, tagTypes: database.tagTypes ?? {}, models: sorted };
  await writeFile(DATABASE_PATH, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`\nUpdated ${DATABASE_PATH}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
