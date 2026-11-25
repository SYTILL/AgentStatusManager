// Session state store: maps hook events to statuses (see the README table).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const tx = require('./transcript');

const MIN = 60 * 1000;
const READY_TO_IDLE = 60 * MIN;   // ready for this long → idle
const STALE_WORKING = 20 * MIN;   // working with no events/transcript writes this long → idle
const DROP_IDLE = 24 * 60 * MIN;  // idle for this long → removed from the list
const SWEEP_MS = 3000;
const SLOT_KEEP = 30 * MIN;       // a new session in the same folder within this long after the last one ended keeps its slot

const slotKey = (cwd) => (cwd ? path.resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '');

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function firstLine(s) {
  const l = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return trunc(l, 120);
}

function firstSentence(s) {
  const lines = String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !/^[-=:|\s]{3,}$/.test(x));
  // Prefer body text over headings (## ...); fall back to a heading if that's all there is
  const pick = lines.find((x) => !x.startsWith('#')) || lines[0] || '';
  const line = pick.replace(/^[\s>#*\-•|]+/, '').replace(/[*_`|]/g, '').trim();
  const m = line.match(/^.*?[.!?。](?=\s|$)/);
  return trunc(oneLine(m ? m[0] : line), 120);
}

function describeTool(name, input) {
  name = String(name || 'Tool');
  if (name.startsWith('mcp__')) name = name.split('__').pop();
  const i = input || {};
  let a = '';
  if (i.file_path || i.notebook_path) a = path.basename(i.file_path || i.notebook_path);
  else a = i.command || i.pattern || i.url || i.query || i.description || '';
  a = trunc(oneLine(a), 60);
  return a ? `${name}: ${a}` : name;
}

// Tools that wait for the user's answer → needs attention
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);

function isIdlePrompt(p) {
  return p.notification_type === 'idle_prompt' || /waiting for your input/i.test(p.message || '');
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.orderFile = path.join(path.dirname(file), 'order.json');
    this.sessions = new Map();
    // Row order is fixed per project folder (= VS Code open order).
    // A new session in the same folder (/clear, new chat) inherits the slot; reopening after 30+ minutes goes to the bottom.
    this.slots = new Map(); // folder key -> { order, endedAt }
    this._load();
    this._timer = setInterval(() => this._sweep(), SWEEP_MS);
  }

  _load() {
    try {
      for (const s of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
        if (s.sessionAccumMs === undefined) { // migrate data from the old format
          const ran = s.lastDurationMs != null || s.runStartedAt;
          s.sessionAccumMs = 0;
          s.sessionSegStart = null;
          if (!ran) s.sessionStartedAt = null;
          else if (s.status === 'idle') s.sessionAccumMs = Math.max(0, (s.idleAt || s.updatedAt) - s.sessionStartedAt);
          else s.sessionSegStart = s.sessionStartedAt;
          delete s.idleAt;
        }
        this.sessions.set(s.id, s);
      }
    } catch { /* first run */ }
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.orderFile, 'utf8')))) this.slots.set(k, v);
    } catch { /* first run */ }
    for (const s of this.sessions.values()) {
      if (s.created === undefined) s.created = s.order;
      const key = slotKey(s.cwd);
      if (!key) continue;
      s.slotKey = key;
      const slot = this.slots.get(key);
      if (!slot) this.slots.set(key, { order: s.order, endedAt: null });
      else { slot.endedAt = null; s.order = slot.order; }
    }
  }

  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.list(), null, 1));
        fs.writeFileSync(this.orderFile, JSON.stringify(Object.fromEntries(this.slots), null, 1));
      } catch { /* ignore */ }
    }, 500);
  }

  _liveInSlot(key, exceptId) {
    for (const s of this.sessions.values()) if (s.slotKey === key && s.id !== exceptId) return true;
    return false;
  }

  _assignSlot(s, at, isStart) {
    const key = slotKey(s.cwd);
    if (!key || s.slotKey === key) return;
    s.slotKey = key;
    const slot = this.slots.get(key);
    if (slot && (this._liveInSlot(key, s.id) || !slot.endedAt || at - slot.endedAt < SLOT_KEEP)) {
      slot.endedAt = null;
      s.order = slot.order;
      return;
    }
    // New slot: use the time the session was opened (if the widget started later, the transcript's first timestamp)
    let order = at;
    const ft = s._tx && s._tx.firstTs;
    if (!isStart && !s.sawStart && ft && ft < at && Date.now() - ft < 24 * 60 * MIN) order = ft;
    this.slots.set(key, { order, endedAt: null });
    s.order = order;
  }

  _releaseSlot(s, at) {
    if (!s.slotKey || this._liveInSlot(s.slotKey, s.id)) return;
    const slot = this.slots.get(s.slotKey);
    if (slot) slot.endedAt = at;
  }

  _deleteSession(s, at = Date.now()) {
    this._releaseSlot(s, at);
    this.sessions.delete(s.id);
  }

  _changed() { this._save(); this.emit('change'); }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => a.order - b.order || (a.created || 0) - (b.created || 0))
      .map(({ _tx, ...s }) => s);
  }

  get(id) { return this.sessions.get(id); }
  remove(id) {
    const s = this.sessions.get(id);
    if (s) { this._deleteSession(s); this._changed(); }
  }
  toggleNotify(id) {
    const s = this.sessions.get(id);
    if (s) { s.notify = !s.notify; this._changed(); }
  }

  _refresh(s) {
    if (!s.transcriptPath) return false;
    if (!s._tx) s._tx = tx.newState();
    const changed = tx.readNew(s._tx, s.transcriptPath);
    if (changed) s.tokens = tx.totals(s._tx);
    return changed;
  }

  // Session timer: counts only non-idle time.
  //   session time = sessionAccumMs (closed segments) + (now - sessionSegStart) (current segment)
  // - the first segment starts on the first activity (working/attention)
  // - going idle closes the segment; activity afterwards opens a new one
  _startGuess(s) {
    if (s.sawStart) return s.updatedAt; // saw the session open → start at the first activity
    // Widget started after the session: use the transcript's first timestamp
    // (a resumed old conversation has a very old first timestamp, so ignore anything older than a day)
    const ft = s._tx && s._tx.firstTs;
    return ft && ft < s.updatedAt && Date.now() - ft < 24 * 60 * MIN ? ft : s.updatedAt;
  }

  _setStatus(s, status, notify = true, at = s.updatedAt) {
    const prev = s.status;
    s.status = status;
    if (status === 'idle') {
      if (s.sessionSegStart) {
        s.sessionAccumMs = (s.sessionAccumMs || 0) + Math.max(0, at - s.sessionSegStart);
        s.sessionSegStart = null;
      }
    } else if (!s.sessionSegStart && (status === 'working' || status === 'attention')) {
      const first = !s.sessionStartedAt;
      s.sessionSegStart = first ? this._startGuess(s) : at;
      if (first) s.sessionStartedAt = s.sessionSegStart;
    }
    if (prev !== status && notify) this.emit('transition', s, prev);
  }

  _endRun(s, at) {
    if (s.runStartedAt) s.lastDurationMs = Math.max(0, at - s.runStartedAt);
    s.runStartedAt = null;
  }

  handle(event, p, at = Date.now()) {
    const id = p && p.session_id;
    if (!id) return;
    let s = this.sessions.get(id);

    if (event === 'SessionEnd') {
      if (s) { this._deleteSession(s, at); this._changed(); }
      return;
    }
    const known = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
    if (!known.includes(event)) return;

    if (!s) {
      s = {
        id, project: 'unknown', cwd: '', status: 'idle', summary: '', detail: '',
        runStartedAt: null, lastDurationMs: null,
        sessionStartedAt: null, sessionSegStart: null, sessionAccumMs: 0, sawStart: false,
        tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        notify: false, order: at, created: at, updatedAt: at,
      };
      this.sessions.set(id, s);
    }
    if (p.cwd) { s.cwd = p.cwd; s.project = path.basename(p.cwd) || p.cwd; }
    if (p.transcript_path) s.transcriptPath = p.transcript_path;
    s.updatedAt = at;
    this._refresh(s);
    this._assignSlot(s, at, event === 'SessionStart');

    switch (event) {
      case 'SessionStart':
        s.sawStart = true;
        break;

      case 'UserPromptSubmit':
        s.runStartedAt = at;
        s.summary = firstLine(p.prompt) || s.summary;
        s.detail = '';
        if (s._tx) s._tx.lastText = '';
        this._setStatus(s, 'working');
        break;

      case 'PreToolUse':
        if (!s.runStartedAt) s.runStartedAt = at;
        s.detail = describeTool(p.tool_name, p.tool_input);
        this._setStatus(s, ASKS_USER.has(p.tool_name) ? 'attention' : 'working');
        break;

      case 'PostToolUse':
        if (s.status === 'attention' || s.status === 'idle') this._setStatus(s, 'working');
        break;

      case 'Notification':
        if (isIdlePrompt(p)) break; // "waiting for your input" after it already finished → keep ready
        s.detail = oneLine(p.message) || 'Needs your attention';
        this._setStatus(s, 'attention');
        break;

      case 'Stop': {
        this._endRun(s, at);
        s.detail = '';
        const direct = p.last_assistant_message;
        if (direct) s.summary = firstSentence(direct);
        else if (s._tx && s._tx.lastText) s.summary = firstSentence(s._tx.lastText);
        this._setStatus(s, 'ready');
        // The transcript may not have the final message flushed yet → read once more shortly after
        if (!direct) {
          setTimeout(() => {
            if (s.status === 'ready' && this._refresh(s) && s._tx.lastText) {
              s.summary = firstSentence(s._tx.lastText);
              this._changed();
            }
          }, 1200);
        }
        break;
      }
    }
    this._changed();
  }

  _sweep() {
    const now = Date.now();
    let ch = false;
    for (const s of [...this.sessions.values()]) {
      if (s.status === 'working' || s.status === 'attention') {
        if (this._refresh(s)) ch = true;
        const t = s._tx;
        // Interrupted with Esc: Stop does not fire, so detect it from the transcript
        if (t && t.interruptedAt && s.runStartedAt && t.interruptedAt >= s.runStartedAt) {
          this._endRun(s, t.interruptedAt);
          s.detail = '';
          s.summary = `(interrupted) ${s.summary || ''}`.trim();
          s.updatedAt = now;
          this._setStatus(s, 'ready', false);
          ch = true;
          continue;
        }
        const last = Math.max(s.updatedAt, (t && t.mtime) || 0);
        if (now - last > STALE_WORKING) {
          this._endRun(s, last);
          this._setStatus(s, 'idle', false, last);
          ch = true;
        }
      } else if (s.status === 'ready' && now - s.updatedAt > READY_TO_IDLE) {
        this._setStatus(s, 'idle', false, s.updatedAt);
        ch = true;
      } else if (s.status === 'idle' && now - s.updatedAt > DROP_IDLE) {
        this._deleteSession(s, now);
        ch = true;
      }
    }
    // Clean up slots of folders whose sessions ended long ago
    for (const [k, v] of this.slots) {
      if (v.endedAt && now - v.endedAt > SLOT_KEEP && !this._liveInSlot(k)) { this.slots.delete(k); ch = true; }
    }
    if (ch) this._changed();
  }
}

module.exports = { Store, firstSentence, describeTool };
