const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { createWriteStream, existsSync } = require('node:fs');
const path = require('node:path');

class NativeBackend {
  constructor(root) {
    this.root = root;
    this.child = null;
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    const preset = process.env.IMGED_NATIVE_PRESET || 'clang-vulkan';
    const binary = process.env.IMGED_NATIVE_BINARY ||
      path.join(this.root, 'native', 'build', preset, 'bin', process.platform === 'win32' ? 'imged-native.exe' : 'imged-native');
    if (!existsSync(binary)) return Promise.resolve({ error: 'The local generation backend has not been built.' });
    const token = randomBytes(32).toString('hex');
    this.ready = new Promise((resolve) => {
      const log = createWriteStream(path.join(this.root, 'native', 'backend.log'), { flags: 'w' });
      const child = spawn(binary, ['--models', path.join(this.root, 'models'), '--config', path.join(this.root, 'native', 'models.json')], {
        cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, IMGED_BACKEND_TOKEN: token },
      });
      this.child = child;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => { finish({ error: 'The local generation backend did not start.' }); child.kill(); }, 30000);
      child.stderr.pipe(log);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) {
            finish({ url: 'ws://127.0.0.1:' + message.port, token, protocol: message.protocol });
          }
        } catch { log.write(line + '\n'); }
      });
      child.on('error', (error) => finish({ error: error.message }));
      child.on('close', (code) => {
        finish({ error: 'The local generation backend exited (' + code + '). See native/backend.log.' });
        lines.close();
        log.end();
        if (this.child === child) { this.child = null; this.ready = null; }
      });
      child.stdin.on('error', () => {});
    });
    return this.ready;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), 4000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end('shutdown\n');
    });
  }

  async restart() { await this.stop(); this.ready = null; return this.start(); }
}

module.exports = { NativeBackend };