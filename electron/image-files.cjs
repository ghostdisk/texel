const { mkdir, open, readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const MAX_FILE_BYTES = 0x7fffffff;
const FORMATS = {
  png: { label: 'PNG image', extension: 'png' },
  webp: { label: 'WebP image', extension: 'webp' },
  jpeg: { label: 'JPEG image', extension: 'jpg' },
};

function registerImageFiles({ app, ipcMain, dialog, documentFiles }, ownerOf) {
  let locations = null;
  let locationWrites = Promise.resolve();
  const locationsPath = () => path.join(app.getPath('userData'), 'export-locations.json');
  const ownerFor = (event) => {
    const owner = ownerOf(event);
    if (!owner) throw new Error('Invalid image export window.');
    return owner;
  };
  const definition = (format) => typeof format === 'string' && Object.hasOwn(FORMATS, format) ? FORMATS[format] : null;
  const safeName = (name, fallback) => {
    const cleaned = path.basename(name.slice(0, 4096)).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || fallback;
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? '_' + cleaned : cleaned;
  };

  async function loadLocations() {
    if (locations) return locations;
    try {
      const parsed = JSON.parse(await readFile(locationsPath(), 'utf8'));
      locations = new Map(Object.entries(parsed?.locations ?? {}).filter(([, value]) => value &&
        (value.kind === 'file' || value.kind === 'directory') && typeof value.path === 'string' && path.isAbsolute(value.path)));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Unable to read export locations:', error);
      locations = new Map();
    }
    return locations;
  }

  function persistLocations() {
    const file = locationsPath(), temporary = `${file}.${process.pid}.tmp`;
    locationWrites = locationWrites.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, locations: Object.fromEntries(locations) }, null, 2), 'utf8');
      await rename(temporary, file);
    });
    return locationWrites;
  }

  async function issue(kind, filePath, existingKey) {
    const values = await loadLocations();
    const key = typeof existingKey === 'string' && values.get(existingKey)?.kind === kind ? existingKey : randomUUID();
    values.set(key, { kind, path: filePath });
    await persistLocations();
    return { token: key, name: path.basename(filePath) };
  }

  async function resolve(key, kind) {
    const location = typeof key === 'string' ? (await loadLocations()).get(key) : null;
    if (!location || location.kind !== kind) throw new Error('Choose an export location first.');
    return location.path;
  }

  function validateBytes(format, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3 || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Invalid image export payload.');
    const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (format === 'png' ? !png : format === 'webp' ? !webp : format === 'jpeg' ? !jpeg : true) throw new Error('Encoded image does not match the selected format.');
  }

  async function atomicWrite(filePath, bytes) {
    const temporary = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp');
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, filePath);
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(() => {});
    }
  }

  ipcMain.handle('image:choose-export', async (event, format, suggestedName, existingKey, documentToken) => {
    const owner = ownerFor(event), formatDefinition = definition(format);
    if (!formatDefinition || typeof suggestedName !== 'string') throw new Error('Invalid image export request.');
    const existing = typeof existingKey === 'string' ? (await loadLocations()).get(existingKey) : null;
    const base = safeName(suggestedName, 'Untitled');
    const documentDirectory = documentFiles.directoryFor(event, documentToken);
    const result = await dialog.showSaveDialog(owner, {
      title: 'Export ' + formatDefinition.label, defaultPath: existing?.kind === 'file' ? existing.path :
        documentDirectory ? path.join(documentDirectory, base + '.' + formatDefinition.extension) : base + '.' + formatDefinition.extension,
      filters: [{ name: formatDefinition.label, extensions: [formatDefinition.extension] }], properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return null;
    const suffix = '.' + formatDefinition.extension;
    const filePath = result.filePath.toLowerCase().endsWith(suffix) ? result.filePath : result.filePath + suffix;
    return issue('file', filePath, existingKey);
  });

  ipcMain.handle('image:choose-export-directory', async (event, existingKey, documentToken) => {
    const owner = ownerFor(event);
    const existing = typeof existingKey === 'string' ? (await loadLocations()).get(existingKey) : null;
    const documentDirectory = documentFiles.directoryFor(event, documentToken);
    const result = await dialog.showOpenDialog(owner, {
      title: 'Choose export directory', defaultPath: existing?.kind === 'directory' ? existing.path : documentDirectory ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return issue('directory', result.filePaths[0], existingKey);
  });

  ipcMain.handle('image:write-export', async (event, key, bytes) => {
    ownerFor(event);
    const filePath = await resolve(key, 'file');
    const format = Object.entries(FORMATS).find(([, value]) => filePath.toLowerCase().endsWith('.' + value.extension))?.[0];
    validateBytes(format, bytes);
    await atomicWrite(filePath, bytes);
  });

  ipcMain.handle('image:write-export-directory', async (event, key, name, format, bytes) => {
    ownerFor(event);
    const formatDefinition = definition(format);
    if (!formatDefinition || typeof name !== 'string') throw new Error('Invalid layer export request.');
    validateBytes(format, bytes);
    const directory = await resolve(key, 'directory');
    const base = safeName(name, 'Layer');
    await atomicWrite(path.join(directory, base + '.' + formatDefinition.extension), bytes);
  });
}

module.exports = { registerImageFiles };
