// Adds/removes the Agent Status hooks in ~/.claude/settings.json.
// Existing settings and other hooks are kept; a backup is written before any change.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = [
  ['SessionStart'], ['UserPromptSubmit'], ['PreToolUse', '*'], ['PostToolUse', '*'],
  ['Notification'], ['Stop'], ['SessionEnd'],
];
// Matches both the dev path (AgentStatusManager/hooks/report.js) and the installed app path (agent-status-manager/hooks/report.js)
const OURS = /(agentstatusmanager|agent-status-manager|agent status)[^"]*\/hooks\/report\.js/i;
const isOurs = (h) => typeof h.command === 'string' && OURS.test(h.command.replace(/\\/g, '/'));

function read() {
  if (!fs.existsSync(SETTINGS)) return { settings: {}, raw: null };
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  return { settings: JSON.parse(raw), raw };
}

// Script paths currently registered by us
function installedScripts() {
  try {
    const { settings } = read();
    const out = new Set();
    for (const groups of Object.values(settings.hooks || {})) {
      for (const g of groups || []) for (const h of g.hooks || []) {
        if (isOurs(h)) { const m = h.command.match(/"([^"]+report\.js)"/); if (m) out.add(m[1]); }
      }
    }
    return [...out];
  } catch { return []; }
}

function write(scriptPath) {
  const { settings, raw } = read();
  let backup = null;
  if (raw != null) {
    backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);
  } else {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  }

  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (scriptPath) {
    const p = scriptPath.replace(/\\/g, '/');
    for (const [ev, matcher] of EVENTS) {
      const group = { hooks: [{ type: 'command', command: `node "${p}" ${ev}`, timeout: 5 }] };
      if (matcher) group.matcher = matcher;
      (hooks[ev] = hooks[ev] || []).push(group);
    }
  }
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return { file: SETTINGS, backup };
}

module.exports = {
  SETTINGS,
  installedScripts,
  install: (scriptPath) => write(scriptPath),
  uninstall: () => write(null),
};
