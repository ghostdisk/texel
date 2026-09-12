const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function createWindow() {
  const window = new BrowserWindow({
    title: 'imged', width: 1440, height: 960, minWidth: 1000, minHeight: 680, backgroundColor: '#181a1f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.IMGED_DEV_URL) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(__dirname, '../dist/index.html'));
}

function ownerOf(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner && event.senderFrame === owner.webContents.mainFrame ? owner : null;
}

ipcMain.handle('image:open', async (event) => {
  const owner = ownerOf(event);
  if (!owner) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: 'Add image layer', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return { name: path.basename(filePaths[0]), bytes: new Uint8Array(await readFile(filePaths[0])) };
});

ipcMain.handle('actions:set-menus', (event, menus) => {
  const owner = ownerOf(event);
  if (!owner || !Array.isArray(menus)) return;
  const dispatch = (id) => { if (!owner.isDestroyed()) owner.webContents.send('action:execute', id); };
  const template = [];
  for (const group of menus) {
    if (!['File', 'Edit', 'Layer', 'Filter'].includes(group.label) || !Array.isArray(group.items)) continue;
    const submenu = [];
    for (const item of group.items) {
      if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') continue;
      const entry = {
        id: item.id,
        label: item.label,
        enabled: !!item.enabled,
        accelerator: typeof item.shortcut === 'string' && item.shortcut ? item.shortcut : undefined,
        // The renderer's action registry owns key handling, including text-field focus.
        registerAccelerator: false,
        click: () => dispatch(item.id),
      };
      if (typeof item.submenu === 'string' && item.submenu) {
        let nested = submenu.find((menu) => menu.submenu && menu.label === item.submenu);
        if (!nested) { nested = { label: item.submenu, submenu: [] }; submenu.push(nested); }
        nested.submenu.push(entry);
      } else submenu.push(entry);
    }
    if (group.label === 'File') submenu.push({ type: 'separator' }, { role: 'quit' });
    if (group.label === 'Edit') submenu.push({ type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    template.push({ label: group.label, submenu });
  }
  template.push({ label: 'View', submenu: [
    { label: 'Fit image', click: () => dispatch('view.fit') },
    { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Layer', submenu: [{ label: 'Starting editor…', enabled: false }] },
    { label: 'Filter', submenu: [{ label: 'Starting editor…', enabled: false }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
  ]));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
