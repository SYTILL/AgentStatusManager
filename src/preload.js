const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  onSessions: (cb) => ipcRenderer.on('sessions', (_, d) => cb(d)),
  onSide: (cb) => ipcRenderer.on('side', (_, d) => cb(d)),
  onMenuClosed: (cb) => ipcRenderer.on('menu-closed', () => cb()),
  setIgnoreMouse: (v) => ipcRenderer.send('set-ignore', v),
  contentHeight: (h) => ipcRenderer.send('content-height', h),
  toggleNotify: (id) => ipcRenderer.send('toggle-notify', id),
  setPinned: (v) => ipcRenderer.send('set-pinned', v),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  rowMenu: (id) => ipcRenderer.send('row-menu', id),
  openInVSCode: (id) => ipcRenderer.send('open-vscode', id),
  refresh: () => ipcRenderer.invoke('refresh'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
