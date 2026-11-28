(() => {
const api = window.api;
const dock = document.getElementById('dock');
const list = document.getElementById('list');
const LABEL = { working: 'Working', ready: 'Ready', attention: 'Needs attention', idle: 'Idle' };
let sessions = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
};
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n));
// Token count = input + cache creation + output (cache reads excluded; shown in the tooltip)
const tokTotal = (t) => (t.input || 0) + (t.cacheCreation || 0) + (t.output || 0);
const num = (n) => (n || 0).toLocaleString('en-US');

const ICON_MINI = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>`;
const ICON_ON = `<svg class="on-ic" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>`;
const ICON_OFF = `<svg class="off-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 16v-5a6 6 0 0 0-9.5-4.9M6.3 8.6A6 6 0 0 0 6 11v5l-2 2h13"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M3 3l18 18"/></svg>`;

// "Open in editor" icon: a window with an arrow pointing out
const ICON_OPEN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`;

function lineText(s) {
  if (s.status === 'attention') return s.detail || s.summary || 'Needs your attention';
  if (s.status === 'working') return [s.summary, s.detail].filter(Boolean).join(' · ') || 'Working';
  return s.summary || '—';
}

function render() {
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">No active sessions</div>';
    return;
  }
  const seen = {};
  list.innerHTML = sessions.map((s) => {
    seen[s.project] = (seen[s.project] || 0) + 1;
    const name = seen[s.project] > 1 ? `${s.project} ·${seen[s.project]}` : s.project;
    const t = s.tokens || {};
    const tip = `Input ${num(t.input)} · Cache write ${num(t.cacheCreation)} · Output ${num(t.output)} · Cache read ${num(t.cacheRead)}`;
    const txt = lineText(s);
    return `
    <div class="item ${s.status} ${s.notify ? 'n' : ''}" data-id="${esc(s.id)}">
      <div class="rail"><span class="bar"></span><div class="nm">
        <div class="name" title="${esc(s.cwd)}"><span>${esc(name)}</span>${ICON_MINI}</div>
        <div class="timer"><span data-t></span></div></div></div>
      <div class="info">
        <div class="st">${LABEL[s.status] || s.status}</div>
        <div class="sum" title="${esc(txt)}">${esc(txt)}</div>
        <div class="meta"><span>Session <b data-s></b></span><span title="${esc(tip)}">Tokens <b>${fmtTok(tokTotal(t))}</b></span></div>
      </div>
      <button class="vsc" title="Open in VS Code" ${s.cwd ? '' : 'disabled'}>${ICON_OPEN}</button>
      <button class="bell" title="Toggle notifications">${ICON_ON}${ICON_OFF}</button>
    </div>`;
  }).join('');
  tick();
}

function tick() {
  const now = Date.now();
  for (const el of list.querySelectorAll('.item')) {
    const s = sessions.find((x) => x.id === el.dataset.id);
    if (!s) continue;
    const run = s.runStartedAt ? now - s.runStartedAt : s.lastDurationMs;
    el.querySelector('[data-t]').textContent = run == null ? '—' : fmt(run);
    // Session timer: non-idle time only ('—' if it never started)
    const total = (s.sessionAccumMs || 0) + (s.sessionSegStart ? Math.max(0, now - s.sessionSegStart) : 0);
    el.querySelector('[data-s]').textContent = s.sessionStartedAt ? fmt(total) : '—';
  }
}
setInterval(tick, 1000);

// ---- expand / collapse (only when hovering the session list) ----
// The window is always at the expanded size, so only the CSS class is toggled (no flicker)
let hoverOpen = false, pinned = false, closeT = null, menuOpen = false;
const wantWide = () => hoverOpen || pinned;
function syncWide() { dock.classList.toggle('wide', wantWide()); layoutBubbles(); }

// Click-through: only the dock and the bubbles take the mouse; transparent areas pass it to the window behind.
// With forward:true, mousemove still arrives while ignoring, so decide by what's under the cursor.
let ignoring = true;
const isDragging = () => document.body.classList.contains('dragging');
function setIgnore(v) { if (v !== ignoring) { ignoring = v; api.setIgnoreMouse(v); } }
const overInteractive = () => !!document.querySelector('.dock:hover, .bubble:hover');
document.addEventListener('mousemove', (e) => {
  if (isDragging() || menuOpen) return;
  setIgnore(!e.target.closest('.dock, .bubble'));
});
document.addEventListener('mouseleave', () => { if (!isDragging() && !menuOpen) setIgnore(true); });

function setOpen(v) {
  if (hoverOpen === v) return;
  hoverOpen = v;
  syncWide();
}
list.addEventListener('mouseenter', () => {
  if (document.body.classList.contains('dragging')) return;
  clearTimeout(closeT);
  setOpen(true);
});
list.addEventListener('mouseleave', () => {
  if (menuOpen) return;
  clearTimeout(closeT);
  closeT = setTimeout(() => setOpen(false), 150);
});
api.onMenuClosed(() => {
  menuOpen = false;
  if (!list.matches(':hover')) setOpen(false);
  setIgnore(!overInteractive());
});

list.addEventListener('click', (e) => {
  const v = e.target.closest('.vsc');
  if (v) { api.openInVSCode(v.closest('.item').dataset.id); return; }
  const b = e.target.closest('.bell');
  if (b) api.toggleNotify(b.closest('.item').dataset.id);
});
list.addEventListener('contextmenu', (e) => {
  const it = e.target.closest('.item');
  if (!it) return;
  e.preventDefault();
  menuOpen = true;
  api.rowMenu(it.dataset.id);
});

document.getElementById('pin').addEventListener('click', () => {
  pinned = !pinned;
  dock.classList.toggle('pinned', pinned);
  api.setPinned(pinned);
  if (!pinned && list.matches(':hover')) hoverOpen = true;
  syncWide();
});

// Drag the top bar (the main process moves the window to follow the cursor)
document.getElementById('top').addEventListener('mousedown', (e) => {
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
const refreshBtn = document.getElementById('refresh');
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spin')) return;
  refreshBtn.classList.add('spin');
  const started = Date.now();
  try { await api.refresh(); } finally {
    // keep the spin visible for at least half a second so the click registers
    setTimeout(() => refreshBtn.classList.remove('spin'), Math.max(0, 500 - (Date.now() - started)));
  }
});
document.getElementById('theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  api.setTheme(t);
});

function setSide(side) {
  dock.classList.toggle('left', side === 'left');
  dock.classList.toggle('right', side !== 'left');
  document.body.dataset.side = side === 'left' ? 'left' : 'right';
}

// ---- alert bubbles ----
// One bubble per session (the latest alert replaces it). Click → close + go to that VS Code window; × → close only.
// It closes on its own when the session starts working again, goes idle, ends, or notifications are turned off.
const bubblesEl = document.getElementById('bubbles');
const bubbles = new Map(); // id -> { el, cwd }
const ICON_X = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function showBubble(a) {
  let b = bubbles.get(a.id);
  if (!b) {
    const el = document.createElement('div');
    el.dataset.id = a.id;
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

// Line each bubble up with its session row (tail pointing at the row); push down to avoid overlaps
function layoutBubbles() {
  if (!bubbles.size) return;
  const wide = dock.classList.contains('wide');
  const rowH = wide ? ROW_WIDE : ROW;
  const listTop = 1 + document.getElementById('top').offsetHeight + 2;
  const ids = sessions.map((s) => s.id);
  const entries = [...bubbles.entries()].sort((a, b) => {
    const ia = ids.indexOf(a[0]), ib = ids.indexOf(b[0]);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  let bottom = 0;
  for (const [id, b] of entries) {
    const i = ids.indexOf(id);
    const rowCenter = listTop + (i < 0 ? ids.length : i) * rowH + rowH / 2;
    const top = Math.max(rowCenter - 13, bottom);
    b.el.style.top = `${top}px`;
    bottom = top + b.el.offsetHeight + 6;
  }
}

bubblesEl.addEventListener('click', (e) => {
  const el = e.target.closest('.bubble');
  if (!el) return;
  const id = el.dataset.id;
  const cwd = bubbles.get(id)?.cwd;
  closeBubble(id);
  if (!e.target.closest('.bx')) api.openFromBubble(id, cwd);
});

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

// Window height = dock height when expanded (rows 50px). Fixed regardless of expand/collapse,
// so the window only resizes when the number of sessions changes
const ROW_WIDE = 50, ROW = 24;
function reportHeight() {
  const n = list.querySelectorAll('.item').length;
  const top = document.getElementById('top').offsetHeight;
  api.contentHeight(2 + top + 4 + (n ? n * ROW_WIDE : ROW) + 2);
}
new MutationObserver(reportHeight).observe(list, { childList: true });

api.onSessions((d) => { sessions = d; render(); pruneBubbles(); layoutBubbles(); });
api.onSide((side) => { setSide(side); layoutBubbles(); });
api.init().then(({ sessions: s, settings }) => {
  document.documentElement.dataset.theme = settings.theme;
  pinned = !!settings.pinned;
  dock.classList.toggle('pinned', pinned);
  if (pinned) { dock.style.transition = 'none'; dock.classList.add('wide'); requestAnimationFrame(() => (dock.style.transition = '')); }
  setSide(settings.side);
  sessions = s;
  render();
});
})();
