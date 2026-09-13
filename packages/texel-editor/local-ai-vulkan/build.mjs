import './setup.mjs';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const source = path.join(root, 'native');
const build = path.join(root, 'build', 'native');
const install = path.join(root, 'build', 'install');
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(command + ' exited with ' + result.status);
}

run('cmake', ['--preset', 'release']);
run('cmake', ['--build', '--preset', 'release']);
rmSync(install, { recursive: true, force: true });
mkdirSync(path.join(install, 'licenses'), { recursive: true });
run(process.execPath, [
  path.join(source, 'tools', 'pack-shaders.mjs'),
  path.join(install, 'texel-local-ai-vulkan.shaders'),
  '--',
  `stable=${path.join(build, 'stable-diffusion', 'ggml', 'src', 'ggml-vulkan', 'vulkan-shaders.spv')}`,
  `vision=${path.join(build, 'vision', 'visioncpp', 'depend', 'llama', 'ggml', 'src', 'ggml-vulkan', 'vulkan-shaders.spv')}`,
]);
copyFileSync(path.join(build, 'bin', 'texel-local-ai-vulkan.dll'), path.join(install, 'texel-local-ai-vulkan.dll'));
for (const [sourceFile, destination] of [
  ['stable-diffusion.cpp/LICENSE', 'stable-diffusion.txt'],
  ['stable-diffusion.cpp/ggml/LICENSE', 'ggml.txt'],
  ['vision.cpp/LICENSE', 'vision.cpp.txt'],
  ['vision.cpp/depend/llama/LICENSE', 'vision-ggml.txt'],
  ['volk/LICENSE.md', 'volk.txt'],
]) {
  copyFileSync(path.join(root, 'third_party', sourceFile), path.join(install, 'licenses', destination));
}
