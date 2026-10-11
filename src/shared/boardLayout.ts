import type { BoardNode } from './types'

export const BOARD_COL_W = 320
export const BOARD_GAP = 16

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** Height of an item node of width `w`, keeping the item's aspect ratio. */
export function itemHeight(item: { width: number | null; height: number | null }, w: number): number {
  return item.width && item.height ? Math.round((w * item.height) / item.width) : w
}

/** Lays items out as a masonry block whose top-left corner is `origin`. */
export function masonry(
  items: { id: string; width: number | null; height: number | null }[],
  origin: { x: number; y: number },
  startZ: number,
  colW = BOARD_COL_W
): BoardNode[] {
  const cols = Math.max(1, Math.min(6, Math.round(Math.sqrt(items.length * 1.3))))
  const heights = new Array(cols).fill(0)
  return items.map((it, i) => {
    let c = 0
    for (let j = 1; j < cols; j++) if (heights[j] < heights[c]) c = j
    const h = itemHeight(it, colW)
    const node: BoardNode = { id: uid(), type: 'item', itemId: it.id, x: origin.x + c * (colW + BOARD_GAP), y: origin.y + heights[c], w: colW, h, z: startZ + i }
    heights[c] += h + BOARD_GAP
    return node
  })
}

export function newNodeId(): string {
  return uid()
}

export function boundsOf(nodes: BoardNode[]): { x: number; y: number; w: number; h: number } | null {
  if (!nodes.length) return null
  const x = Math.min(...nodes.map((n) => n.x))
  const y = Math.min(...nodes.map((n) => n.y))
  const r = Math.max(...nodes.map((n) => n.x + n.w))
  const b = Math.max(...nodes.map((n) => n.y + n.h))
  return { x, y, w: r - x, h: b - y }
}

/** Greedy word wrap with an approximate glyph width — good enough for notes on a board. */
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const maxChars = Math.max(4, Math.floor(width / (fontSize * 0.56)))
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if ((line ? line.length + 1 : 0) + word.length > maxChars && line) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines
}
