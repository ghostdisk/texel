import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const packageName of ['local-ai-base', 'local-ai-vulkan']) {
  const script = path.join(root, 'packages', 'texel-editor', packageName, 'build.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(packageName + ' build exited with ' + result.status);
}
