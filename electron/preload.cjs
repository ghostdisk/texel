const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openMenu: (label, x, y) => ipcRenderer.invoke('window:open-menu', label, x, y),
  openContextMenu: (items, x, y) => ipcRenderer.invoke('window:open-context-menu', items, x, y),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openRepository: () => ipcRenderer.invoke('app:open-repository'),
  onWindowMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => callback(maximized === true);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
  openImage: () => ipcRenderer.invoke('image:open'),
  writeClipboard: (value) => ipcRenderer.invoke('clipboard:write', value),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  chooseImageExport: (format, name) => ipcRenderer.invoke('image:choose-export', format, name),
  writeImageExport: (token, bytes) => ipcRenderer.invoke('image:write-export', token, bytes),
  openDocument: () => ipcRenderer.invoke('document:open'),
  recentDocuments: () => ipcRenderer.invoke('document:recent'),
  rememberDocument: (token) => ipcRenderer.invoke('document:remember', token),
  forgetDocument: (token) => ipcRenderer.invoke('document:forget', token),
  documentReady: () => ipcRenderer.invoke('document:ready'),
  onOpenRequest: (callback) => {
    const listener = (_event, files) => { if (Array.isArray(files)) callback(files); };
    ipcRenderer.on('document:open-request', listener);
    return () => ipcRenderer.removeListener('document:open-request', listener);
  },
  readDocument: (token) => ipcRenderer.invoke('document:read', token),
  chooseDocumentSave: (token, saveAs) => ipcRenderer.invoke('document:choose-save', token, saveAs),
  writeDocument: (token, bytes) => ipcRenderer.invoke('document:write', token, bytes),
  confirmDocumentSave: (name) => ipcRenderer.invoke('document:confirm-save', name),
  setDocumentState: (state) => ipcRenderer.invoke('document:state', state),
  closeDocumentWindow: () => ipcRenderer.invoke('document:close'),
  onCloseRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('document:close-request', listener);
    return () => ipcRenderer.removeListener('document:close-request', listener);
  },
  listPackages: () => ipcRenderer.invoke('packages:list'),
  invokePackage: (packageName, message, ...args) => ipcRenderer.invoke('packages:invoke', packageName, message, args),
  packageSettings: () => ipcRenderer.invoke('packages:settings'),
  setPackageSetting: (packageName, key, value) => ipcRenderer.invoke('packages:set-setting', packageName, key, value),
  onPackageMessage: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('packages:message', listener);
    return () => ipcRenderer.removeListener('packages:message', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  setWindowTheme: (theme) => ipcRenderer.invoke('window:set-theme', theme),
  setMenus: (menus) => ipcRenderer.invoke('actions:set-menus', menus),
  onAction: (callback) => {
    const listener = (_event, id) => { if (typeof id === 'string') callback(id); };
    ipcRenderer.on('action:execute', listener);
    return () => ipcRenderer.removeListener('action:execute', listener);
  },
});
