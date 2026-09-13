import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const separator = process.argv.indexOf('--');
const output = process.argv[2];
const inputs = process.argv.slice(separator + 1);
if (!output || separator < 0 || !inputs.length) throw new Error('Usage: prefix-archives.mjs <output> -- <libraries...>');
mkdirSync(output, { recursive: true });

const symbols = new Set();
for (const input of inputs) {
  const result = spawnSync('llvm-nm', ['--defined-only', '--extern-only', '--format=posix', input], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error('llvm-nm exited with ' + result.status);
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line || line.endsWith(':')) continue;
    const symbol = line.split(' ')[0];
    if (!symbol || symbol.includes('texel_migan_') || symbol.includes('@visp@@')) continue;
    symbols.add(symbol);
  }
}

const mappings = path.join(output, 'symbols.txt');
writeFileSync(mappings, [...symbols].sort().map((symbol) => `${symbol} texel_vision_${symbol}`).join('\n'));
for (const input of inputs) {
  const destination = path.join(output, path.basename(input));
  const result = spawnSync('llvm-objcopy', ['--redefine-syms', mappings, input, destination], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error('llvm-objcopy exited with ' + result.status);
}
writeFileSync(path.join(output, 'complete.stamp'), new Date().toISOString());
