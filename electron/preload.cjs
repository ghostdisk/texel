const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openMenu: (label, x, y) => ipcRenderer.invoke('window:open-menu', label, x, y),
  openContextMenu: (items, x, y) => ipcRenderer.invoke('window:open-context-menu', items, x, y),
  openImage: () => ipcRenderer.invoke('image:open'),
  chooseImageExport: (format, name) => ipcRenderer.invoke('image:choose-export', format, name),
  writeImageExport: (token, bytes) => ipcRenderer.invoke('image:write-export', token, bytes),
  openDocument: () => ipcRenderer.invoke('document:open'),
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
  generationBackend: () => ipcRenderer.invoke('generation:backend'),
  restartGenerationBackend: () => ipcRenderer.invoke('generation:restart'),
  setMenus: (menus) => ipcRenderer.invoke('actions:set-menus', menus),
  onAction: (callback) => {
    const listener = (_event, id) => { if (typeof id === 'string') callback(id); };
    ipcRenderer.on('action:execute', listener);
    return () => ipcRenderer.removeListener('action:execute', listener);
  },
});
