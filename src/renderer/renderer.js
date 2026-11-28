(() => {
const api = window.api;
const $ = (id) => document.getElementById(id);
const dock = $('dock'), list = $('list');
const hwrap = $('hwrap'), hbar = $('hbar'), segs = $('segs'), hcards = $('hcards');
const bubblesEl = $('bubbles');
const LABEL = { working: 'Working', ready: 'Ready', attention: 'Needs attention', idle: 'Idle' };
let sessions = [];
// view settings from the main process
let cfg = { layout: 'vertical', side: 'right', snap: true, pinned: false, theme: 'light' };
const isH = () => cfg.layout === 'horizontal';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
};
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n));
// Token count = input + cache creation + output (cache reads excluded; shown in the tooltip)
const tokTotal = (t) => (t.input || 0) + (t.cacheCreation || 0) + (t.output || 0);
const num = (n) => (n || 0).toLocaleString('en-US');
const tokTip = (t) => `Input ${num(t.input)} · Cache write ${num(t.cacheCreation)} · Output ${num(t.output)} · Cache read ${num(t.cacheRead)}`;

const ICON_MINI = `<svg class="mini" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>`;
const ICON_ON = `<svg class="on-ic" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>`;
const ICON_OFF = `<svg class="off-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 16v-5a6 6 0 0 0-9.5-4.9M6.3 8.6A6 6 0 0 0 6 11v5l-2 2h13"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M3 3l18 18"/></svg>`;
const ICON_X = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const BELL = `<button class="bell" title="Toggle notifications">${ICON_ON}${ICON_OFF}</button>`;

// refresh / theme buttons go in both layouts' bars
for (const slot of document.querySelectorAll('.tools-slot')) slot.appendChild($('tools').content.cloneNode(true));

function lineText(s) {
  if (s.status === 'attention') return s.detail || s.summary || 'Needs your attention';
  if (s.status === 'working') return [s.summary, s.detail].filter(Boolean).join(' · ') || 'Working';
  return s.summary || '—';
}

// "·2" suffix for a second session in the same project
function displayNames() {
  const seen = {};
  return sessions.map((s) => {
    seen[s.project] = (seen[s.project] || 0) + 1;
    return seen[s.project] > 1 ? `${s.project} ·${seen[s.project]}` : s.project;
  });
}
const rowAttrs = (s) => `class="%C ${s.status} ${s.notify ? 'n' : ''} ${s.cwd ? 'link' : ''}" data-id="${esc(s.id)}" ${s.cwd ? 'title="Open in VS Code"' : ''}`;

// ---- vertical: one row per session ----
function renderVertical(names) {
  if (!sessions.length) { list.innerHTML = '<div class="empty">No active sessions</div>'; return; }
  list.innerHTML = sessions.map((s, i) => {
    const t = s.tokens || {};
    const txt = lineText(s);
    return `
    <div ${rowAttrs(s).replace('%C', 'item')}>
      <div class="rail"><span class="bar"></span><div class="nm">
        <div class="name" title="${esc(s.cwd)}"><span>${esc(names[i])}</span>${ICON_MINI}</div>
        <div class="timer"><span data-t></span></div></div></div>
      <div class="info">
        <div class="st">${LABEL[s.status] || s.status}</div>
        <div class="sum" title="${esc(txt)}">${esc(txt)}</div>
        <div class="meta"><span>Session <b data-s></b></span><span title="${esc(tokTip(t))}">Tokens <b>${fmtTok(tokTotal(t))}</b></span></div>
      </div>
      ${BELL}
    </div>`;
  }).join('');
}

// ---- horizontal: equal segments; details in a popover (hover) or cards ("Always expanded") ----
function cardBody(s, name) {
  const t = s.tokens || {};
  return `<div class="cst">${LABEL[s.status] || s.status}</div>
    <div class="cn">${esc(name)}</div>
    <div class="cs" title="${esc(lineText(s))}">${esc(lineText(s))}</div>
    <div class="cm"><span class="cmv" title="Session time"><span class="lbl">Session </span><b data-s></b></span><span class="cmv" title="${esc(tokTip(t))}"><span class="lbl">Tokens </span><b>${fmtTok(tokTotal(t))}</b><span class="lbl2"> tok</span></span>${BELL}</div>`;
}
function renderHorizontal(names) {
  if (!sessions.length) {
    segs.innerHTML = '<div class="hempty">No active sessions</div>';
    hcards.innerHTML = '';
  } else {
    segs.innerHTML = sessions.map((s, i) => `
      <div ${rowAttrs(s).replace('%C', 'seg')}>
        <span class="snm">${esc(names[i])}</span>${ICON_MINI}<span class="timer"><span data-t></span></span>
        <span class="sbar"></span>
        <div class="pop"><div class="card ${s.status}">${cardBody(s, names[i])}</div></div>
      </div>`).join('');
    hcards.innerHTML = sessions.map((s, i) => `<div ${rowAttrs(s).replace('%C', 'card hcard')}>${cardBody(s, names[i])}</div>`).join('');
  }
  sizeBar();
}
// Bar width grows with the number of sessions; cards line up under the segments
function sizeBar() {
  const n = Math.max(1, sessions.length);
  const w = Math.max(380, Math.min(1000, 140 + n * 150));
  hwrap.style.width = `${w}px`;
  requestAnimationFrame(() => {
    hcards.style.paddingLeft = `${segs.offsetLeft}px`;
    hcards.style.paddingRight = `${hbar.clientWidth - segs.offsetLeft - segs.offsetWidth}px`;
    layoutBubbles();
  });
}

function render() {
  const names = displayNames();
  renderVertical(names);
  renderHorizontal(names);
  tick();
  reportSize();
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.item[data-id], .seg[data-id], .hcard[data-id]')) {
    const s = sessions.find((x) => x.id === el.dataset.id);
    if (!s) continue;
    const run = s.runStartedAt ? now - s.runStartedAt : s.lastDurationMs;
    for (const t of el.querySelectorAll('[data-t]')) t.textContent = run == null ? '—' : fmt(run);
    // Session timer: non-idle time only ('—' if it never started)
    const total = (s.sessionAccumMs || 0) + (s.sessionSegStart ? Math.max(0, now - s.sessionSegStart) : 0);
    for (const t of el.querySelectorAll('[data-s]')) t.textContent = s.sessionStartedAt ? fmt(total) : '—';
  }
}
setInterval(tick, 1000);

// ---- expand / collapse (vertical: only when hovering the session list) ----
let hoverOpen = false, closeT = null, menuOpen = false;
function syncWide() {
  dock.classList.toggle('wide', hoverOpen || cfg.pinned);
  hwrap.classList.toggle('expanded', !!cfg.pinned);
  layoutBubbles();
}
function setOpen(v) {
  if (hoverOpen === v) return;
  hoverOpen = v;
  syncWide();
}
list.addEventListener('mouseenter', () => {
  if (isDragging()) return;
  clearTimeout(closeT);
  setOpen(true);
});
list.addEventListener('mouseleave', () => {
  if (menuOpen) return;
  clearTimeout(closeT);
  closeT = setTimeout(() => setOpen(false), 150);
});

// ---- click-through ----
// Only the widget and the bubbles take the mouse; transparent areas pass it to the window behind.
// With forward:true, mousemove still arrives while ignoring, so decide by what's under the cursor.
const INTERACTIVE = '.dock, .hbar, .hcards, .bubble';
let ignoring = true;
const isDragging = () => document.body.classList.contains('dragging');
function setIgnore(v) { if (v !== ignoring) { ignoring = v; api.setIgnoreMouse(v); } }
const overInteractive = () => [...document.querySelectorAll(INTERACTIVE)].some((el) => el.matches(':hover'));
document.addEventListener('mousemove', (e) => {
  if (isDragging() || menuOpen) return;
  setIgnore(!e.target.closest(INTERACTIVE));
});
document.addEventListener('mouseleave', () => { if (!isDragging() && !menuOpen) setIgnore(true); });

api.onMenuClosed(() => {
  menuOpen = false;
  if (!list.matches(':hover')) setOpen(false);
  setIgnore(!overInteractive());
});

// ---- clicks ----
// 🔔 toggles notifications; a click anywhere else on a session opens its VS Code window
document.addEventListener('click', (e) => {
  const bubble = e.target.closest('.bubble');
  if (bubble) { onBubbleClick(e, bubble); return; }
  const bell = e.target.closest('.bell');
  if (bell) { const el = bell.closest('[data-id]'); if (el) api.toggleNotify(el.dataset.id); return; }
  const it = e.target.closest('[data-id].link');
  if (it && !it.classList.contains('bubble')) api.openInVSCode(it.dataset.id);
});
// Right-click on a session → its menu
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('.bubble')) return;
  const it = e.target.closest('.item[data-id], .seg[data-id], .hcard[data-id]');
  if (it) { menuOpen = true; api.rowMenu(it.dataset.id); }
});
// ⚙ → the settings menu (same as the tray menu)
for (const btn of document.querySelectorAll('.act-settings')) {
  btn.addEventListener('click', () => { menuOpen = true; api.settingsMenu(); });
}

// Drag by the top bar (vertical) or the grip/title (horizontal); the main process moves the window
for (const handle of document.querySelectorAll('.drag-handle')) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    document.body.classList.add('dragging');
    api.dragStart();
    const end = () => {
      document.body.classList.remove('dragging');
      api.dragEnd();
      setIgnore(!overInteractive());
      removeEventListener('mouseup', end);
      removeEventListener('blur', end);
    };
    addEventListener('mouseup', end);
    addEventListener('blur', end);
  });
}

for (const btn of document.querySelectorAll('.act-refresh')) {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('spin')) return;
    document.querySelectorAll('.act-refresh').forEach((b) => b.classList.add('spin'));
    const started = Date.now();
    try { await api.refresh(); } finally {
      // keep the spin visible for at least half a second so the click registers
      setTimeout(() => document.querySelectorAll('.act-refresh').forEach((b) => b.classList.remove('spin')), Math.max(0, 500 - (Date.now() - started)));
    }
  });
}
for (const btn of document.querySelectorAll('.act-theme')) {
  btn.addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    api.setTheme(t);
  });
}

// ---- settings from the main process: layout, side, snap, always expanded ----
function applySettings(s) {
  const prevLayout = cfg.layout;
  cfg = { ...cfg, ...s };
  document.documentElement.dataset.theme = cfg.theme;
  document.body.dataset.layout = isH() ? 'horizontal' : 'vertical';
  document.body.dataset.side = isH() ? 'top' : cfg.side === 'left' ? 'left' : 'right';
  dock.classList.toggle('left', cfg.side === 'left');
  dock.classList.toggle('right', cfg.side !== 'left');
  dock.classList.toggle('free', !cfg.snap);
  hwrap.classList.toggle('snap', !!cfg.snap);
  if (prevLayout !== cfg.layout) {
    // switching layouts: drop inline bubble positions from the other layout
    for (const b of bubbles.values()) { b.el.style.left = ''; b.el.style.top = ''; }
    hoverOpen = false;
  }
  syncWide();
  sizeBar();
  reportSize();
}

// vertical: window height = dock height when expanded (rows 50px), so it doesn't change on expand/collapse
// horizontal: bar width (the window keeps a fixed size around it)
const ROW_WIDE = 50, ROW = 24;
function reportSize() {
  const n = list.querySelectorAll('.item').length;
  const top = $('top').offsetHeight || 20;
  api.contentSize({ h: 2 + top + 4 + (n ? n * ROW_WIDE : ROW) + 2, w: hwrap.offsetWidth || 600 });
}

// ---- alert bubbles ----
// One bubble per session (the latest alert replaces it). Click → close + go to that VS Code window; × → close only.
// It closes on its own when the session starts working again, goes idle, ends, or notifications are turned off.
const bubbles = new Map(); // id -> { el, cwd }

function showBubble(a) {
  let b = bubbles.get(a.id);
  if (!b) {
    const el = document.createElement('div');
    el.dataset.bid = a.id;
    bubblesEl.appendChild(el);
    b = { el };
    bubbles.set(a.id, b);
    el.className = `bubble ${a.status} enter`;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter')));
  } else {
    b.el.className = `bubble ${a.status}`;
  }
  b.cwd = a.cwd;
  b.el.title = a.text;
  b.el.innerHTML = `
    <div class="bh"><span class="bd"></span><span class="pn">${esc(a.project)}</span><span class="bs">${LABEL[a.status] || ''}</span></div>
    <div class="bt">${esc(a.text)}</div>
    <button class="bx" title="Dismiss">${ICON_X}</button>`;
  layoutBubbles();
}

function closeBubble(id) {
  const b = bubbles.get(id);
  if (!b) return;
  bubbles.delete(id);
  b.el.classList.add('leave');
  setTimeout(() => { b.el.remove(); layoutBubbles(); if (!overInteractive()) setIgnore(true); }, 180);
}

function onBubbleClick(e, el) {
  const id = el.dataset.bid;
  const cwd = bubbles.get(id)?.cwd;
  closeBubble(id);
  if (!e.target.closest('.bx')) api.openFromBubble(id, cwd);
}

function orderedBubbles() {
  const ids = sessions.map((s) => s.id);
  const idx = (id) => { const i = ids.indexOf(id); return i < 0 ? 1e9 : i; };
  return [...bubbles.entries()].sort((a, b) => idx(a[0]) - idx(b[0]));
}

function layoutBubbles() {
  if (!bubbles.size) return;
  if (isH()) layoutBubblesH(); else layoutBubblesV();
}

// vertical: line each bubble up with its session row (tail pointing at the row); push down to avoid overlaps
function layoutBubblesV() {
  const rowH = dock.classList.contains('wide') ? ROW_WIDE : ROW;
  const listTop = 1 + $('top').offsetHeight + 2;
  const ids = sessions.map((s) => s.id);
  let bottom = 0;
  for (const [id, b] of orderedBubbles()) {
    const i = ids.indexOf(id);
    const rowCenter = listTop + (i < 0 ? ids.length : i) * rowH + rowH / 2;
    const top = Math.max(rowCenter - 13, bottom);
    b.el.style.left = '';
    b.el.style.top = `${top}px`;
    bottom = top + b.el.offsetHeight + 6;
  }
}

// horizontal: under the segment (tail pointing up at it); if two would overlap, the later one moves down
function layoutBubblesH() {
  const base = (cfg.pinned ? hcards.getBoundingClientRect().bottom : hbar.getBoundingClientRect().bottom) + 8;
  const placed = [];
  for (const [id, b] of orderedBubbles()) {
    const seg = segs.querySelector(`.seg[data-id="${CSS.escape(id)}"]`);
    const r = seg ? seg.getBoundingClientRect() : hbar.getBoundingClientRect();
    const w = b.el.offsetWidth, h = b.el.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, Math.round(r.left + r.width / 2 - 22)));
    let top = base;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        if (left < p.right + 4 && left + w > p.left - 4 && top < p.bottom && top + h > p.top) { top = p.bottom + 6; moved = true; }
      }
    }
    b.el.style.left = `${left}px`;
    b.el.style.top = `${top}px`;
    placed.push({ left, right: left + w, top, bottom: top + h });
  }
}

function pruneBubbles() {
  for (const id of [...bubbles.keys()]) {
    const s = sessions.find((x) => x.id === id);
    if (!s || !s.notify || s.status === 'working' || s.status === 'idle') closeBubble(id);
  }
}

// ---- sound ----
// Built-in: synthesized tones (Ready = two soft rising notes, Needs attention = three short beeps). Custom: audio file.
let actx = null;
function synth(kind, vol) {
  actx = actx || new AudioContext();
  const t0 = actx.currentTime + 0.02;
  const att = kind === 'attention';
  const notes = att ? [[880, 0], [880, 0.15], [1175, 0.3]] : [[659, 0], [988, 0.14]];
  for (const [f, dt] of notes) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = att ? 'triangle' : 'sine';
    o.frequency.value = f;
    const len = att ? 0.13 : 0.5;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.linearRampToValueAtTime(0.32 * vol, t0 + dt + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + len);
    o.connect(g).connect(actx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + len + 0.05);
  }
}
function playSound(kind, snd) {
  if (!snd || !snd.enabled) return;
  if (snd.src) {
    const a = new Audio(snd.src);
    a.volume = Math.max(0, Math.min(1, snd.volume));
    a.play().catch(() => synth(kind, snd.volume));
  } else synth(kind, snd.volume);
}

api.onAlert((a) => { showBubble(a); playSound(a.status, a.sound); });
api.onPlaySound(({ kind, sound }) => playSound(kind, sound));
api.onSessions((d) => { sessions = d; render(); pruneBubbles(); layoutBubbles(); });
api.onSettings(applySettings);
api.init().then(({ sessions: s, settings }) => {
  sessions = s;
  // apply "Always expanded" without the open animation on startup
  dock.style.transition = 'none';
  applySettings(settings);
  requestAnimationFrame(() => (dock.style.transition = ''));
  render();
});
})();
