module.exports = class LocalAiVulkanPackage {
  constructor(api) {
    this.api = api;
    this.unregister = null;
  }

  onLoad() {
    const base = this.api.packages.get('texel-editor/local-ai-base');
    if (!base) throw new Error('Local AI base package is unavailable.');
    const library = this.api.core.app.isPackaged ? this.api.files.resolve('runtime/texel-local-ai-vulkan.dll') :
      this.api.files.resolve('build/install/texel-local-ai-vulkan.dll');
    this.unregister = base.registerBackend('vulkan', { library }, 100);
  }

  onUnload() {
    this.unregister?.();
  }
};
