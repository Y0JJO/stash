import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import sharp, { type OverlayOptions, type Sharp } from 'sharp'
import type { Board, BoardNode } from '../shared/types'
import { nodeInnerSvg, nodeSvg, textHeight } from '../shared/boardSvg'
import type { Library } from './library'

const PAD = 48
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Best readable source for an item node: the original for images sharp can decode, else the thumbnail. */
function sourceFor(lib: Library, itemId: string): string | null {
  const it = lib.getItem(itemId)
  if (!it) return null
  const thumb = lib.thumbPath(itemId)
  const thumbOk = !!thumb && fs.existsSync(thumb)
  if (it.kind === 'image' && !['ico', 'bmp'].includes(it.ext)) return it.path
  return thumbOk ? thumb! : null
}

/** Visible nodes in paint order, with text heights fixed up from their content. */
function prepared(board: Board): BoardNode[] {
  return board.data.nodes
    .filter((n) => !n.hidden)
    .sort((a, b) => a.z - b.z)
    .map((n) => (n.type === 'text' ? { ...n, h: textHeight(n) } : n))
}

/** Axis-aligned bounds of a (possibly rotated) node. */
function rotatedBounds(n: BoardNode) {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  const t = ((n.rotation ?? 0) * Math.PI) / 180
  const c = Math.abs(Math.cos(t))
  const s = Math.abs(Math.sin(t))
  const hw = (n.w * c + n.h * s) / 2
  const hh = (n.w * s + n.h * c) / 2
  return { x: cx - hw, y: cy - hh, r: cx + hw, b: cy + hh }
}

function boundsOf(nodes: BoardNode[]) {
  if (!nodes.length) return null
  const all = nodes.map(rotatedBounds)
  const x = Math.min(...all.map((b) => b.x))
  const y = Math.min(...all.map((b) => b.y))
  return { x, y, w: Math.max(...all.map((b) => b.r)) - x, h: Math.max(...all.map((b) => b.b)) - y }
}

/**
 * Colour emoji: librsvg (used by sharp for SVG) only draws monochrome glyphs, so stickers are
 * rendered by an offscreen Chromium window instead.
 */
async function emojiPng(emoji: string, w: number, h: number): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, width: w, height: h, transparent: true, frame: false, webPreferences: { offscreen: true } })
  try {
    const size = Math.min(w, h) * 0.82
    const html = `<html><body style="margin:0;width:${w}px;height:${h}px;display:grid;place-items:center;background:transparent;overflow:hidden">
      <span style="font-size:${size}px;line-height:1;font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif">${esc(emoji)}</span></body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 120))
    const img = await win.webContents.capturePage()
    return sharp(img.toPNG()).resize(w, h, { fit: 'fill' }).png().toBuffer()
  } finally {
    win.destroy()
  }
}

/** One node rasterised at `scale`, with flips, opacity and rotation applied. */
async function rasterNode(lib: Library, n: BoardNode, scale: number): Promise<Sharp | null> {
  const w = Math.max(1, Math.round(n.w * scale))
  const h = Math.max(1, Math.round(n.h * scale))
  let img: Sharp
  if (n.type === 'item' && n.itemId) {
    const src = sourceFor(lib, n.itemId)
    if (!src) return null
    img = sharp(await sharp(src, { animated: false, limitInputPixels: false }).rotate().resize(w, h, { fit: 'cover' }).png().toBuffer())
  } else if (n.type === 'sticker' && !n.emoji?.startsWith('i:')) {
    img = sharp(await emojiPng(n.emoji ?? '⭐', w, h))
  } else {
    img = sharp(Buffer.from(nodeSvg(n, scale)))
  }
  if (n.flipX) img = img.flop()
  if (n.flipY) img = img.flip()
  let buf = await img.ensureAlpha().png().toBuffer()
  const op = n.opacity ?? 1
  if (op < 1) {
    buf = await sharp(buf)
      .composite([{ input: Buffer.from([255, 255, 255, Math.round(255 * op)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
      .png()
      .toBuffer()
  }
  if (n.rotation) return sharp(buf).rotate(n.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
  return sharp(buf)
}

/** Renders the board (or only the given node ids) into one PNG, at up to 2× and capped at `maxSide`. */
export async function renderBoardPng(lib: Library, board: Board, maxSide = 8000, only?: Set<string>): Promise<Buffer> {
  const nodes = prepared(board).filter((n) => !only || only.has(n.id))
  const b = boundsOf(nodes)
  if (!b) throw new Error('Доска пуста')
  const scale = Math.min(2, maxSide / (Math.max(b.w, b.h) + PAD * 2))
  const W = Math.round((b.w + PAD * 2) * scale)
  const H = Math.round((b.h + PAD * 2) * scale)

  const layers: OverlayOptions[] = []
  for (const n of nodes) {
    try {
      const img = await rasterNode(lib, n, scale)
      if (!img) continue
      const { data, info } = await img.png().toBuffer({ resolveWithObject: true })
      const cx = (n.x + n.w / 2 - b.x + PAD) * scale
      const cy = (n.y + n.h / 2 - b.y + PAD) * scale
      layers.push({ input: data, left: Math.round(cx - info.width / 2), top: Math.round(cy - info.height / 2) })
    } catch {
      /* unreadable file — leave the gap */
    }
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: board.data.bg } })
    .composite(layers)
    .png()
    .toBuffer()
}

export interface BoardLayer {
  name: string
  png: Buffer
  /** Centre of the layer in output pixels, relative to the board's centre. */
  cx: number
  cy: number
  /** Size of the PNG in pixels. */
  w: number
  h: number
  /** Index into `frames` of the frame this layer sits entirely inside (native frames only). */
  frame?: number
}

/** A frame kept as a frame (not rasterised), in the same output pixels as the layers. */
export interface BoardFrame {
  name: string
  fill?: string | null
  cx: number
  cy: number
  w: number
  h: number
}

/** Does `n` sit entirely inside frame `f`? (The same rule the canvas uses to drag a frame's contents.) */
export const insideFrame = (n: BoardNode, f: BoardNode) => n.id !== f.id && n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h

/**
 * Every visible node rasterised on its own (flips, opacity, rotation baked in), in paint order,
 * with its centre position — for apps that take separate pictures instead of one flat image.
 * With `nativeFrames`, frames come back separately (for apps that have frames of their own) and
 * each layer knows the innermost frame that holds it.
 */
export async function boardScene(lib: Library, board: Board, opts: { maxSide?: number; nativeFrames?: boolean } = {}): Promise<{ layers: BoardLayer[]; frames: BoardFrame[] }> {
  const nodes = prepared(board)
  const b = boundsOf(nodes)
  if (!b) throw new Error('Доска пуста')
  const scale = Math.min(2, (opts.maxSide ?? 16000) / Math.max(b.w, b.h, 1))
  const at = (n: BoardNode) => ({
    cx: Math.round((n.x + n.w / 2 - (b.x + b.w / 2)) * scale),
    cy: Math.round((n.y + n.h / 2 - (b.y + b.h / 2)) * scale)
  })
  const frameNodes = opts.nativeFrames ? nodes.filter((n) => n.type === 'frame') : []
  const frames: BoardFrame[] = frameNodes.map((f) => ({ name: f.name ?? '', fill: f.fill, ...at(f), w: Math.round(f.w * scale), h: Math.round(f.h * scale) }))
  const layers: BoardLayer[] = []
  for (const n of nodes) {
    if (opts.nativeFrames && n.type === 'frame') continue
    try {
      const img = await rasterNode(lib, n, scale)
      if (!img) continue
      const { data, info } = await img.png().toBuffer({ resolveWithObject: true })
      // Innermost frame = the smallest one that holds the node.
      let frame: number | undefined
      frameNodes.forEach((f, i) => {
        if (insideFrame(n, f) && (frame === undefined || f.w * f.h < frameNodes[frame].w * frameNodes[frame].h)) frame = i
      })
      layers.push({ name: (n.itemId && lib.getItem(n.itemId)?.name) || n.name || n.type, png: data, w: info.width, h: info.height, ...at(n), frame })
    } catch {
      /* unreadable file — skip it */
    }
  }
  return { layers, frames }
}

/** Every visible node as its own picture, frames included (see `boardScene`). */
export async function boardLayers(lib: Library, board: Board, maxSide = 16000): Promise<BoardLayer[]> {
  return (await boardScene(lib, board, { maxSide })).layers
}

/**
 * SVG with every node as its own group: pasted or dropped into Figma, each picture, shape and note
 * stays a separate layer in its place. Images are capped at 1600px to keep the clipboard manageable.
 */
export async function boardSvg(lib: Library, board: Board): Promise<string> {
  const nodes = prepared(board)
  const b = boundsOf(nodes)
  if (!b) throw new Error('Доска пуста')
  const W = Math.round(b.w + PAD * 2)
  const H = Math.round(b.h + PAD * 2)
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${esc(board.data.bg)}"/>`]
  for (const n of nodes) {
    const cx = n.x + n.w / 2 - b.x + PAD
    const cy = n.y + n.h / 2 - b.y + PAD
    const transform = `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${n.rotation ?? 0}) scale(${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1}) translate(${(-n.w / 2).toFixed(1)} ${(-n.h / 2).toFixed(1)})`
    let inner = ''
    let id: string = n.type
    if (n.type === 'item' && n.itemId) {
      const src = sourceFor(lib, n.itemId)
      if (!src) continue
      try {
        const px = Math.min(1600, Math.round(n.w * 2))
        const buf = await sharp(src, { animated: false, limitInputPixels: false }).rotate().resize(px, Math.max(1, Math.round((px * n.h) / n.w)), { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer()
        inner = `<image width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" href="data:image/jpeg;base64,${buf.toString('base64')}"/>`
        id = lib.getItem(n.itemId)?.name ?? 'image'
      } catch {
        continue
      }
    } else inner = nodeInnerSvg(n)
    parts.push(`<g id="${esc(id)}" transform="${transform}" opacity="${n.opacity ?? 1}">${inner}</g>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}
