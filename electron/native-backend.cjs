const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { createWriteStream, existsSync, mkdirSync, copyFileSync, constants } = require('node:fs');
const path = require('node:path');

class NativeBackend {
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.child = null;
    this.ready = null;
  }

  paths() {
    const { packaged, resourcesPath, userData, executableDirectory } = this.options;
    const preset = process.env.IMGED_NATIVE_PRESET || 'clang-vulkan';
    const nativeDirectory = packaged ? path.join(resourcesPath, 'native') : path.join(this.root, 'native');
    const defaultBinary = packaged ? path.join(nativeDirectory, 'imged-native.exe') :
      path.join(nativeDirectory, 'build', preset, 'bin', process.platform === 'win32' ? 'imged-native.exe' : 'imged-native');
    const adjacentModels = packaged ? path.join(executableDirectory, 'models') : path.join(this.root, 'models');
    const models = path.resolve(process.env.TEXEL_MODELS_DIR ||
      (existsSync(adjacentModels) ? adjacentModels : packaged ? path.join(userData, 'models') : adjacentModels));
    const config = path.resolve(process.env.TEXEL_MODELS_CONFIG || (packaged ? path.join(userData, 'models.json') : path.join(nativeDirectory, 'models.json')));
    const log = packaged ? path.join(userData, 'logs', 'native-backend.log') : path.join(nativeDirectory, 'backend.log');
    const binary = path.resolve(process.env.TEXEL_NATIVE_BINARY || process.env.IMGED_NATIVE_BINARY || defaultBinary);
    if (packaged) {
      mkdirSync(path.dirname(log), { recursive: true });
      if (!process.env.TEXEL_MODELS_DIR && models === path.join(userData, 'models')) mkdirSync(models, { recursive: true });
      if (!process.env.TEXEL_MODELS_CONFIG && !existsSync(config)) {
        try { copyFileSync(path.join(nativeDirectory, 'models.json'), config, constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
    return { binary, models, config, log, cwd: packaged ? path.dirname(binary) : this.root };
  }

  start() {
    if (this.ready) return this.ready;
    let files;
    try { files = this.paths(); }
    catch (error) { return Promise.resolve({ error: 'Cannot prepare the local generation backend: ' + error.message }); }
    if (!existsSync(files.binary)) return Promise.resolve({ error: 'The local generation backend is missing: ' + files.binary });
    const token = randomBytes(32).toString('hex');
    this.ready = new Promise((resolve) => {
      const log = createWriteStream(files.log, { flags: 'w' });
      const child = spawn(files.binary, ['--models', files.models, '--config', files.config], {
        cwd: files.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
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
      const timeout = setTimeout(() => { finish({ error: 'The local generation backend did not start. See ' + files.log }); child.kill(); }, 30000);
      log.on('error', (error) => { finish({ error: 'Cannot write the backend log: ' + error.message }); child.kill(); });
      child.stderr.pipe(log);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) {
            finish({ url: 'ws://127.0.0.1:' + message.port, token, protocol: message.protocol });
          }
        } catch { if (!log.destroyed) log.write(line + '\n'); }
      });
      child.on('error', (error) => finish({ error: error.message }));
      child.on('close', (code) => {
        finish({ error: 'The local generation backend exited (' + code + '). See ' + files.log });
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