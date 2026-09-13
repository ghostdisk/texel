const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const FIELD_KEY = /^[a-z][a-z0-9._-]{0,79}$/;

class PackageSettings {
  constructor(app, safeStorage) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.schemas = new Map();
    this.cache = new Map();
    this.writes = new Map();
  }

  directory(packageName) { return path.join(this.app.getPath('userData'), 'package-settings', encodeURIComponent(packageName)); }
  valuesPath(packageName) { return path.join(this.directory(packageName), 'settings.json'); }
  secretPath(packageName, key) { return path.join(this.directory(packageName), `${key}.bin`); }

  register(packageName, packageLabel, fields) {
    if (this.schemas.has(packageName)) throw new Error(`Package settings already registered: ${packageName}`);
    if (!Array.isArray(fields)) throw new Error(`Invalid settings schema for ${packageName}.`);
    const keys = new Set();
    const normalized = fields.map((field) => {
      if (!field || !FIELD_KEY.test(field.key) || keys.has(field.key) || !['secret', 'string', 'boolean', 'number'].includes(field.type)) {
        throw new Error(`Invalid settings field in ${packageName}.`);
      }
      keys.add(field.key);
      return {
        key: field.key,
        type: field.type,
        label: typeof field.label === 'string' && field.label ? field.label : field.key,
        description: typeof field.description === 'string' ? field.description : '',
        placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
        default: field.default,
        validate: typeof field.validate === 'function' ? field.validate : null,
      };
    });
    this.schemas.set(packageName, { packageName, packageLabel, fields: normalized });
  }

  unregister(packageName) { this.schemas.delete(packageName); }

  field(packageName, key) {
    const field = this.schemas.get(packageName)?.fields.find((candidate) => candidate.key === key);
    if (!field) throw new Error(`Unknown setting ${packageName}/${key}.`);
    return field;
  }

  async values(packageName) {
    if (this.cache.has(packageName)) return this.cache.get(packageName);
    let value = {};
    try {
      const parsed = JSON.parse(await readFile(this.valuesPath(packageName), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`Unable to read settings for ${packageName}:`, error);
    }
    this.cache.set(packageName, value);
    return value;
  }

  async get(packageName, key) {
    const field = this.field(packageName, key);
    if (field.type !== 'secret') {
      const values = await this.values(packageName);
      return values[key] ?? field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
    }
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return '';
      return this.safeStorage.decryptString(await readFile(this.secretPath(packageName, key)));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`Unable to read secret ${packageName}/${key}:`, error);
      return '';
    }
  }

  normalize(field, value) {
    let normalized;
    if (field.type === 'boolean') normalized = value === true;
    else if (field.type === 'number') {
      normalized = Number(value);
      if (!Number.isFinite(normalized)) throw new Error(`${field.label} must be a number.`);
    } else {
      if (typeof value !== 'string' || value.length > 4096) throw new Error(`Invalid value for ${field.label}.`);
      normalized = value.trim();
    }
    const result = field.validate?.(normalized);
    if (typeof result === 'string' && result) throw new Error(result);
    if (result === false) throw new Error(`Invalid value for ${field.label}.`);
    return normalized;
  }

  async set(packageName, key, value) {
    const field = this.field(packageName, key);
    const normalized = this.normalize(field, value);
    await mkdir(this.directory(packageName), { recursive: true });
    if (field.type === 'secret') {
      const file = this.secretPath(packageName, key);
      if (!normalized) await rm(file, { force: true });
      else {
        if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
        await writeFile(file, this.safeStorage.encryptString(normalized));
      }
      return { configured: !!normalized };
    }
    const values = { ...await this.values(packageName), [key]: normalized };
    this.cache.set(packageName, values);
    const file = this.valuesPath(packageName);
    const temporary = `${file}.${process.pid}.tmp`;
    const previous = this.writes.get(packageName) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await writeFile(temporary, JSON.stringify(values, null, 2), 'utf8');
      await rename(temporary, file);
    });
    this.writes.set(packageName, write);
    await write;
    return { value: normalized };
  }

  async describe() {
    const groups = [];
    for (const schema of this.schemas.values()) {
      const fields = [];
      for (const field of schema.fields) {
        const value = await this.get(schema.packageName, field.key);
        fields.push({
          key: field.key,
          type: field.type,
          label: field.label,
          description: field.description,
          placeholder: field.placeholder,
          configured: field.type === 'secret' ? !!value : undefined,
          value: field.type === 'secret' ? undefined : value,
        });
      }
      groups.push({ packageName: schema.packageName, label: schema.packageLabel, fields });
    }
    return groups;
  }
}

module.exports = { PackageSettings };
