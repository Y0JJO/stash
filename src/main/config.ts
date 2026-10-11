import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { TelegramConfig } from './telegram'
import type { Settings } from '../shared/settings'

export interface Config {
  lastLibrary: string | null
  recent: string[]
  autoTag: boolean
  /** Remembered location of PureRef.exe (it is often a portable install). */
  purerefPath?: string
  telegram?: TelegramConfig
  /** User preferences (see shared/settings.ts); missing keys fall back to defaults. */
  settings?: Partial<Settings>
  /** Files auto-import has already handled ("name|size|mtime"). */
  autoImportSeen?: string[]
  /** Extensions (.stashplugin) switched off in the plugin manager. */
  disabledExtensions?: string[]
  /** Plugins switched off in the plugin manager. */
  disabledPlugins?: string[]
  /** Salted hash of the app-lock password. */
  lockHash?: string
  bounds?: { x: number; y: number; width: number; height: number; maximized: boolean }
}

const file = () => path.join(app.getPath('userData'), 'config.json')

export function loadConfig(): Config {
  const defaults: Config = { lastLibrary: null, recent: [], autoTag: true }
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {
    return defaults
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(config, null, 2))
}
