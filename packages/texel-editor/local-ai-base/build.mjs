import './setup.mjs';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const source = path.join(root, 'native');
const build = path.join(root, 'build', 'native');
const install = path.join(root, 'build', 'install');
function run(args) {
  const result = spawnSync('cmake', args, { cwd: source, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error('cmake exited with ' + result.status);
}

run(['--preset', 'release']);
run(['--build', '--preset', 'release']);
rmSync(install, { recursive: true, force: true });
run(['--install', build, '--prefix', install]);
