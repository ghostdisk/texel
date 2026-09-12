import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dependencies = [
  { folder: 'stable-diffusion.cpp', url: 'https://github.com/leejet/stable-diffusion.cpp', revision: '7f410a3793c5bba8eb198e962ce7a3d6095f9d89', recursive: true },
  { folder: 'IXWebSocket', url: 'https://github.com/machinezone/IXWebSocket', revision: '2efe037c9cc96fd536774f17bdb5215161ee5087', recursive: false },
];
function run(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error('git exited with ' + result.status);
}
for (const dependency of dependencies) {
  const directory = path.join(root, 'third_party', dependency.folder);
  if (existsSync(path.join(directory, 'CMakeLists.txt'))) continue;
  run(['clone', dependency.url, directory]);
  run(['checkout', dependency.revision], directory);
  if (dependency.recursive) run(['submodule', 'update', '--init', '--recursive'], directory);
}
