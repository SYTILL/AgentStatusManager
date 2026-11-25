# Agent Status

A tiny always-on-top widget for Windows that shows the status of every running **Claude Code** session (VS Code extension or CLI) at a glance.

- One flat line per session: status color · project name · run timer
- Hover to expand: status, summary of what it's doing, active session time, token usage
- Per-session 🔔 toggle for desktop notifications when a session is **ready** or **needs attention**
- Light / dark mode, drag anywhere (snaps to the left or right screen edge), pin to keep expanded

| Color | Status | Meaning |
|---|---|---|
| 🟡 | Working | Claude is running (prompt submitted / using tools) |
| 🔴 | Needs attention | Waiting for a permission prompt or your answer |
| 🟢 | Ready | Finished; your turn |
| ⚪ | Idle | Not started yet, or no activity for a while |

## Install

### Option A — installer

```bash
npm install
npm run dist
```

Run `dist/AgentStatus-Setup-<version>.exe`. On first launch the app registers its Claude Code hooks automatically.

- Prefer the installer over the portable build: Windows toast notifications need a Start Menu shortcut with an AppUserModelId.
- The build is unsigned, so SmartScreen may warn on first run ("More info" → "Run anyway").

### Option B — run from source

```bash
npm install
npm run install-hooks    # registers hooks in ~/.claude/settings.json (writes a backup; other hooks are kept)
npm start
```

`npm run uninstall-hooks` removes only this app's hooks.

**Requirements:** Windows 10/11, Node.js on `PATH` (the hooks run `node`).

## Usage

- **Hover** the session list → expands. Hovering the top bar does not expand it.
- **Top bar:** drag to move · 🌙 dark mode · 📌 keep expanded
- **🔔** per session: notification on *ready* / *needs attention*. Clicking a notification opens the folder in VS Code.
- **Right-click** a row: open in VS Code · open folder · toggle notifications · remove from list
- **Tray icon:** color shows the overall status. Menu: show/hide, Claude Code hooks (install / reinstall / remove), reset position, launch at login, quit.

Timers:

- **Run timer** (always visible): time since the prompt was submitted; after it finishes, `✓ 4m 12s` shows how long the run took.
- **Session time** (expanded): total non-idle time. It does not start until the first prompt and pauses while idle.

Token count = input + cache write + output. Cache reads are excluded because they grow on every turn of a long conversation; the full breakdown is in the tooltip.

## How it works

```
[Claude Code sessions] --hook--> hooks/report.js --HTTP POST--> [widget on 127.0.0.1:7777]
```

Claude Code [hooks](https://docs.claude.com/en/docs/claude-code/hooks) run on every session event, so the agent never has to be told to report anything. Registering them once in `~/.claude/settings.json` covers every project.

| Hook event | Status | Summary |
|---|---|---|
| `UserPromptSubmit` | Working | First line of the prompt |
| `PreToolUse` | Working (`AskUserQuestion` / `ExitPlanMode` → Needs attention) | Tool in use, e.g. `Edit: App.tsx` |
| `PostToolUse` | Back to Working after an approval | |
| `Notification` | Needs attention (the "waiting for your input" idle reminder is ignored) | Notification message |
| `Stop` | Ready | First sentence of the final answer |
| `SessionEnd` | Removed | |

Tokens, the final answer and Esc interruptions are read incrementally from the session's transcript (`transcript_path`). Sessions that are *ready* for an hour become *idle*, sessions *working* with no activity for 20 minutes become *idle*, and idle sessions are dropped after a day.

The hook script always exits 0 within ~1.5 s, so Claude Code is never blocked, even when the widget isn't running.

## Project layout

```
hooks/report.js           Called by each hook: forwards the stdin JSON to the widget
scripts/install-hooks.js  Adds/removes hooks in ~/.claude/settings.json (dev)
scripts/make-icon.js      Generates build/icon.png
src/main/main.js          Electron main: window, click-through, drag/snap, tray, notifications
src/main/server.js        Local HTTP server (127.0.0.1 only)
src/main/store.js         Session state machine
src/main/transcript.js    Incremental JSONL transcript reader (tokens, last answer, interrupts)
src/main/hooks-config.js  Hook install/uninstall shared by the app and the script
src/preload.js            Renderer ↔ main bridge
src/renderer/             Widget UI
```

App data lives in `%APPDATA%/agent-status-manager/` (`settings.json`, `sessions.json`, and the hook script copied there by the installed app).

Set `AGENT_STATUS_PORT` to use a port other than 7777. The hooks read the same variable.

## License

MIT
