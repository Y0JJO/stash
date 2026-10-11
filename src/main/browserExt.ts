import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The browser extension ships with Stash. Browsers only load an unpacked extension from a folder the user
 * points them at, so Stash keeps a copy in a stable place and walks the user through the three clicks.
 */

interface Browser {
  id: string
  name: string
  /** The browser's own "extensions" page. */
  page: string
  /** Windows: candidate paths of the executable. */
  win: string[]
  /** macOS: application name. */
  mac: string
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback
const PF = env('ProgramFiles', 'C:/Program Files')
const PF86 = env('ProgramFiles(x86)', 'C:/Program Files (x86)')
const LOCAL = env('LOCALAPPDATA', path.join(app.getPath('home'), 'AppData', 'Local'))

const BROWSERS: Browser[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    page: 'chrome://extensions',
    win: [`${PF}/Google/Chrome/Application/chrome.exe`, `${PF86}/Google/Chrome/Application/chrome.exe`, `${LOCAL}/Google/Chrome/Application/chrome.exe`],
    mac: 'Google Chrome'
  },
  { id: 'edge', name: 'Edge', page: 'edge://extensions', win: [`${PF86}/Microsoft/Edge/Application/msedge.exe`, `${PF}/Microsoft/Edge/Application/msedge.exe`], mac: 'Microsoft Edge' },
  {
    id: 'yandex',
    name: 'Яндекс Браузер',
    page: 'browser://extensions',
    win: [`${LOCAL}/Yandex/YandexBrowser/Application/browser.exe`, `${PF}/Yandex/YandexBrowser/Application/browser.exe`],
    mac: 'Yandex'
  },
  {
    id: 'brave',
    name: 'Brave',
    page: 'brave://extensions',
    win: [`${PF}/BraveSoftware/Brave-Browser/Application/brave.exe`, `${LOCAL}/BraveSoftware/Brave-Browser/Application/brave.exe`],
    mac: 'Brave Browser'
  },
  { id: 'opera', name: 'Opera', page: 'opera://extensions', win: [`${LOCAL}/Programs/Opera/opera.exe`, `${PF}/Opera/opera.exe`], mac: 'Opera' },
  { id: 'operagx', name: 'Opera GX', page: 'opera://extensions', win: [`${LOCAL}/Programs/Opera GX/opera.exe`], mac: 'Opera GX' },
  { id: 'vivaldi', name: 'Vivaldi', page: 'vivaldi://extensions', win: [`${LOCAL}/Vivaldi/Application/vivaldi.exe`, `${PF}/Vivaldi/Application/vivaldi.exe`], mac: 'Vivaldi' }
]

const MAC = process.platform === 'darwin'

function locate(b: Browser): string | null {
  if (MAC) {
    const p = `/Applications/${b.mac}.app`
    return fs.existsSync(p) ? p : null
  }
  return b.win.find((p) => fs.existsSync(p)) ?? null
}

/** Where the extension files come from: next to the app when installed, the project folder in development. */
const source = () => (app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension'))

/** The folder the user loads in the browser. Stable across Stash updates, so the browser keeps finding it. */
export const extensionDir = () => path.join(app.getPath('userData'), 'browser-extension')

function versionIn(dir: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** Refreshes the user's copy of the extension from the one shipped with this version of Stash. */
export function syncExtension(): void {
  const from = source()
  if (!fs.existsSync(path.join(from, 'manifest.json'))) return
  try {
    fs.mkdirSync(extensionDir(), { recursive: true })
    fs.cpSync(from, extensionDir(), { recursive: true, force: true })
  } catch (err) {
    console.warn('[browser-ext] copy failed', err)
  }
}

export interface BrowserExtInfo {
  dir: string
  version: string | null
  browsers: { id: string; name: string; page: string }[]
}

export function browserExtInfo(): BrowserExtInfo {
  if (!versionIn(extensionDir())) syncExtension()
  return {
    dir: extensionDir(),
    version: versionIn(extensionDir()),
    browsers: BROWSERS.filter((b) => locate(b)).map(({ id, name, page }) => ({ id, name, page }))
  }
}

/** Opens the browser on its extensions page (a chrome:// address can't be opened through the system). */
export function openExtensionsPage(id: string): boolean {
  const b = BROWSERS.find((x) => x.id === id)
  const exe = b && locate(b)
  if (!b || !exe) return false
  const child = MAC ? spawn('open', ['-a', b.mac, b.page], { detached: true, stdio: 'ignore' }) : spawn(exe, [b.page], { detached: true, stdio: 'ignore' })
  child.on('error', (err) => console.warn('[browser-ext] launch failed', err))
  child.unref()
  return true
}
