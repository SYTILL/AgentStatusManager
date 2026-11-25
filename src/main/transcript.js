// Incremental reader for Claude Code transcript (JSONL) files.
// Each call reads only the bytes appended since the last call.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const CHUNK = 4 * 1024 * 1024;

function newState() {
  return {
    offset: 0, partial: '', decoder: new StringDecoder('utf8'),
    usage: {},          // message.id -> usage (one API message can span several lines; keep the last)
    firstTs: null,      // first timestamp in the file
    firstCwd: null,     // folder the session started in (hook cwd changes when the agent cd's elsewhere)
    lastText: '',       // most recent assistant text block
    interruptedAt: 0,   // time of the latest "[Request interrupted by user" marker
    mtime: 0,
  };
}

function parseLine(tx, line) {
  if (!line.trim()) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!tx.firstTs && !isNaN(ts)) tx.firstTs = ts;
  if (!tx.firstCwd && typeof o.cwd === 'string' && o.cwd) tx.firstCwd = o.cwd;

  const m = o.message;
  if (!m) return;
  if (o.type === 'assistant') {
    if (m.usage) tx.usage[m.id || o.uuid] = m.usage;
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === 'text' && b.text && b.text.trim()) tx.lastText = b.text;
    }
  } else if (o.type === 'user') {
    const c = m.content;
    const txt = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '';
    if (txt.includes('[Request interrupted by user')) tx.interruptedAt = isNaN(ts) ? Date.now() : ts;
  }
}

// Returns true if new content was read.
function readNew(tx, file) {
  if (!file) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  tx.mtime = st.mtimeMs;
  if (st.size < tx.offset) Object.assign(tx, newState(), { mtime: st.mtimeMs }); // file rewritten
  if (st.size === tx.offset) return false;

  const fd = fs.openSync(file, 'r');
  try {
    while (tx.offset < st.size) {
      const len = Math.min(CHUNK, st.size - tx.offset);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, tx.offset);
      if (n <= 0) break;
      tx.offset += n;
      const lines = (tx.partial + tx.decoder.write(buf.subarray(0, n))).split('\n');
      tx.partial = lines.pop();
      for (const l of lines) parseLine(tx, l);
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function totals(tx) {
  const t = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of Object.values(tx.usage)) {
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheCreation += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
  }
  return t;
}

module.exports = { newState, readNew, totals };
