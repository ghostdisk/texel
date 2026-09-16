// Maintainer-only database refresh. The OpenRouter runtime never imports this file.
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const API = 'https://openrouter.ai/api/v1';
const DATABASE_PATH = path.join(__dirname, 'model_defs.json');

function enumValues(parameter) { return parameter?.type === 'enum' && Array.isArray(parameter.values) ? parameter.values : []; }

function pixelArea(value) {
  const match = String(value).match(/^(512|1K|2K|4K)$/i);
  if (!match) return null;
  const side = match[1].toUpperCase() === '512' ? 512 : Number(match[1][0]) * 1024;
  return side * side;
}

function definitionFromRemote(remote) {
  const imageInput = remote.architecture?.input_modalities?.includes('image');
  const parameters = remote.supported_parameters ?? {};
  const aspectRatios = enumValues(parameters.aspect_ratio).filter((value) => value !== 'auto');
  const pixelAreaBuckets = enumValues(parameters.resolution).map(pixelArea).filter((value) => value !== null);
  const size = {
    ...(aspectRatios.length ? { aspectRatios } : {}),
    ...(pixelAreaBuckets.length ? { pixelAreaBuckets } : {}),
  };
  return {
    displayName: remote.name || remote.id,
    tags: imageInput ? ['image-to-image'] : ['text-to-image'],
    types: imageInput ? ['general-editing', 'generate-from-image'] : ['generate-from-image'],
    ...(Object.keys(size).length ? { capabilities: { size } } : {}),
  };
}

function mergeDefinition(generated, existing = {}) {
  return {
    ...generated,
    ...existing,
    capabilities: generated.capabilities || existing.capabilities ? {
      ...generated.capabilities,
      ...existing.capabilities,
      size: { ...generated.capabilities?.size, ...existing.capabilities?.size },
    } : undefined,
  };
}

async function main() {
  const database = JSON.parse(await readFile(DATABASE_PATH, 'utf8'));
  const headers = process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {};
  const response = await fetch(`${API}/images/models`, { headers });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const catalog = await response.json();
  const models = { ...(database.models ?? {}) };
  for (const remote of catalog.data ?? []) {
    if (!remote.id || !remote.architecture?.output_modalities?.includes('image')) continue;
    models[remote.id] = mergeDefinition(definitionFromRemote(remote), models[remote.id]);
  }
  const sorted = Object.fromEntries(Object.entries(models).sort(([left], [right]) => left.localeCompare(right)));
  const profiles = database.profiles ?? {};
  const output = { schemaVersion: 1, ...(Object.keys(profiles).length ? { profiles } : {}), models: sorted };
  await writeFile(DATABASE_PATH, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`Updated ${DATABASE_PATH}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
