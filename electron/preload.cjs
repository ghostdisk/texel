const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openImage: () => ipcRenderer.invoke('image:open'),
});
