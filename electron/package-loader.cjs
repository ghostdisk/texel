const { readFile, readdir } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PackageSettings } = require('./package-settings.cjs');

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const MESSAGE_NAME = /^[a-z][a-z0-9._-]{0,79}$/;

class PackageLoader {
  constructor({ app, BrowserWindow, ipcMain, safeStorage, root, ownerOf }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.ownerOf = ownerOf;
    this.root = root;
    this.packagesRoot = app.isPackaged ? path.join(process.resourcesPath, 'packages') : path.join(root, 'packages');
    this.settings = new PackageSettings(app, safeStorage);
    this.records = new Map();
    this.handlers = new Map();
    this.loadOrder = [];
    this.texel = { core: this.createCore(), packages: Object.create(null) };
    globalThis.texel = this.texel;
    ipcMain.handle('packages:list', (event) => ownerOf(event) ? this.publicPackages() : []);
    ipcMain.handle('packages:invoke', (event, packageName, message, args) => this.invoke(event, packageName, message, args));
    ipcMain.handle('packages:settings', (event) => ownerOf(event) ? this.settings.describe() : []);
    ipcMain.handle('packages:set-setting', (event, packageName, key, value) => {
      if (!ownerOf(event)) return null;
      return this.settings.set(packageName, key, value);
    });
  }

  createCore() {
    return Object.freeze({
      version: 1,
      app: this.app,
      root: this.root,
      ownerOf: this.ownerOf,
      packages: Object.freeze({ get: (name) => this.texel.packages[name] }),
    });
  }

  async findManifests(directory = this.packagesRoot) {
    if (!existsSync(directory)) return [];
    const results = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      const manifest = path.join(child, 'texel-package.json');
      if (existsSync(manifest)) results.push(manifest);
      else results.push(...await this.findManifests(child));
    }
    return results;
  }

  validateManifest(manifest, manifestPath) {
    if (!manifest || manifest.schemaVersion !== 1 || !PACKAGE_NAME.test(manifest.name) ||
        typeof manifest.displayName !== 'string' || !manifest.displayName || typeof manifest.version !== 'string') {
      throw new Error(`Invalid Texel package manifest: ${manifestPath}`);
    }
    const dependencies = manifest.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((name) => !PACKAGE_NAME.test(name))) {
      throw new Error(`Invalid dependencies in package ${manifest.name}.`);
    }
    for (const entry of [manifest.node, manifest.renderer]) {
      if (entry !== undefined && (typeof entry !== 'string' || !entry || path.isAbsolute(entry))) {
        throw new Error(`Invalid entry point in package ${manifest.name}.`);
      }
    }
    return { manifest: { ...manifest, dependencies }, directory: path.dirname(manifestPath), instance: null, loaded: false };
  }

  sort(records) {
    const result = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (record) => {
      if (visited.has(record.manifest.name)) return;
      if (visiting.has(record.manifest.name)) throw new Error(`Package dependency cycle at ${record.manifest.name}.`);
      visiting.add(record.manifest.name);
      for (const dependency of record.manifest.dependencies) {
        const target = records.get(dependency);
        if (!target) throw new Error(`${record.manifest.name} requires missing package ${dependency}.`);
        visit(target);
      }
      visiting.delete(record.manifest.name);
      visited.add(record.manifest.name);
      result.push(record);
    };
    for (const record of records.values()) visit(record);
    return result;
  }

  packageFile(record, relativePath) {
    const root = record.directory;
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Invalid package path in ${record.manifest.name}.`);
    return resolved;
  }

  packageApi(record) {
    const packageName = record.manifest.name;
    return Object.freeze({
      name: packageName,
      manifest: Object.freeze({ ...record.manifest }),
      core: this.texel.core,
      packages: Object.freeze({ get: (name) => this.texel.packages[name] }),
      files: Object.freeze({ resolve: (file) => this.packageFile(record, file), root: record.directory }),
      messages: Object.freeze({
        handle: (name, handler) => this.handle(packageName, name, handler),
        emit: (name, value, target) => this.emit(packageName, name, value, target),
      }),
      settings: Object.freeze({
        register: (fields) => this.settings.register(packageName, record.manifest.displayName, fields),
        get: (key) => this.settings.get(packageName, key),
        set: (key, value) => this.settings.set(packageName, key, value),
      }),
    });
  }

  async load() {
    const records = new Map();
    for (const manifestPath of await this.findManifests()) {
      const record = this.validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath);
      if (records.has(record.manifest.name)) throw new Error(`Duplicate Texel package: ${record.manifest.name}`);
      records.set(record.manifest.name, record);
    }
    this.records = records;
    this.loadOrder = this.sort(records);
    for (const record of this.loadOrder) {
      const api = this.packageApi(record);
      let instance = {};
      if (record.manifest.node) {
        const exported = require(this.packageFile(record, record.manifest.node));
        const Package = exported.default ?? exported.Package ?? exported;
        instance = typeof Package === 'function' ? new Package(api) : Package;
        if (!instance || typeof instance !== 'object') throw new Error(`${record.manifest.name} did not export a package class.`);
      }
      record.instance = instance;
      this.texel.packages[record.manifest.name] = instance;
      await instance.onLoad?.();
      record.loaded = true;
    }
  }

  async unload() {
    for (const record of [...this.loadOrder].reverse()) {
      if (!record.loaded) continue;
      try { await record.instance.onUnload?.(); }
      catch (error) { console.error(`Unable to unload ${record.manifest.name}:`, error); }
      this.handlers.delete(record.manifest.name);
      this.settings.unregister(record.manifest.name);
      delete this.texel.packages[record.manifest.name];
      record.loaded = false;
    }
  }

  handle(packageName, name, handler) {
    if (!MESSAGE_NAME.test(name) || typeof handler !== 'function') throw new Error(`Invalid message handler in ${packageName}.`);
    let handlers = this.handlers.get(packageName);
    if (!handlers) { handlers = new Map(); this.handlers.set(packageName, handlers); }
    if (handlers.has(name)) throw new Error(`Duplicate package message handler: ${packageName}/${name}`);
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }

  async invoke(event, packageName, name, args) {
    const owner = this.ownerOf(event);
    if (!owner || !PACKAGE_NAME.test(packageName) || !MESSAGE_NAME.test(name) || !Array.isArray(args) || args.length > 8) {
      throw new Error('Invalid package message.');
    }
    const handler = this.handlers.get(packageName)?.get(name);
    if (!handler) throw new Error(`Package message is unavailable: ${packageName}/${name}`);
    return handler(event, ...args);
  }

  emit(packageName, name, value, target) {
    if (!MESSAGE_NAME.test(name)) throw new Error(`Invalid package message in ${packageName}.`);
    const send = (webContents) => {
      if (webContents && !webContents.isDestroyed()) webContents.send('packages:message', { packageName, name, value });
    };
    if (target) send(target.webContents ?? target);
    else for (const window of this.BrowserWindow.getAllWindows()) send(window.webContents);
  }

  publicPackages() {
    return this.loadOrder.filter((record) => record.loaded).map((record) => ({
      name: record.manifest.name,
      displayName: record.manifest.displayName,
      version: record.manifest.version,
      description: typeof record.manifest.description === 'string' ? record.manifest.description : '',
      dependencies: [...record.manifest.dependencies],
      rendererUrl: record.manifest.renderer ?
        `texel-package://package/${record.manifest.name}/${record.manifest.renderer}` : null,
    }));
  }

  resolveRequest(requestUrl) {
    const url = new URL(requestUrl);
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const packageName = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : '';
    const record = this.records.get(packageName);
    if (!record?.loaded || url.host !== 'package') return null;
    const relative = parts.slice(2).join('/');
    return this.packageFile(record, relative);
  }
}

module.exports = { PackageLoader };
