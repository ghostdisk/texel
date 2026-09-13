import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const directory = path.join(root, 'third_party', 'IXWebSocket');
if (!existsSync(path.join(directory, 'CMakeLists.txt'))) {
  const clone = spawnSync('git', ['clone', 'https://github.com/machinezone/IXWebSocket', directory], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (clone.error || clone.status !== 0) throw clone.error ?? new Error('git clone exited with ' + clone.status);
  const checkout = spawnSync('git', ['checkout', '2efe037c9cc96fd536774f17bdb5215161ee5087'], {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (checkout.error || checkout.status !== 0) throw checkout.error ?? new Error('git checkout exited with ' + checkout.status);
}
