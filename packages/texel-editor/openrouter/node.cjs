const { registerOpenRouter } = require('./service.cjs');

module.exports = class OpenRouterPackage {
  constructor(api) {
    this.api = api;
    this.service = null;
  }

  onLoad() {
    this.api.settings.register([{
      key: 'api-key',
      type: 'secret',
      label: 'API key',
      placeholder: 'sk-or-…',
      description: 'Used for image generation and future OpenRouter services.',
      validate: (value) => !value || value.length <= 512 && value.startsWith('sk-or-') || 'Enter a valid OpenRouter API key.',
    }]);
    const prefix = 'openrouter:';
    const ipcMain = {
      handle: (channel, handler) => {
        if (!channel.startsWith(prefix)) throw new Error(`Invalid OpenRouter message: ${channel}`);
        this.api.messages.handle(channel.slice(prefix.length), handler);
      },
    };
    this.service = registerOpenRouter({
      app: this.api.core.app,
      ipcMain,
      keyStore: this.api.settings,
      emit: (target, name, value) => this.api.messages.emit(name, value, target),
    }, this.api.core.ownerOf);
  }

  onUnload() { this.service?.stop(); }
};
