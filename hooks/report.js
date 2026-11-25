#!/usr/bin/env node
// Called by Claude Code hooks. Usage: node report.js <EventName>
// Reads the hook JSON from stdin and forwards it to the widget.
// Must never block or fail Claude: always exits 0, with a short timeout.
const http = require('http');

const PORT = process.env.AGENT_STATUS_PORT || 7777;
const event = process.argv[2] || 'Unknown';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  const body = JSON.stringify({ event, payload, at: Date.now() });

  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 800 },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
setTimeout(() => process.exit(0), 1500);
