const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  onSessions: (cb) => ipcRenderer.on('sessions', (_, d) => cb(d)),
  onSettings: (cb) => ipcRenderer.on('settings', (_, d) => cb(d)),
  onMenuClosed: (cb) => ipcRenderer.on('menu-closed', () => cb()),
  setIgnoreMouse: (v) => ipcRenderer.send('set-ignore', v),
  contentSize: (size) => ipcRenderer.send('content-size', size),
  toggleNotify: (id) => ipcRenderer.send('toggle-notify', id),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  rowMenu: (id) => ipcRenderer.send('row-menu', id),
  settingsMenu: () => ipcRenderer.send('settings-menu'),
  openInVSCode: (id) => ipcRenderer.send('open-vscode', id),
  refresh: () => ipcRenderer.invoke('refresh'),
  onAlert: (cb) => ipcRenderer.on('alert', (_, a) => cb(a)),
  onPlaySound: (cb) => ipcRenderer.on('play-sound', (_, d) => cb(d)),
  openFromBubble: (id, cwd) => ipcRenderer.send('bubble-open', id, cwd),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
