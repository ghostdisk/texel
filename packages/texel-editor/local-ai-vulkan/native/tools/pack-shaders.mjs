import { deflateSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = process.argv[2];
const separator = process.argv.indexOf('--');
const inputs = process.argv.slice(separator + 1);
if (!output || separator < 0 || !inputs.length) {
  throw new Error('Usage: pack-shaders.mjs <output> -- <namespace>=<directory>...');
}

const entries = [];
for (const input of inputs) {
  const equals = input.indexOf('=');
  if (equals < 1) throw new Error('Shader input must be namespace=directory: ' + input);
  const namespace = input.slice(0, equals);
  const directory = input.slice(equals + 1);
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (!file.isFile() || path.extname(file.name) !== '.spv') continue;
    entries.push({ name: `${namespace}/${path.basename(file.name, '.spv')}`, data: readFileSync(path.join(directory, file.name)) });
  }
}
entries.sort((left, right) => left.name.localeCompare(right.name));

const chunks = [];
const count = Buffer.alloc(4);
count.writeUInt32LE(entries.length);
chunks.push(count);
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(name.length, 0);
  header.writeUInt32LE(entry.data.length, 2);
  chunks.push(header, name, entry.data);
}
const raw = Buffer.concat(chunks);
const compressed = deflateSync(raw, { level: 9 });
const header = Buffer.alloc(16);
header.write('TXSHDR01', 0, 'ascii');
header.writeUInt32LE(raw.length, 8);
header.writeUInt32LE(compressed.length, 12);
writeFileSync(output, Buffer.concat([header, compressed]));
