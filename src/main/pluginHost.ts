/**
 * Stash's own plugin system.
 *
 * An extension is a folder (installed from a .stashplugin zip) with a plugin.json and a CommonJS entry that
 * runs in the main process: `exports.activate = (host) => ({ deactivate() {} })`.
 * Extensions can register "providers" — adapters that install and run plugins made for other programs.
 * Stash itself knows nothing about those formats.
 */
import { app, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { Library } from './library'
import type { Importer } from './importer'
import { handleClip, type ClipperDeps } from './clipper'
import { kindOf, makeThumb, probe } from './media'

/** A plugin as shown in the plugin manager (supplied by a provider). */
export interface PluginInfo {
  id: string
  name: string
  version: string
  kind: 'window' | 'service' | 'module'
  logo: string | null
  running: boolean
  /** Switched off plugins stay installed but can't run and don't start with the app. */
  enabled: boolean
  description: string
  keywords: string[]
  /** Size on disk, bytes. */
  size: number
  installedAt: number
}

/** What Stash hands to extensions. */
export interface HostContext {
  lib(): Library | null
  importer(): Importer | null
  mainWindow(): BrowserWindow | null
  selection(): { ids: string[]; folderId: string | null }
  notifyChanged(): void
  enqueueThumbs(ids: string[]): void
  sendToRenderer(channel: string, ...args: unknown[]): void
  clipDeps: ClipperDeps
  /** Ids of provider plugins the user switched off (kept in the app config). */
  disabled(): string[]
  setDisabled(ids: string[]): void
  /** Core helpers, so extensions don't have to bundle their own copies. */
  services: { handleClip: typeof handleClip; kindOf: typeof kindOf; makeThumb: typeof makeThumb; probe: typeof probe }
}

/** An adapter for third-party plugins, registered by an extension. */
export interface PluginProvider {
  id: string
  label: string
  /** File extensions (without the dot) this provider installs. */
  extensions: string[]
  /** Where its plugins live. */
  dir: string
  list(): PluginInfo[]
  install(file: string): Promise<PluginInfo>
  uninstall(id: string): void
  run(id: string): void
  stop(id: string): void
  restart(id: string): void
  devtools(id: string): void
  reveal(id: string): void
  setEnabled(id: string, on: boolean): void
  startServices(): void
  stopAll(): void
  broadcast(event: string, ...args: unknown[]): void
}

export interface StashPluginHost {
  /** The extension's own folder. */
  dir: string
  context: HostContext
  registerProvider(provider: PluginProvider): void
}

interface ExtensionManifest {
  id: string
  name: string
  version?: string
  description?: string
  main?: string
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  active: boolean
  /** Why it failed to start, if it did. */
  error: string | null
  /** File types it lets Stash install (extensions without the dot). */
  formats: string[]
}

interface Active {
  deactivate?: () => void
  providers: PluginProvider[]
}

export interface ExtensionStore {
  disabled(): string[]
  setDisabled(ids: string[]): void
}

export const EXTENSION_EXT = 'stashplugin'

export class PluginHost {
  readonly dir = path.join(app.getPath('userData'), 'extensions')
  private active = new Map<string, Active>()
  private errors = new Map<string, string>()
  // Extensions resolve packages (electron, sharp, ffmpeg-static…) from the app, not from their own folder.
  private appRequire = createRequire(path.join(app.getAppPath(), 'package.json'))

  constructor(
    private ctx: Omit<HostContext, 'services'>,
    private store: ExtensionStore
  ) {
    fs.mkdirSync(this.dir, { recursive: true })
  }

  // ----- extensions -----

  private manifests(): { dir: string; manifest: ExtensionManifest }[] {
    const out: { dir: string; manifest: ExtensionManifest }[] = []
    for (const name of fs.readdirSync(this.dir)) {
      const dir = path.join(this.dir, name)
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8').replace(/^﻿/, '')) as ExtensionManifest
        if (manifest?.id) out.push({ dir, manifest })
      } catch {
        /* not an extension */
      }
    }
    return out
  }

  extensions(): ExtensionInfo[] {
    const disabled = new Set(this.store.disabled())
    return this.manifests()
      .map(({ manifest: m }) => ({
        id: m.id,
        name: m.name || m.id,
        version: m.version ?? '',
        description: m.description ?? '',
        enabled: !disabled.has(m.id),
        active: this.active.has(m.id),
        error: this.errors.get(m.id) ?? null,
        formats: (this.active.get(m.id)?.providers ?? []).flatMap((p) => p.extensions)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Starts every enabled extension. */
  loadAll(): void {
    const disabled = new Set(this.store.disabled())
    for (const { manifest } of this.manifests()) if (!disabled.has(manifest.id)) this.activate(manifest.id)
  }

  private activate(id: string): void {
    if (this.active.has(id)) return
    const found = this.manifests().find((x) => x.manifest.id === id)
    if (!found) return
    const entry = { providers: [] } as Active
    try {
      const file = path.join(found.dir, found.manifest.main ?? 'main.js')
      const mod = { exports: {} as { activate?: (host: StashPluginHost) => { deactivate?: () => void } | void } }
      // A minimal CommonJS loader, so `require` inside the extension is the app's.
      new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(file, 'utf8'))(this.appRequire, mod, mod.exports, found.dir, file)
      if (typeof mod.exports.activate !== 'function') throw new Error('В расширении нет функции activate')
      const host: StashPluginHost = {
        dir: found.dir,
        context: { ...this.ctx, services: { handleClip, kindOf, makeThumb, probe } },
        registerProvider: (p) => entry.providers.push(p)
      }
      entry.deactivate = mod.exports.activate(host)?.deactivate
      this.active.set(id, entry)
      this.errors.delete(id)
    } catch (err) {
      console.warn('[extension] failed to start', id, err)
      this.errors.set(id, (err as Error).message)
    }
    this.ctx.sendToRenderer('plugins:changed')
  }

  private deactivate(id: string): void {
    const a = this.active.get(id)
    if (!a) return
    this.active.delete(id)
    try {
      for (const p of a.providers) p.stopAll()
      a.deactivate?.()
    } catch (err) {
      console.warn('[extension] failed to stop', id, err)
    }
    this.ctx.sendToRenderer('plugins:changed')
  }

  setExtensionEnabled(id: string, on: boolean): void {
    const rest = this.store.disabled().filter((x) => x !== id)
    this.store.setDisabled(on ? rest : [...rest, id])
    if (on) this.activate(id)
    else this.deactivate(id)
  }

  /** Installs (or updates) an extension from a .stashplugin file and starts it. */
  async installExtension(file: string): Promise<ExtensionInfo> {
    const files = unzipSync(new Uint8Array(await fs.promises.readFile(file)))
    const entry = Object.keys(files).find((k) => /(^|\/)plugin\.json$/.test(k) && k.split('/').length <= 2)
    if (!entry) throw new Error('В архиве нет plugin.json — это не расширение Stash')
    const prefix = entry.slice(0, -'plugin.json'.length)
    const manifest = JSON.parse(new TextDecoder().decode(files[entry]).replace(/^﻿/, '')) as ExtensionManifest
    if (!manifest.id) throw new Error('В plugin.json нет id')

    const target = path.join(this.dir, manifest.id.replace(/[^\w.-]/g, '_'))
    this.deactivate(manifest.id)
    await fs.promises.rm(target, { recursive: true, force: true })
    for (const [name, data] of Object.entries(files)) {
      if (!name.startsWith(prefix) || name.endsWith('/')) continue
      const dest = path.join(target, name.slice(prefix.length))
      if (!dest.startsWith(target + path.sep)) continue // zip-slip guard
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.writeFile(dest, data)
    }
    if (!this.store.disabled().includes(manifest.id)) {
      this.activate(manifest.id)
      if (this.ctx.lib()) for (const p of this.active.get(manifest.id)?.providers ?? []) p.startServices()
    }
    return this.extensions().find((x) => x.id === manifest.id)!
  }

  uninstallExtension(id: string): void {
    const found = this.manifests().find((x) => x.manifest.id === id)
    if (!found) return
    this.deactivate(id)
    fs.rmSync(found.dir, { recursive: true, force: true })
    this.errors.delete(id)
    this.store.setDisabled(this.store.disabled().filter((x) => x !== id))
    this.ctx.sendToRenderer('plugins:changed')
  }

  revealExtensions(): void {
    void shell.openPath(this.dir)
  }

  // ----- provider plugins (everything below just routes to the adapters) -----

  private providers(): PluginProvider[] {
    return [...this.active.values()].flatMap((a) => a.providers)
  }

  private owner(id: string): PluginProvider | undefined {
    return this.providers().find((p) => p.list().some((x) => x.id === id))
  }

  /** File extensions Stash can currently install: its own plus whatever the adapters add. */
  formats(): string[] {
    return [EXTENSION_EXT, ...this.providers().flatMap((p) => p.extensions)]
  }

  list(): PluginInfo[] {
    return this.providers().flatMap((p) => p.list())
  }

  /** Installs an extension or, through a matching adapter, a third-party plugin. Returns its name. */
  async install(file: string): Promise<string> {
    const ext = path.extname(file).slice(1).toLowerCase()
    if (ext === EXTENSION_EXT) return (await this.installExtension(file)).name
    const provider = this.providers().find((p) => p.extensions.includes(ext))
    if (!provider) throw new Error(`Нет расширения, которое умеет читать файлы .${ext}. Установите подходящий адаптер (.${EXTENSION_EXT}).`)
    return (await provider.install(file)).name
  }

  uninstall = (id: string): void => this.owner(id)?.uninstall(id)
  run = (id: string): void => this.owner(id)?.run(id)
  stop = (id: string): void => this.owner(id)?.stop(id)
  restart = (id: string): void => this.owner(id)?.restart(id)
  devtools = (id: string): void => this.owner(id)?.devtools(id)
  reveal = (id: string): void => this.owner(id)?.reveal(id)
  setEnabled = (id: string, on: boolean): void => this.owner(id)?.setEnabled(id, on)

  /** Opens the folder with third-party plugins, or the extensions folder when no adapter is installed. */
  revealPlugins(): void {
    void shell.openPath(this.providers()[0]?.dir ?? this.dir)
  }

  startServices(): void {
    for (const p of this.providers()) p.startServices()
  }

  stopAll(): void {
    for (const p of this.providers()) p.stopAll()
  }

  broadcast(event: string, ...args: unknown[]): void {
    for (const p of this.providers()) p.broadcast(event, ...args)
  }
}
