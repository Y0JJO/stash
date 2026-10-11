import type { MenuEntry } from '../../shared/types'

/** A context menu waiting to be shown by <ContextMenuHost>. */
export interface MenuRequest {
  entries: MenuEntry[]
  x: number
  y: number
  search: boolean
  resolve(id: string | null): void
}

let listener: ((r: MenuRequest | null) => void) | null = null
let current: MenuRequest | null = null
let pointer = { x: 120, y: 120 }

// Menus open where the user last clicked / right-clicked.
const remember = (e: MouseEvent) => (pointer = { x: e.clientX, y: e.clientY })
window.addEventListener('mousedown', remember, true)
window.addEventListener('contextmenu', remember, true)

const leafCount = (list: MenuEntry[]): number =>
  list.reduce((n, e) => n + (e.submenu ? leafCount(e.submenu) : e.type ? 0 : 1), 0)

/** Shows the in-app context menu and resolves with the chosen id (null when dismissed). */
export function openMenu(entries: MenuEntry[], opts: { search?: boolean; x?: number; y?: number } = {}): Promise<string | null> {
  current?.resolve(null)
  return new Promise((resolve) => {
    const req: MenuRequest = {
      entries,
      x: opts.x ?? pointer.x,
      y: opts.y ?? pointer.y,
      search: opts.search ?? leafCount(entries) >= 10,
      resolve: (id) => {
        if (current === req) {
          current = null
          listener?.(null)
        }
        resolve(id)
      }
    }
    current = req
    listener?.(req)
  })
}

export function subscribeMenu(fn: (r: MenuRequest | null) => void): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}
