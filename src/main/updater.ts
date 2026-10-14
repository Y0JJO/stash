import { app, net, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/settings'

const CHECK_EVERY = 4 * 60 * 60 * 1000
/** Unsigned macOS builds can't replace themselves, so there Stash only tells the user a new version is out. */
const MANUAL = process.platform === 'darwin'
const RELEASES_API = 'https://api.github.com/repos/Y0JJO/stash/releases/latest'
const RELEASES_PAGE = 'https://github.com/Y0JJO/stash/releases/latest'

/** 1 if a > b, -1 if a < b ("0.10.0" vs "0.9.3"). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** A build made without a releases feed has no app-update.yml. */
const explain = (err: Error) => (/app-update\.yml/.test(err.message) ? 'источник обновлений не настроен в этой сборке' : err.message.split('\n')[0])

/**
 * Auto-update from the releases feed baked into the installer (electron-builder's "publish" setting).
 * New versions download in the background and install on the next restart.
 */
export class Updater {
  private state: UpdateState = { status: app.isPackaged ? 'idle' : 'unsupported', current: app.getVersion() }
  private timer: NodeJS.Timeout | null = null
  private notified = false

  constructor(private onState: (s: UpdateState) => void) {
    if (!app.isPackaged || MANUAL) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', (i) => this.set({ status: 'downloading', version: i.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }))
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => {
      this.set({ status: 'ready', version: i.version })
      if (this.notified) return
      this.notified = true
      const n = new Notification({ title: `D3S3RT ${i.version} готов к установке`, body: 'Нажмите, чтобы перезапустить и обновить. Иначе обновление установится при следующем запуске.' })
      n.on('click', () => this.install())
      n.show()
    })
    autoUpdater.on('error', (err) => this.set({ status: 'error', message: explain(err) }))
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, message: undefined, ...patch }
    this.onState(this.state)
  }

  get(): UpdateState {
    return this.state
  }

  /** Turns the periodic background check on or off (the "check automatically" preference). */
  setAuto(on: boolean): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!on || !app.isPackaged) return
    setTimeout(() => void this.check(), 15_000)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY)
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged || this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    if (MANUAL) return this.checkManual()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ status: 'error', message: explain(err as Error) })
    }
    return this.state
  }

  /** macOS: look at the latest GitHub release and point the user at the download page. */
  private async checkManual(): Promise<UpdateState> {
    this.set({ status: 'checking' })
    try {
      const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok) throw new Error(`GitHub ответил ${res.status}`)
      const latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
      if (!latest || compareVersions(latest, app.getVersion()) <= 0) this.set({ status: 'none' })
      else {
        this.set({ status: 'available', version: latest, url: RELEASES_PAGE })
        if (!this.notified) {
          this.notified = true
          const n = new Notification({ title: `Вышел D3S3RT ${latest}`, body: 'Нажмите, чтобы открыть страницу загрузки.' })
          n.on('click', () => void shell.openExternal(RELEASES_PAGE))
          n.show()
        }
      }
    } catch (err) {
      this.set({ status: 'error', message: explain(err as Error) })
    }
    return this.state
  }

  install(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall()
  }
}
