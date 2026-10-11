import { useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { api } from './api'

/** Renderer-side mirror of the preferences kept by the main process. */
let current: Settings = DEFAULT_SETTINGS
const listeners = new Set<() => void>()

function publish(next: Settings): void {
  current = next
  // Theme and counters are plain CSS switches on the root element.
  document.documentElement.dataset.theme = next.theme
  document.documentElement.classList.toggle('no-counts', !next.sidebarCounts)
  listeners.forEach((l) => l())
}

export async function initSettings(): Promise<void> {
  publish(await api.getSettings())
  api.onSettings(publish)
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current
  )
}

export const getSettings = () => current

/** Saves a change; resolves with warnings (e.g. a global shortcut that is already taken). */
export async function updateSettings(patch: Partial<Settings>): Promise<string[]> {
  publish({ ...current, ...patch })
  const r = await api.setSettings(patch)
  return r.warnings
}
