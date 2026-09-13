const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { createWriteStream, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

class LocalAiHostProcess {
  constructor(api) {
    this.api = api;
    this.child = null;
    this.ready = null;
    this.backend = null;
    this.models = [];
  }

  configure(backend, models) {
    if (this.child) throw new Error('Cannot reconfigure local AI while it is running.');
    this.backend = backend;
    this.models = models;
  }

  paths() {
    const app = this.api.core.app;
    const executable = app.isPackaged ? this.api.files.resolve('runtime/texel-local-ai.exe') :
      this.api.files.resolve('build/native/bin/texel-local-ai.exe');
    const adjacentModels = path.join(path.dirname(app.getPath('exe')), 'models');
    const models = path.resolve(process.env.TEXEL_MODELS_DIR ||
      (existsSync(adjacentModels) ? adjacentModels : path.join(app.getPath('userData'), 'models')));
    const generatedConfig = this.models.length ? path.join(app.getPath('userData'), 'package-models.json') : null;
    const config = path.resolve(process.env.TEXEL_MODELS_CONFIG || generatedConfig || this.api.files.resolve('models.json'));
    const log = path.join(app.getPath('userData'), 'logs', 'local-ai.log');
    mkdirSync(path.dirname(log), { recursive: true });
    if (!process.env.TEXEL_MODELS_DIR) mkdirSync(models, { recursive: true });
    if (!process.env.TEXEL_MODELS_CONFIG && generatedConfig) {
      writeFileSync(generatedConfig, JSON.stringify({ models: this.models }, null, 2), 'utf8');
    }
    return { executable, models, config, log };
  }

  start() {
    if (this.ready) return this.ready;
    if (!this.backend) return Promise.resolve({ error: 'No local AI backend package is installed.' });
    let files;
    try { files = this.paths(); }
    catch (error) { return Promise.resolve({ error: 'Cannot prepare local AI: ' + error.message }); }
    if (!existsSync(files.executable)) return Promise.resolve({ error: 'The local AI host is missing: ' + files.executable });
    if (!existsSync(this.backend.library)) return Promise.resolve({ error: 'The local AI backend is missing: ' + this.backend.library });

    const token = randomBytes(32).toString('hex');
    this.ready = new Promise((resolve) => {
      const log = createWriteStream(files.log, { flags: 'w' });
      const child = spawn(files.executable, [
        '--backend', this.backend.library,
        '--models', files.models,
        '--config', files.config,
      ], {
        cwd: path.dirname(files.executable),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.backend.environment, IMGED_BACKEND_TOKEN: token },
      });
      this.child = child;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        finish({ error: 'Local AI did not start. See ' + files.log });
        child.kill();
      }, 30000);
      log.on('error', (error) => {
        finish({ error: 'Cannot write the local AI log: ' + error.message });
        child.kill();
      });
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
        finish({ error: 'Local AI exited (' + code + '). See ' + files.log });
        lines.close();
        log.end();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
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
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end('shutdown\n');
    });
  }

  async restart() {
    await this.stop();
    this.ready = null;
    return this.start();
  }
}

module.exports = { LocalAiHostProcess };
