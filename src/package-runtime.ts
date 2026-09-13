import { generationModelRegistry } from './generation/provider';
import type { GenerationProvider } from './generation/provider';
import { rgbaToPng } from './generation/image-codec';

export interface PackageManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  dependencies: string[];
  rendererUrl: string | null;
}

export interface PackageSettingField {
  key: string;
  type: 'secret' | 'string' | 'boolean' | 'number';
  label: string;
  description: string;
  placeholder: string;
  configured?: boolean;
  value?: string | number | boolean;
}

export interface PackageSettingGroup {
  packageName: string;
  label: string;
  fields: PackageSettingField[];
}

export interface PackageMessage {
  packageName: string;
  name: string;
  value: unknown;
}

export interface RendererPackageApi {
  name: string;
  manifest: Readonly<PackageManifest>;
  core: TexelRendererCore;
  packages: {
    get(name: string): object | undefined;
  };
  files: {
    url(path: string): string;
  };
  messages: {
    invoke<T>(name: string, ...args: unknown[]): Promise<T>;
    on(name: string, listener: (value: any) => void): () => void;
  };
  settings: {
    set(key: string, value: unknown): Promise<unknown>;
  };
}

export interface TexelRendererCore {
  version: number;
  models: {
    registerProvider(provider: GenerationProvider): void;
    registerModel(model: import('./generation/provider').GenerationModel): void;
  };
  images: {
    rgbaToPng: typeof rgbaToPng;
  };
  settings: {
    packages(): Promise<PackageSettingGroup[]>;
    set(packageName: string, key: string, value: unknown): Promise<unknown>;
  };
}

export interface TexelRendererGlobal {
  core: TexelRendererCore;
  packages: Record<string, object>;
}

interface RendererPackage {
  onLoad?(): void | Promise<void>;
  onUnload?(): void | Promise<void>;
}

interface RendererPackageConstructor {
  new(api: RendererPackageApi): RendererPackage;
}

export class RendererPackageLoader {
  private readonly listeners = new Map<string, Set<(value: any) => void>>();
  private readonly loaded: { manifest: PackageManifest; instance: RendererPackage }[] = [];
  readonly texel: TexelRendererGlobal;

  constructor(private readonly report: (error: unknown) => void) {
    const core: TexelRendererCore = Object.freeze({
      version: 1,
      models: Object.freeze({
        registerProvider: (provider: GenerationProvider) => generationModelRegistry.register(provider, this.loadingPackage),
        registerModel: (model: import('./generation/provider').GenerationModel) => generationModelRegistry.registerModel(model, this.loadingPackage),
      }),
      images: Object.freeze({ rgbaToPng }),
      settings: Object.freeze({
        packages: () => window.desktop.packageSettings(),
        set: (packageName: string, key: string, value: unknown) => window.desktop.setPackageSetting(packageName, key, value),
      }),
    });
    this.texel = { core, packages: Object.create(null) };
    window.texel = this.texel;
    window.desktop.onPackageMessage((message) => {
      if (!message || typeof message.packageName !== 'string' || typeof message.name !== 'string') return;
      for (const listener of this.listeners.get(`${message.packageName}:${message.name}`) ?? []) listener(message.value);
    });
  }

  private loadingPackage = '';

  private api(manifest: PackageManifest): RendererPackageApi {
    const packageName = manifest.name;
    return Object.freeze({
      name: packageName,
      manifest: Object.freeze({ ...manifest }),
      core: this.texel.core,
      packages: Object.freeze({ get: (name: string) => this.texel.packages[name] }),
      files: Object.freeze({
        url: (file: string) => `texel-package://package/${packageName}/${file.split('/').map(encodeURIComponent).join('/')}`,
      }),
      messages: Object.freeze({
        invoke: <T>(name: string, ...args: unknown[]) => window.desktop.invokePackage(packageName, name, ...args) as Promise<T>,
        on: (name: string, listener: (value: any) => void) => this.listen(packageName, name, listener),
      }),
      settings: Object.freeze({ set: (key: string, value: unknown) => window.desktop.setPackageSetting(packageName, key, value) }),
    });
  }

  private listen(packageName: string, name: string, listener: (value: any) => void): () => void {
    const key = `${packageName}:${name}`;
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.listeners.delete(key);
    };
  }

  async load(): Promise<void> {
    const manifests = await window.desktop.listPackages();
    for (const manifest of manifests) {
      let instance: RendererPackage = {};
      this.loadingPackage = manifest.name;
      try {
        const unavailable = manifest.dependencies.find((name) => !this.texel.packages[name]);
        if (unavailable) throw new Error(`Dependency ${unavailable} did not initialize.`);
        if (manifest.rendererUrl) {
          const module = await import(/* @vite-ignore */ manifest.rendererUrl) as { default?: RendererPackageConstructor; Package?: RendererPackageConstructor };
          const Package = module.default ?? module.Package;
          if (typeof Package !== 'function') throw new Error(`${manifest.name} did not export a renderer package class.`);
          instance = new Package(this.api(manifest));
        }
        this.texel.packages[manifest.name] = instance;
        await instance.onLoad?.();
        this.loaded.push({ manifest, instance });
      } catch (error) {
        generationModelRegistry.unregisterOwner(manifest.name);
        delete this.texel.packages[manifest.name];
        this.report(new Error(`Unable to load ${manifest.displayName}: ${error instanceof Error ? error.message : String(error)}`));
      } finally { this.loadingPackage = ''; }
    }
  }

  async unload(): Promise<void> {
    for (const { manifest, instance } of [...this.loaded].reverse()) {
      try { await instance.onUnload?.(); }
      catch (error) { this.report(error); }
      generationModelRegistry.unregisterOwner(manifest.name);
      delete this.texel.packages[manifest.name];
    }
    this.loaded.length = 0;
    this.listeners.clear();
  }
}
