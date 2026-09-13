const { registerFal } = require('./service.cjs');

module.exports = class FalPackage {
  constructor(api) {
    this.api = api;
    this.service = null;
  }

  onLoad() {
    this.api.settings.register([{
      key: 'api-key',
      type: 'secret',
      label: 'API key',
      placeholder: 'key ID:key secret',
      description: 'Used for Fal.ai model discovery and generation.',
      validate: (value) => typeof value === 'string' && value.length <= 1024,
    }]);
    const prefix = 'fal:';
    const ipcMain = {
      handle: (channel, handler) => {
        if (!channel.startsWith(prefix)) throw new Error(`Invalid Fal.ai message: ${channel}`);
        this.api.messages.handle(channel.slice(prefix.length), handler);
      },
    };
    this.service = registerFal({
      app: this.api.core.app,
      ipcMain,
      keyStore: this.api.settings,
      emit: (target, name, value) => this.api.messages.emit(name, value, target),
    }, this.api.core.ownerOf);
  }

  onUnload() { this.service?.stop(); }
};
