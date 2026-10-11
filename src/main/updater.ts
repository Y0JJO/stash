import { app, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/settings'

const CHECK_EVERY = 4 * 60 * 60 * 1000

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
    if (!app.isPackaged) return
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
      const n = new Notification({ title: `Stash ${i.version} готов к установке`, body: 'Нажмите, чтобы перезапустить и обновить. Иначе обновление установится при следующем запуске.' })
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
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ status: 'error', message: explain(err as Error) })
    }
    return this.state
  }

  install(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall()
  }
}
