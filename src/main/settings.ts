import { app, globalShortcut, Notification, type BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings, type SettingsResult } from '../shared/settings'
import type { Config } from './config'

export interface SettingsDeps {
  config: Config
  save(): void
  win(): BrowserWindow | null
  send(channel: string, ...args: unknown[]): void
  /** Take an area screenshot into the library. */
  screenshot(): void
  /** Import files found by auto-import. */
  importPaths(paths: string[], folderId: string | null): void
}

const SEEN_LIMIT = 5000
const TITLEBAR: Record<string, string> = { dark: '#1a1b1f', black: '#0a0a0b', gray: '#323338', blue: '#151c2e', purple: '#1e172b' }

/** Owns preferences: persistence plus every side effect outside the renderer. */
export class SettingsManager {
  private watcher: fs.FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private registered: string[] = []

  constructor(private deps: SettingsDeps) {}

  get(): Settings {
    return { ...DEFAULT_SETTINGS, ...(this.deps.config.settings ?? {}) }
  }

  set(patch: Partial<Settings>): SettingsResult {
    const before = this.get()
    const next = { ...before, ...patch }
    this.deps.config.settings = next
    // Turning auto-import on (or pointing it elsewhere) starts from "now": existing files stay put.
    if (next.autoImportEnabled && (!before.autoImportEnabled || next.autoImportDir !== before.autoImportDir)) this.markExistingSeen(next.autoImportDir)
    this.deps.save()
    const warnings = this.apply(next, before)
    this.deps.send('settings:changed', next)
    return { settings: next, warnings }
  }

  /** Applies everything once at startup. */
  start(): string[] {
    return this.apply(this.get(), null)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const acc of this.registered) globalShortcut.unregister(acc)
    this.registered = []
  }

  applyZoom(): void {
    const w = this.deps.win()
    if (w && !w.isDestroyed()) w.webContents.setZoomFactor(Math.min(1.5, Math.max(0.8, this.get().zoom)))
  }

  private apply(s: Settings, before: Settings | null): string[] {
    const warnings: string[] = []
    this.applyZoom()
    // Keep the native window buttons in step with the theme's panel colour.
    const w = this.deps.win()
    if (w && !w.isDestroyed() && process.platform !== 'darwin') w.setTitleBarOverlay({ color: TITLEBAR[s.theme] ?? TITLEBAR.dark, symbolColor: '#b9bcc4', height: 44 })

    // Only touch the Windows login item when the user actually flips the switch.
    if (before && before.launchAtLogin !== s.launchAtLogin) {
      // In development Electron is launched as "electron.exe <app dir>".
      app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, path: process.execPath, args: process.defaultApp ? [path.resolve(app.getAppPath())] : [] })
    }

    // Global shortcuts
    for (const acc of this.registered) globalShortcut.unregister(acc)
    this.registered = []
    const reg = (acc: string, fn: () => void, label: string) => {
      if (!acc) return
      try {
        if (globalShortcut.register(acc, fn)) this.registered.push(acc)
        else warnings.push(`Сочетание ${acc} (${label}) занято другой программой`)
      } catch {
        warnings.push(`Сочетание ${acc} (${label}) не распознано`)
      }
    }
    if (s.shotShortcutEnabled) reg(s.shotShortcut, () => this.deps.screenshot(), 'скриншот области')
    reg(s.showShortcut, () => {
      const w = this.deps.win()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }, 'показать D3S3RT')

    // Auto-import
    this.watcher?.close()
    this.watcher = null
    if (s.autoImportEnabled && s.autoImportDir) {
      if (!fs.existsSync(s.autoImportDir)) warnings.push('Папка авто-импорта не найдена')
      else {
        try {
          this.watcher = fs.watch(s.autoImportDir, () => this.scanSoon())
          this.scanSoon()
        } catch {
          warnings.push('Не удалось начать слежение за папкой авто-импорта')
        }
      }
    }
    return warnings
  }

  // ----- auto-import -----

  private key(name: string, st: fs.Stats): string {
    return `${name}|${st.size}|${Math.round(st.mtimeMs)}`
  }

  private markExistingSeen(dir: string): void {
    if (!dir || !fs.existsSync(dir)) return
    const seen = new Set(this.deps.config.autoImportSeen ?? [])
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name))
        if (st.isFile()) seen.add(this.key(name, st))
      } catch {
        /* vanished */
      }
    }
    this.deps.config.autoImportSeen = [...seen].slice(-SEEN_LIMIT)
  }

  private scanSoon(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => this.scan(), 1500)
  }

  /** Imports files that appeared in the watched folder (also catches ones added while Stash was closed). */
  private scan(): void {
    const s = this.get()
    if (!s.autoImportEnabled || !s.autoImportDir || !fs.existsSync(s.autoImportDir)) return
    const seen = new Set(this.deps.config.autoImportSeen ?? [])
    const fresh: string[] = []
    let pending = false
    for (const name of fs.readdirSync(s.autoImportDir)) {
      if (name.startsWith('.') || /\.(tmp|crdownload|part|download)$/i.test(name)) continue
      const file = path.join(s.autoImportDir, name)
      try {
        const st = fs.statSync(file)
        if (!st.isFile() || !st.size) continue
        // Still being written (browser download, copy in progress): look again shortly.
        if (Date.now() - st.mtimeMs < 1500) {
          pending = true
          continue
        }
        const k = this.key(name, st)
        if (seen.has(k)) continue
        seen.add(k)
        fresh.push(file)
      } catch {
        /* vanished */
      }
    }
    if (pending) this.scanSoon()
    if (!fresh.length) return
    this.deps.config.autoImportSeen = [...seen].slice(-SEEN_LIMIT)
    this.deps.save()
    this.deps.importPaths(fresh, s.autoImportFolderId)
    if (s.notifyAutoImport) new Notification({ title: 'Авто-импорт', body: `Добавлено файлов: ${fresh.length}` }).show()
  }

  // ----- app lock -----

  hasLock(): boolean {
    return !!this.deps.config.lockHash
  }

  checkLock(password: string): boolean {
    const stored = this.deps.config.lockHash
    if (!stored) return true
    const [salt, hash] = stored.split(':')
    return createHash('sha256').update(salt + password).digest('hex') === hash
  }

  /** Sets, changes or removes (password = null) the lock. Needs the current password if one is set. */
  setLock(password: string | null, current: string): boolean {
    if (!this.checkLock(current)) return false
    if (!password) delete this.deps.config.lockHash
    else {
      const salt = randomUUID()
      this.deps.config.lockHash = `${salt}:${createHash('sha256').update(salt + password).digest('hex')}`
    }
    this.deps.save()
    return true
  }
}
