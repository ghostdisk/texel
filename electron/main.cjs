const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function createWindow() {
  const window = new BrowserWindow({
    title: 'imged',
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#181a1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.IMGED_DEV_URL) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(__dirname, '../dist/index.html'));
}

ipcMain.handle('image:open', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || event.senderFrame !== owner.webContents.mainFrame) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: 'Add image layer',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return { name: path.basename(filePaths[0]), bytes: new Uint8Array(await readFile(filePaths[0])) };
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
  ]));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
