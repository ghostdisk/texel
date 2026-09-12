const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { NativeBackend } = require('./native-backend.cjs');
const { registerDocumentFiles } = require('./document-files.cjs');
app.setName('Texel');

if (!app.requestSingleInstanceLock()) app.quit();
else startApplication();

function startApplication() {
  const documentFiles = registerDocumentFiles({ ipcMain, dialog }, ownerOf);
  let backend;
  let quitting = false;
  let editorWindow = null;

  function openArguments(argv, workingDirectory) {
    return argv.slice(1)
      .filter((argument) => typeof argument === 'string' && !argument.startsWith('-') && path.extname(argument).toLowerCase() === '.txl')
      .map((argument) => path.resolve(workingDirectory, argument));
  }

  documentFiles.queueOpen(openArguments(process.argv, process.cwd()));
  app.on('second-instance', (_event, argv, workingDirectory) => {
    documentFiles.queueOpen(openArguments(argv, workingDirectory));
    if (editorWindow && !editorWindow.isDestroyed()) {
      if (editorWindow.isMinimized()) editorWindow.restore();
      editorWindow.show();
      editorWindow.focus();
    }
  });
  app.on('open-file', (event, filePath) => { event.preventDefault(); documentFiles.queueOpen([filePath]); });

  async function createWindow() {
    const window = new BrowserWindow({
      title: 'Texel', width: 1440, height: 960, minWidth: 1000, minHeight: 680, backgroundColor: '#181a1f',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    editorWindow = window;
    window.on('closed', () => { if (editorWindow === window) editorWindow = null; });
    documentFiles.attachWindow(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    if (!app.isPackaged && process.env.IMGED_DEV_URL) await window.loadURL('http://127.0.0.1:5173');
    else await window.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  function ownerOf(event) {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return owner && event.senderFrame === owner.webContents.mainFrame ? owner : null;
  }

  ipcMain.handle('generation:backend', (event) => ownerOf(event) && backend ? backend.start() : { error: 'Invalid window.' });
  ipcMain.handle('generation:restart', (event) => ownerOf(event) && backend ? backend.restart() : { error: 'Invalid window.' });

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
      if (!['File', 'Edit', 'Select', 'Layer', 'Filter', 'Tools', 'View'].includes(group.label) || !Array.isArray(group.items)) continue;
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
      if (group.label === 'Edit') submenu.push({ type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' });
      if (group.label === 'View') submenu.push(
        { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      );
      template.push({ label: group.label, submenu });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('app.texel.editor');
    backend = new NativeBackend(path.join(__dirname, '..'), {
      packaged: app.isPackaged, resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'), executableDirectory: path.dirname(app.getPath('exe')),
    });
    void backend.start();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
      { label: 'Select', submenu: [{ label: 'Starting editor…', enabled: false }] },
      { label: 'Layer', submenu: [{ label: 'Starting editor…', enabled: false }] },
      { label: 'Filter', submenu: [{ label: 'Starting editor…', enabled: false }] },
      { label: 'Tools', submenu: [{ label: 'Starting editor…', enabled: false }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    ]));
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

  app.on('will-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (backend?.stop() ?? Promise.resolve()).finally(() => app.quit());
  });
}
