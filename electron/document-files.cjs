const { open, rename, unlink, stat } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const MAX_FILE_BYTES = 0x7fffffff;

function registerDocumentFiles({ ipcMain, dialog }, ownerOf) {
  const windows = new WeakMap();
  const pendingPaths = [];
  let currentWindow = null;
  const stateFor = (event) => {
    const owner = ownerOf(event);
    const state = owner && windows.get(owner);
    if (!owner || !state) throw new Error('Invalid document window.');
    return { owner, state };
  };
  const issue = (state, filePath) => {
    const token = randomUUID();
    state.handles.set(token, filePath);
    return { token, name: path.basename(filePath) };
  };

  const deliverPending = () => {
    const owner = currentWindow;
    const state = owner && windows.get(owner);
    if (!owner || owner.isDestroyed() || !state?.openReady || !pendingPaths.length) return;
    const files = pendingPaths.splice(0).map((filePath) => issue(state, filePath));
    owner.webContents.send('document:open-request', files);
  };

  ipcMain.handle('document:ready', (event) => {
    const { state } = stateFor(event);
    state.openReady = true;
    deliverPending();
  });

  ipcMain.handle('document:open', async (event) => {
    const { owner, state } = stateFor(event);
    const result = await dialog.showOpenDialog(owner, {
      title: 'Open Texel document', properties: ['openFile'], filters: [{ name: 'Texel documents', extensions: ['txl'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return issue(state, result.filePaths[0]);
  });

  ipcMain.handle('document:read', async (event, token) => {
    const { state } = stateFor(event);
    const filePath = state.handles.get(token);
    if (!filePath) throw new Error('Choose a document before reading it.');
    const file = await open(filePath, 'r');
    let bytes;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 28 || info.size > MAX_FILE_BYTES) throw new Error('Invalid document size. Texel currently supports files smaller than 2 GiB.');
      bytes = await file.readFile();
      if (bytes.length > MAX_FILE_BYTES) throw new Error('Document exceeds the 2 GiB size limit.');
    } finally { await file.close(); }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });

  ipcMain.handle('document:choose-save', async (event, token, saveAs) => {
    const { owner, state } = stateFor(event);
    const existing = token === null ? null : state.handles.get(token);
    if (token !== null && !existing) throw new Error('Unknown document file handle.');
    if (existing && !saveAs) return { token, name: path.basename(existing) };
    const result = await dialog.showSaveDialog(owner, {
      title: 'Save Texel document', defaultPath: existing || 'Untitled.txl',
      filters: [{ name: 'Texel documents', extensions: ['txl'] }], properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return null;
    const filePath = result.filePath.toLowerCase().endsWith('.txl') ? result.filePath : result.filePath + '.txl';
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
    return issue(state, filePath);
  });

  ipcMain.handle('document:write', async (event, token, bytes) => {
    const { state } = stateFor(event);
    const filePath = state.handles.get(token);
    if (!filePath) throw new Error('Choose a save location before writing the document.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 28 || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Invalid document payload.');
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(0, true) !== 0x004c5854 || header.getUint32(4, true) !== 1 || header.getUint32(8, true) !== bytes.byteLength) throw new Error('Invalid TXL file header.');
    const temporary = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp');
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = null;
      // Same-directory rename replaces the previous file only after the new file is complete.
      await rename(temporary, filePath);
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(() => {});
    }
  });

  ipcMain.handle('document:confirm-save', async (event, name) => {
    const { owner } = stateFor(event);
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question', title: 'Texel', message: 'Save changes to ' + String(name).slice(0, 4096) + '?',
      buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    });
    return ['save', 'discard', 'cancel'][response] ?? 'cancel';
  });

  ipcMain.handle('document:state', (event, value) => {
    const { owner, state } = stateFor(event);
    if (!value || typeof value.name !== 'string' || typeof value.dirty !== 'boolean') throw new Error('Invalid document state.');
    state.ready = true;
    owner.setTitle(value.name.slice(0, 4096) + (value.dirty ? ' *' : '') + ' — Texel');
    owner.setDocumentEdited(value.dirty);
  });

  ipcMain.handle('document:close', (event) => {
    const { owner, state } = stateFor(event);
    state.allowClose = true;
    owner.close();
  });

  return {
    queueOpen(filePaths) {
      for (const filePath of filePaths) {
        if (typeof filePath === 'string' && path.isAbsolute(filePath) && path.extname(filePath).toLowerCase() === '.txl') pendingPaths.push(filePath);
      }
      deliverPending();
    },
    attachWindow(owner) {
      const state = { handles: new Map(), ready: false, openReady: false, allowClose: false };
      windows.set(owner, state);
      currentWindow = owner;
      owner.on('close', (event) => {
        if (!state.ready || state.allowClose) return;
        event.preventDefault();
        owner.webContents.send('document:close-request');
      });
      owner.on('closed', () => { if (currentWindow === owner) currentWindow = null; });
      owner.webContents.on('did-start-loading', () => { state.openReady = false; });
      owner.webContents.on('render-process-gone', () => { state.ready = false; state.openReady = false; });
    },
  };
}

module.exports = { registerDocumentFiles };