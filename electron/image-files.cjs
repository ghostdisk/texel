const { open, rename, stat, unlink } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const MAX_FILE_BYTES = 0x7fffffff;
const FORMATS = {
  png: { label: 'PNG image', extension: 'png' },
  webp: { label: 'WebP image', extension: 'webp' },
};

function registerImageFiles({ ipcMain, dialog }, ownerOf) {
  const windows = new WeakMap();
  const stateFor = (event) => {
    const owner = ownerOf(event);
    if (!owner) throw new Error('Invalid image export window.');
    let state = windows.get(owner);
    if (!state) { state = new Map(); windows.set(owner, state); }
    return { owner, state };
  };

  ipcMain.handle('image:choose-export', async (event, format, suggestedName) => {
    const { owner, state } = stateFor(event);
    const definition = typeof format === 'string' && Object.hasOwn(FORMATS, format) ? FORMATS[format] : null;
    if (!definition || typeof suggestedName !== 'string') throw new Error('Invalid image export request.');
    const base = path.basename(suggestedName.slice(0, 4096)).replace(/[. ]+$/, '') || 'Untitled';
    const result = await dialog.showSaveDialog(owner, {
      title: 'Export ' + definition.label, defaultPath: base + '.' + definition.extension,
      filters: [{ name: definition.label, extensions: [definition.extension] }], properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return null;
    const suffix = '.' + definition.extension;
    const filePath = result.filePath.toLowerCase().endsWith(suffix) ? result.filePath : result.filePath + suffix;
    if (filePath !== result.filePath) {
      const exists = await stat(filePath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) {
        const { response } = await dialog.showMessageBox(owner, {
          type: 'question', buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
          message: 'Replace ' + path.basename(filePath) + '?', detail: 'A file with this name already exists.',
        });
        if (response !== 0) return null;
      }
    }
    const token = randomUUID();
    state.set(token, { filePath, format });
    return { token, name: path.basename(filePath) };
  });

  ipcMain.handle('image:write-export', async (event, token, bytes) => {
    const { state } = stateFor(event);
    const destination = state.get(token);
    if (!destination) throw new Error('Choose an image export location before writing.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12 || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Invalid image export payload.');
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    const webp = String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
    if (destination.format === 'png' ? !png : !webp) throw new Error('Encoded image does not match the selected format.');
    const temporary = path.join(path.dirname(destination.filePath), '.' + path.basename(destination.filePath) + '.' + randomUUID() + '.tmp');
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, destination.filePath);
      state.delete(token);
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(() => {});
    }
  });
}

module.exports = { registerImageFiles };
