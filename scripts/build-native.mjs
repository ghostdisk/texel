import './setup-native.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const preset = process.argv[2] || process.env.IMGED_NATIVE_PRESET || 'clang-vulkan';
const cwd = path.resolve(import.meta.dirname, '../native');
for (const args of [['--preset', preset], ['--build', '--preset', preset]]) {
  const result = spawnSync('cmake', args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error('cmake exited with ' + result.status);
}
