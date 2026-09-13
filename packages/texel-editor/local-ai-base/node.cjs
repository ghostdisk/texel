const { LocalAiHostProcess } = require('./host-process.cjs');

module.exports = class LocalAiBasePackage {
  constructor(api) {
    this.api = api;
    this.backends = new Map();
    this.models = new Map();
    this.active = null;
    this.host = new LocalAiHostProcess(api);
  }

  onLoad() {
    this.api.messages.handle('backend', () => this.start());
    this.api.messages.handle('restart', () => this.restart());
  }

  registerBackend(id, backend, priority = 0) {
    if (this.backends.has(id) || !backend || typeof backend.library !== 'string') {
      throw new Error(`Invalid or duplicate local AI backend: ${id}`);
    }
    const entry = { id, backend: { ...backend }, priority };
    this.backends.set(id, entry);
    return () => {
      if (this.active === entry) this.active = null;
      this.backends.delete(id);
    };
  }

  registerModel(model) {
    if (!model || typeof model.id !== 'string' || !model.id.startsWith('local/') || this.models.has(model.id)) {
      throw new Error('Invalid or duplicate local AI model package.');
    }
    this.models.set(model.id, { ...model });
    return () => this.models.delete(model.id);
  }

  async start() {
    if (!this.active) {
      this.active = [...this.backends.values()].sort((left, right) => right.priority - left.priority)[0] ?? null;
      if (!this.active) return { error: 'No local AI backend package is installed.' };
      this.host.configure(this.active.backend, [...this.models.values()]);
    }
    return this.host.start();
  }

  async restart() {
    return this.active ? this.host.restart() : this.start();
  }

  async onUnload() {
    await this.host.stop();
    this.active = null;
    this.backends.clear();
    this.models.clear();
  }
};
