import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { build as buildRenderer } from 'vite';
import { build as packageApp, Platform, Arch } from 'electron-builder';
import path from 'node:path';
import config from '../electron-builder.cjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let directoryOnly = false;
let preset = process.env.TEXEL_PACKAGE_PRESET || 'clang-vulkan-release';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dir') directoryOnly = true;
  else if (args[index] === '--preset' && args[index + 1]) preset = args[++index];
  else throw new Error('Usage: npm run dist -- [--dir] [--preset clang-vulkan-release|clang-cpu-release]');
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The Windows release must be packaged on an x64 Windows host.');
if (!['clang-vulkan-release', 'clang-cpu-release'].includes(preset)) throw new Error('Choose clang-vulkan-release or clang-cpu-release.');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(command + ' exited with ' + result.status);
}

await buildRenderer({ root });
run(process.execPath, [path.join(root, 'scripts/build-native.mjs'), preset]);

// Only this fixed staging directory is replaced; installed apps and models are never touched.
const stage = path.join(root, '.packaging', 'native');
if (path.relative(root, stage) !== path.join('.packaging', 'native')) throw new Error('Invalid native staging directory.');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
run('cmake', ['--install', path.join(root, 'native', 'build', preset), '--config', 'Release', '--prefix', stage, '--component', 'texel-runtime']);
for (const file of ['imged-native.exe', 'models.json']) {
  if (!existsSync(path.join(stage, file))) throw new Error('The native installation did not produce ' + file + '.');
}
await packageApp({
  projectDir: root,
  config,
  targets: Platform.WINDOWS.createTarget([directoryOnly ? 'dir' : 'nsis'], Arch.x64),
  publish: 'never',
});
console.log(directoryOnly ? 'App folder: release/win-unpacked (launch Texel.exe).' : 'Installer: release/Texel-<version>-Setup.exe; app folder: release/win-unpacked.');