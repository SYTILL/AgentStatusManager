// Direct Win32 calls via koffi (FFI): find VS Code windows and bring one to the front in a few ms.
// (Spawning PowerShell for this took 1–8 s depending on the machine's state.)
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hwnd)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');

const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, void *buf, _Inout_ uint32_t *size)');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_RESTORE = 9;
const VK_MENU = 0x12, KEYEVENTF_KEYUP = 0x2;

// pid -> is VS Code (Code.exe). Cached; pids are reused rarely enough for this purpose
const codePid = new Map();
function isCodeProcess(pid) {
  if (codePid.has(pid)) return codePid.get(pid);
  let ok = false;
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h) {
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (QueryFullProcessImageNameW(h, 0, buf, size)) {
      const exe = buf.toString('utf16le', 0, size[0] * 2);
      ok = /\\code(\s-\sinsiders)?\.exe$/i.test(exe);
    }
    CloseHandle(h);
  }
  if (codePid.size > 500) codePid.clear();
  codePid.set(pid, ok);
  return ok;
}

// [{ hwnd, title }] for every visible VS Code window
function codeWindows() {
  const out = [];
  const buf = Buffer.alloc(1024);
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!isCodeProcess(pid[0])) return true;
    const n = GetWindowTextW(hwnd, buf, 512);
    if (n > 0) out.push({ hwnd, title: buf.toString('utf16le', 0, n * 2) });
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return out;
}

// Folder names appearing in a VS Code title ("file - <folder> - Visual Studio Code"), lowercased
const titleParts = (t) => t.split(' - ').map((s) => s.replace(/^[\s●]+/, '').trim().toLowerCase());

function findCodeWindow(folderName) {
  const want = String(folderName).toLowerCase();
  return codeWindows().find((w) => titleParts(w.title).includes(want)) || null;
}

function bringToFront(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  // Windows only lets the foreground process hand over focus; a tapped Alt key lifts that restriction
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  BringWindowToTop(hwnd);
  return SetForegroundWindow(hwnd);
}

module.exports = { codeWindows, findCodeWindow, bringToFront, titleParts };
