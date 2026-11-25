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
function syncWide() { dock.classList.toggle('wide', wantWide()); }

// Click-through: transparent areas outside the dock pass the mouse to the window behind
let overDock = false;
dock.addEventListener('mouseenter', () => { overDock = true; api.setIgnoreMouse(false); });
dock.addEventListener('mouseleave', () => {
  overDock = false;
  if (!document.body.classList.contains('dragging') && !menuOpen) api.setIgnoreMouse(true);
});

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
  if (!dock.matches(':hover')) api.setIgnoreMouse(true);
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
    if (!dock.matches(':hover')) api.setIgnoreMouse(true);
    removeEventListener('mouseup', end);
    removeEventListener('blur', end);
  };
  addEventListener('mouseup', end);
  addEventListener('blur', end);
});
document.getElementById('theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  api.setTheme(t);
});

function setSide(side) {
  dock.classList.toggle('left', side === 'left');
  dock.classList.toggle('right', side !== 'left');
}

// Window height = dock height when expanded (rows 50px). Fixed regardless of expand/collapse,
// so the window only resizes when the number of sessions changes
const ROW_WIDE = 50, ROW = 24;
function reportHeight() {
  const n = list.querySelectorAll('.item').length;
  const top = document.getElementById('top').offsetHeight;
  api.contentHeight(2 + top + 4 + (n ? n * ROW_WIDE : ROW) + 2);
}
new MutationObserver(reportHeight).observe(list, { childList: true });

api.onSessions((d) => { sessions = d; render(); });
api.onSide(setSide);
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
