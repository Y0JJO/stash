import type { Folder, ItemLite } from '../../shared/types'

/** Image formats Chromium can display directly (used when a thumbnail could not be rendered). */
export const BROWSER_IMAGE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'])
export const BROWSER_VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv'])

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function fmtDuration(sec: number | null): string {
  if (sec == null) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export const itemsLabel = (n: number) => `${n} ${plural(n, 'элемент', 'элемента', 'элементов')}`

export function dims(it: ItemLite): string {
  return it.width && it.height ? `${it.width}×${it.height}` : ''
}

/** "Parent / Child" display path for every folder. */
export function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out = new Map<string, string>()
  const resolve = (f: Folder, depth = 0): string => {
    const parent = f.parentId ? byId.get(f.parentId) : undefined
    return parent && depth < 32 ? `${resolve(parent, depth + 1)} / ${f.name}` : f.name
  }
  folders.forEach((f) => out.set(f.id, resolve(f)))
  return out
}

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`stash.${key}`)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`stash.${key}`, JSON.stringify(value))
  } catch {
    /* storage unavailable — prefs just won't persist */
  }
}

/** Lower-case letter of the physical key (KeyC → "c") so shortcuts work in any keyboard layout; other keys as typed. */
export const keyOf = (e: { code: string; key: string }): string => (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase())
