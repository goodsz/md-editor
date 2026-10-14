const { contextBridge, ipcRenderer } = require('electron');

/**
 * 安全白名单桥：渲染层仅能通过 window.desktop 访问这些能力。
 * contextIsolation + sandbox 开启，渲染层无 Node 权限。
 */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  openFile: () => ipcRenderer.invoke('desktop:open'),
  saveFile: (payload) => ipcRenderer.invoke('desktop:save', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('desktop:saveAs', payload),
  getLaunchFile: () => ipcRenderer.invoke('desktop:get-launch-file'),
  onOpenFile: (cb) => {
    ipcRenderer.on('desktop:open-file', (_e, payload) => cb(payload));
  },
  pdfExportBegin: (payload) => ipcRenderer.invoke('desktop:export-pdf-begin', payload),
  pdfExportChunk: (id, chunk) => ipcRenderer.invoke('desktop:export-pdf-chunk', { id, chunk }),
  pdfExportEnd: (id) => ipcRenderer.invoke('desktop:export-pdf-end', { id }),
  pdfExportAbort: (id) => ipcRenderer.invoke('desktop:export-pdf-abort', { id }),
  setTheme: (theme) => ipcRenderer.invoke('desktop:setTheme', theme),
  setDirty: (dirty) => ipcRenderer.send('desktop:setDirty', dirty),
  onRequestSave: (cb) => {
    ipcRenderer.on('app:request-save', () => cb());
  },
  saveResult: (ok) => ipcRenderer.send('app:save-result', ok),
  onMenu: (cb) => {
    ipcRenderer.on('menu', (_e, action) => cb(action));
  },
});
