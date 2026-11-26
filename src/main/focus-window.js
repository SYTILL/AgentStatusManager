// Finds the VS Code window for a folder and brings it to the front.
// Windows blocks background processes from taking focus (SetForegroundWindow) and only flashes the
// taskbar, so the usual workaround is used: tap Alt, then SetForegroundWindow.
// VS Code's default title is "file - <folder> - Visual Studio Code", so match on the " - " segments.
const { spawn } = require('child_process');

const PS = String.raw`
$ErrorActionPreference = 'Stop'
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
$script:target = [IntPtr]::Zero
$cb = [AsmWin+EnumProc]{
  param($h, $l)
  if (-not [AsmWin]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][AsmWin]::GetWindowText($h, $sb, 512)
  $p = [uint32]0
  [void][AsmWin]::GetWindowThreadProcessId($h, [ref]$p)
  if ($pids -contains $p) {
    $parts = $sb.ToString() -split ' - ' | ForEach-Object { $_.Trim().TrimStart([char]0x25CF).Trim() }
    if ($parts -contains $name) { $script:target = $h; return $false }
  }
  return $true
}
[void][AsmWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:target -eq [IntPtr]::Zero) { exit 3 }
if ($dry) { exit 0 }
if ([AsmWin]::IsIconic($script:target)) { [void][AsmWin]::ShowWindow($script:target, 9) }
[AsmWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[AsmWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][AsmWin]::SetForegroundWindow($script:target)
exit 0
`;

// Resolves to: 'focused' | 'not-found' | 'error' (with dry, 'found' instead of 'focused')
function focusVSCodeWindow(folderName, { dry = false } = {}) {
  const head = `$name = '${String(folderName).replace(/'/g, "''")}'\n$dry = $${dry ? 'true' : 'false'}\n`;
  const encoded = Buffer.from(head + PS, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    } catch { resolve('error'); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve('error'); }, 8000);
    p.on('error', () => { clearTimeout(t); resolve('error'); });
    p.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? (dry ? 'found' : 'focused') : code === 3 ? 'not-found' : 'error');
    });
  });
}

module.exports = { focusVSCodeWindow };
