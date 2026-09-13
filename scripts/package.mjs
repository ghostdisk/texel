import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { build as buildRenderer } from 'vite';
import { build as packageApp, Platform, Arch } from 'electron-builder';
import path from 'node:path';
import config from '../electron-builder.cjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let directoryOnly = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dir') directoryOnly = true;
  else throw new Error('Usage: npm run dist -- [--dir]');
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The Windows release must be packaged on an x64 Windows host.');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(command + ' exited with ' + result.status);
}

await buildRenderer({ root });
for (const packageName of ['local-ai-base', 'local-ai-vulkan']) {
  run(process.execPath, [path.join(root, 'packages', 'texel-editor', packageName, 'build.mjs')]);
}
for (const file of [
  'packages/texel-editor/local-ai-base/build/install/texel-local-ai.exe',
  'packages/texel-editor/local-ai-vulkan/build/install/texel-local-ai-vulkan.dll',
  'packages/texel-editor/local-ai-vulkan/build/install/texel-local-ai-vulkan.shaders',
]) {
  if (!existsSync(path.join(root, file))) throw new Error('Package build did not produce ' + file + '.');
}
await packageApp({
  projectDir: root,
  config,
  targets: Platform.WINDOWS.createTarget([directoryOnly ? 'dir' : 'nsis'], Arch.x64),
  publish: 'never',
});
console.log(directoryOnly ? 'App folder: release/win-unpacked (launch Texel.exe).' : 'Installer: release/Texel-<version>-Setup.exe; app folder: release/win-unpacked.');
