// Electron main process: window, tray, alerts (speech bubbles + sound)
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Store } = require('./store');
const { startServer } = require('./server');
const hooksCfg = require('./hooks-config');
const { focusVSCodeWindow, listVSCodeTitles, titleParts } = require('./focus-window');

const PORT = Number(process.env.AGENT_STATUS_PORT) || 7777;
// The window size never changes with expand/collapse or bubbles (resizing a transparent window flickers on Windows):
//   width  = expanded dock (OPEN) + room for the alert bubbles on the screen-center side
//   height = from the widget's top down to the bottom of the screen
// Everything except the dock and the bubbles is transparent and click-through.
const OPEN = 421;
const BUBBLE_AREA = 270;
const WIN_W = OPEN + BUBBLE_AREA;

// Let the renderer play alert sounds without a user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Use the same data folder in dev and exe (otherwise productName would change it)
app.setPath('userData', path.join(app.getPath('appData'), 'agent-status-manager'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId(app.isPackaged ? 'com.agentstatus.manager' : process.execPath);

let win, tray, store, settings;
let contentH = 60;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const SOUND_DEFAULTS = { enabled: true, volume: 0.6, readyFile: null, attentionFile: null };
const DEFAULTS = { side: 'right', y: null, pinned: false, theme: 'light' };
function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { s = { ...DEFAULTS }; }
  s.sound = { ...SOUND_DEFAULTS, ...(s.sound || {}) };
  return s;
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

// ---------- window layout ----------
function workArea() {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  return (b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay()).workArea;
}

function layout() {
  if (!win || win.isDestroyed() || dragTimer) return;
  const wa = workArea();
  const w = WIN_W;
  const dockH = Math.max(24, Math.min(contentH, wa.height));
  let y = settings.y == null ? wa.y + Math.round(wa.height * 0.25) : settings.y;
  y = Math.max(wa.y, Math.min(wa.y + wa.height - dockH, y));
  const h = wa.y + wa.height - y; // down to the bottom of the screen (room for bubbles)
  const x = settings.side === 'left' ? wa.x : wa.x + wa.width - w;
  const b = win.getBounds();
  if (b.x === x && b.y === y && b.width === w && b.height === h) return;
  win.setBounds({ x, y, width: w, height: h });
}

// Manual drag: while the button is held, follow the cursor; on release, snap to the nearest left/right edge.
// (-webkit-app-region:drag can't change the cursor on Windows, so this is done by hand)
let dragTimer = null;
function dragStart() {
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const off = { x: c.x - b.x, y: c.y - b.y };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - off.x, p.y - off.y);
  }, 16);
}
function dragEnd() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  snap();
}

function snap() {
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  settings.side = b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right';
  settings.y = b.y;
  saveSettings();
  win.webContents.send('side', settings.side);
  layout();
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: 120, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    // keep timers and alert sounds running while the widget is hidden
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.setIgnoreMouseEvents(true, { forward: true }); // start click-through; the renderer turns it off over the dock
    layout();
    win.showInactive();
  });
  if (!app.isPackaged) {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
    win.webContents.on('preload-error', (_, p, err) => console.log(`[preload-error] ${p}: ${err}`));
  }
}

// ---------- tray ----------
const TRAY_COLORS = { attention: [0xec, 0x3f, 0x3f], working: [0xf0, 0xa0, 0x20], ready: [0x1f, 0xb8, 0x60], idle: [0x9a, 0xa0, 0xab] };
function makeIcon([r, g, b]) {
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const a = d < 6 ? 1 : d < 7 ? 7 - d : 0;
    const i = (y * s + x) * 4; // BGRA, premultiplied
    buf[i] = Math.round(b * a); buf[i + 1] = Math.round(g * a); buf[i + 2] = Math.round(r * a); buf[i + 3] = Math.round(255 * a);
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function overall() {
  const st = store.list().map((s) => s.status);
  return ['attention', 'working', 'ready'].find((k) => st.includes(k)) || 'idle';
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeIcon(TRAY_COLORS[overall()]));
  const c = { working: 0, attention: 0, ready: 0 };
  for (const s of store.list()) if (s.status in c) c[s.status]++;
  tray.setToolTip(`Agents — working ${c.working} · attention ${c.attention} · ready ${c.ready}`);
}

const loginOpts = () => (app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] });
function buildTrayMenu() {
  const hs = hooksStatus();
  return Menu.buildFromTemplate([
    { label: 'Show / hide widget', click: toggleWindow },
    {
      label: `Claude Code hooks (${hs.installed ? (hs.broken ? 'broken path' : 'installed') : 'not installed'})`,
      submenu: [
        { label: hs.installed ? 'Reinstall' : 'Install', click: () => installHooks(false) },
        { label: 'Remove', enabled: hs.installed, click: () => { try { hooksCfg.uninstall(); } catch { /* ignore */ } } },
        { label: 'Open settings file', click: () => shell.openPath(hooksCfg.SETTINGS) },
      ],
    },
    soundMenu(),
    { label: 'Reset position', click: () => { settings.side = 'right'; settings.y = null; saveSettings(); win.webContents.send('side', 'right'); layout(); } },
    {
      label: 'Launch at login', type: 'checkbox',
      checked: app.getLoginItemSettings(loginOpts()).openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, ...loginOpts() }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function toggleWindow() {
  if (win.isVisible()) win.hide(); else { win.showInactive(); layout(); }
}

// ---------- Claude Code hook integration ----------
// In the exe, report.js lives inside asar where external node can't run it → copy it to the userData folder
const BUNDLED_HOOK = path.join(__dirname, '..', '..', 'hooks', 'report.js');
const hookScript = () => (app.isPackaged ? path.join(app.getPath('userData'), 'hooks', 'report.js') : BUNDLED_HOOK);

function ensureHookScript() {
  if (!app.isPackaged) return;
  try {
    const dst = hookScript();
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(BUNDLED_HOOK));
  } catch (e) { console.error('hook copy failed', e); }
}

function hooksStatus() {
  const list = hooksCfg.installedScripts();
  return { installed: list.length > 0, broken: list.some((p) => !fs.existsSync(p)) };
}

function installHooks(silent) {
  try {
    hooksCfg.install(hookScript());
    if (!silent) new Notification({ title: 'Agent Status', body: 'Claude Code hooks installed. Sessions will show up from their next event.' }).show();
  } catch (e) {
    new Notification({ title: 'Agent Status', body: `Failed to install hooks: ${e.message}` }).show();
  }
}

// First packaged run: install automatically. If the registered script path is missing (e.g. project folder deleted), fix it
function autoSetupHooks() {
  const st = hooksStatus();
  if (st.broken || (!st.installed && !settings.hooksSetupDone && app.isPackaged)) installHooks(true);
  if (!settings.hooksSetupDone) { settings.hooksSetupDone = true; saveSettings(); }
}

// ---------- helpers ----------
// If a VS Code window for the folder is already open, bring it to the front ourselves.
// (`code <folder>` only selects the existing window; Windows' focus-stealing protection leaves it flashing in the taskbar.)
// If it isn't open, open it with `code` and bring the new window up once it appears.
async function openInVSCode(cwd) {
  if (!cwd) return;
  const name = path.basename(cwd);
  if ((await focusVSCodeWindow(name)) === 'focused') return;
  const p = spawn(`code "${cwd.replace(/"/g, '')}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => shell.openPath(cwd));
  p.unref();
  // Bring the new window up as soon as it appears (check every 400 ms, up to 15 s)
  const until = Date.now() + 15000;
  const poll = async () => {
    if ((await focusVSCodeWindow(name)) === 'focused' || Date.now() > until) return;
    setTimeout(poll, 400);
  };
  setTimeout(poll, 400);
}

let pushT = null;
function push() {
  if (pushT) return;
  pushT = setTimeout(() => {
    pushT = null;
    if (win && !win.isDestroyed()) win.webContents.send('sessions', store.list());
    updateTray();
  }, 60);
}

// ---------- alerts: speech bubble beside the widget + sound (instead of Windows notifications) ----------
function notify(s) {
  if (!win || win.isDestroyed()) return;
  const text = s.status === 'attention' ? s.detail || 'Needs your attention' : s.summary || 'Finished';
  win.webContents.send('alert', { id: s.id, status: s.status, project: s.project, cwd: s.cwd, text, sound: soundPayload(s.status) });
}

// Sound: the renderer plays it. Built-in tones are synthesized there; custom files are sent as data URLs
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };
const audioCache = new Map();
function audioDataUrl(file) {
  if (audioCache.has(file)) return audioCache.get(file);
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 10 * 1024 * 1024) return null;
    const url = `data:${AUDIO_MIME[path.extname(file).toLowerCase()] || 'audio/mpeg'};base64,${buf.toString('base64')}`;
    audioCache.set(file, url);
    return url;
  } catch { return null; }
}
function soundPayload(kind) {
  const s = settings.sound;
  const file = kind === 'attention' ? s.attentionFile : s.readyFile;
  return { enabled: s.enabled, volume: s.volume, src: file ? audioDataUrl(file) : null };
}
function testSound(kind) {
  if (win && !win.isDestroyed()) win.webContents.send('play-sound', { kind, sound: { ...soundPayload(kind), enabled: true } });
}
async function chooseSound(key, kind) {
  const r = await dialog.showOpenDialog({
    title: kind === 'attention' ? 'Needs-attention sound' : 'Ready sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
  });
  if (r.canceled || !r.filePaths[0]) return;
  settings.sound[key] = r.filePaths[0];
  audioCache.delete(r.filePaths[0]);
  saveSettings();
  testSound(kind);
}
function soundMenu() {
  const s = settings.sound;
  const fileItem = (key, kind, label) => ({
    label,
    submenu: [
      { label: 'Built-in', type: 'radio', checked: !s[key], click: () => { s[key] = null; saveSettings(); testSound(kind); } },
      { label: s[key] ? `Custom: ${path.basename(s[key])}  (change…)` : 'Custom file…', type: 'radio', checked: !!s[key], click: () => chooseSound(key, kind) },
    ],
  });
  return {
    label: 'Sound',
    submenu: [
      { label: 'Play sounds', type: 'checkbox', checked: s.enabled, click: (mi) => { s.enabled = mi.checked; saveSettings(); } },
      {
        label: 'Volume',
        submenu: [['Low', 0.3], ['Medium', 0.6], ['High', 1]].map(([l, v]) => ({
          label: l, type: 'radio', checked: Math.abs(s.volume - v) < 0.01,
          click: () => { s.volume = v; saveSettings(); testSound('ready'); },
        })),
      },
      { type: 'separator' },
      fileItem('readyFile', 'ready', 'Ready sound'),
      fileItem('attentionFile', 'attention', 'Needs-attention sound'),
      { type: 'separator' },
      { label: 'Test ready sound', click: () => testSound('ready') },
      { label: 'Test needs-attention sound', click: () => testSound('attention') },
    ],
  };
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('init', () => ({ sessions: store.list(), settings }));
  ipcMain.on('set-ignore', (_, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
  ipcMain.on('content-height', (_, h) => {
    const nh = Math.ceil(h);
    if (nh !== contentH) { contentH = nh; layout(); }
  });
  ipcMain.on('toggle-notify', (_, id) => store.toggleNotify(id));
  // Refresh: reconcile the list with open VS Code windows
  ipcMain.handle('refresh', async () => {
    const titles = await listVSCodeTitles();
    if (!titles) return { ok: false };
    const open = new Set(titles.flatMap(titleParts));
    return { ok: true, removed: store.reconcile(open) };
  });
  ipcMain.on('open-vscode', (_, id) => { const s = store.get(id); if (s) openInVSCode(s.cwd); });
  // Bubble click: go to that session's VS Code window (cwd is a fallback if the session already ended)
  ipcMain.on('bubble-open', (_, id, cwd) => { const s = store.get(id); openInVSCode((s && s.cwd) || cwd); });
  ipcMain.on('set-pinned', (_, v) => { settings.pinned = !!v; saveSettings(); });
  ipcMain.on('drag-start', dragStart);
  ipcMain.on('drag-end', dragEnd);
  ipcMain.on('set-theme', (_, t) => { settings.theme = t === 'dark' ? 'dark' : 'light'; saveSettings(); });
  ipcMain.on('row-menu', (_, id) => {
    const s = store.get(id);
    if (!s) return;
    Menu.buildFromTemplate([
      { label: 'Open in VS Code', enabled: !!s.cwd, click: () => openInVSCode(s.cwd) },
      { label: 'Open folder', enabled: !!s.cwd, click: () => shell.openPath(s.cwd) },
      { type: 'separator' },
      { label: s.notify ? 'Turn off notifications' : 'Turn on notifications', click: () => store.toggleNotify(id) },
      { label: 'Remove from list', click: () => store.remove(id) },
    ]).popup({ window: win, callback: () => win.webContents.send('menu-closed') });
  });
}

// ---------- boot ----------
app.whenReady().then(() => {
  settings = loadSettings();
  ensureHookScript();
  autoSetupHooks();
  store = new Store(path.join(app.getPath('userData'), 'sessions.json'));
  store.on('change', push);
  store.on('transition', (s) => {
    if (s.notify && (s.status === 'ready' || s.status === 'attention')) notify(s);
  });

  registerIpc();
  createWindow();

  tray = new Tray(makeIcon(TRAY_COLORS.idle));
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));
  updateTray();

  startServer(PORT, (event, payload, at) => store.handle(event, payload, at), (err) => {
    new Notification({
      title: 'Agent Status Manager',
      body: err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is another instance running?` : String(err.message),
    }).show();
  });

  screen.on('display-metrics-changed', layout);
  screen.on('display-removed', layout);
});

app.on('second-instance', () => { if (win) { win.showInactive(); layout(); } });
app.on('window-all-closed', (e) => e.preventDefault());
