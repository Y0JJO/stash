import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * A long-lived PowerShell helper (Windows only) that answers "which window is in front" and
 * presses Ctrl+key — fast enough to sit behind a global hotkey, unlike spawning
 * PowerShell for every call (~0.3–1 s).
 */
const SCRIPT = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class StashWin {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Title() { var b = new StringBuilder(1024); GetWindowText(GetForegroundWindow(), b, 1024); return b.ToString(); }
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Ctrl + a key by virtual-key code: unlike SendKeys, independent of the keyboard layout.
  public static void Ctrl(byte vk) { keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero); }
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    if ($line -eq 'title') { [Console]::Out.WriteLine(([StashWin]::Title() -replace '[\\r\\n]', ' ')) }
    elseif ($line.StartsWith('ctrl ')) {
      [StashWin]::Ctrl([byte][char]$line.Substring(5, 1).ToUpper())
      Start-Sleep -Milliseconds 30
      [Console]::Out.WriteLine('ok')
    } else { [Console]::Out.WriteLine('') }
  } catch { [Console]::Out.WriteLine('') }
  [Console]::Out.Flush()
}`

let proc: ChildProcessWithoutNullStreams | null = null
let buf = ''
const waiting: ((line: string) => void)[] = []

function ensure(): ChildProcessWithoutNullStreams {
  if (proc && proc.exitCode === null) return proc
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true })
  buf = ''
  waiting.length = 0
  // The first line is 'ready'; it answers a dummy waiter so calls queued meanwhile line up.
  waiting.push(() => {})
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      waiting.shift()?.(line)
    }
  })
  p.on('exit', () => {
    for (const w of waiting.splice(0)) w('')
    if (proc === p) proc = null
  })
  p.on('error', () => p.emit('exit'))
  return (proc = p)
}

function ask(line: string): Promise<string> {
  const p = ensure()
  return new Promise((resolve) => {
    // Never hang a hotkey on a stuck helper: give up after 1.5 s (the late answer is dropped).
    let done = false
    const finish = (v: string) => {
      if (!done) (done = true), resolve(v)
    }
    waiting.push(finish)
    setTimeout(() => finish(''), 1500)
    p.stdin.write(`${line}\n`)
  })
}

/** Starts the helper ahead of time (compiling its bit of C# takes about a second). */
export const warmUpKeys = () => void ensure()
/** Title of the window in front. */
export const foregroundTitle = () => ask('title')
/** Presses Ctrl + a letter key ("v", "x") in the window in front, whatever the keyboard layout. */
export const pressCtrl = async (letter: string) => void (await ask(`ctrl ${letter}`))
export function stopKeys(): void {
  proc?.kill()
  proc = null
}
