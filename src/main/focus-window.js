// VS Code window helpers (Windows):
// - focusVSCodeWindow: find the window for a folder and bring it to the front.
//   Windows blocks background processes from taking focus (SetForegroundWindow) and only flashes the
//   taskbar, so the usual workaround is used: tap Alt, then SetForegroundWindow.
// - listVSCodeTitles: titles of every open VS Code window (used to reconcile the session list).
// VS Code's default title is "file - <folder> - Visual Studio Code", so match on the " - " segments.
const { spawn } = require('child_process');

const COMMON = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class AsmWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$pids = @(Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
# Calls $onWindow (handle, title) for each visible VS Code window; stops when it returns $false
function Each-CodeWindow($onWindow) {
  $cb = [AsmWin+EnumProc]{
    param($h, $l)
    if (-not [AsmWin]::IsWindowVisible($h)) { return $true }
    $p = [uint32]0
    [void][AsmWin]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -notcontains $p) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][AsmWin]::GetWindowText($h, $sb, 512)
    if ($sb.Length -eq 0) { return $true }
    return (& $onWindow $h $sb.ToString())
  }
  [void][AsmWin]::EnumWindows($cb, [IntPtr]::Zero)
}
function Title-Parts($t) { $t -split ' - ' | ForEach-Object { $_.Trim().TrimStart([char]0x25CF).Trim() } }
`;

const FOCUS = String.raw`
$script:target = [IntPtr]::Zero
Each-CodeWindow { param($h, $t) if ((Title-Parts $t) -contains $name) { $script:target = $h; return $false }; return $true }
if ($script:target -eq [IntPtr]::Zero) { exit 3 }
if ($dry) { exit 0 }
if ([AsmWin]::IsIconic($script:target)) { [void][AsmWin]::ShowWindow($script:target, 9) }
[AsmWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[AsmWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][AsmWin]::SetForegroundWindow($script:target)
exit 0
`;

const LIST = String.raw`
$script:titles = New-Object System.Collections.ArrayList
Each-CodeWindow { param($h, $t) [void]$script:titles.Add($t); return $true }
$script:titles | ForEach-Object { [Console]::Out.WriteLine($_) }
exit 0
`;

function runPS(script, timeoutMs = 8000) {
  const encoded = Buffer.from(COMMON + script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let p, out = '';
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve({ code: -1, out }); return; }
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve({ code: -1, out }); }, timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Fast path: direct Win32 calls via koffi (a few ms). The PowerShell scripts above are only a fallback
// if the native module can't be loaded (spawning PowerShell can take several seconds).
let native = null;
try { native = require('./win32'); } catch (e) { console.error('win32 native unavailable, using PowerShell', e && e.message); }

// Resolves to: 'focused' | 'not-found' | 'error' (with dry, 'found' instead of 'focused')
async function focusVSCodeWindow(folderName, { dry = false } = {}) {
  if (native) {
    try {
      const w = native.findCodeWindow(folderName);
      if (!w) return 'not-found';
      if (dry) return 'found';
      native.bringToFront(w.hwnd);
      return 'focused';
    } catch { /* fall through to PowerShell */ }
  }
  const { code } = await runPS(`$name = ${psStr(folderName)}\n$dry = $${dry ? 'true' : 'false'}\n${FOCUS}`);
  return code === 0 ? (dry ? 'found' : 'focused') : code === 3 ? 'not-found' : 'error';
}

// Resolves to the open VS Code window titles, or null if they couldn't be read
async function listVSCodeTitles() {
  if (native) {
    try { return native.codeWindows().map((w) => w.title); } catch { /* fall through */ }
  }
  const { code, out } = await runPS(LIST);
  if (code !== 0) return null;
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Folder names appearing in a title (the " - " segments)
const titleParts = (t) => t.split(' - ').map((s) => s.replace(/^[\s●]+/, '').trim().toLowerCase());

module.exports = { focusVSCodeWindow, listVSCodeTitles, titleParts };
