const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openImage: () => ipcRenderer.invoke('image:open'),
  setMenus: (menus) => ipcRenderer.invoke('actions:set-menus', menus),
  onAction: (callback) => {
    const listener = (_event, id) => { if (typeof id === 'string') callback(id); };
    ipcRenderer.on('action:execute', listener);
    return () => ipcRenderer.removeListener('action:execute', listener);
  },
});
