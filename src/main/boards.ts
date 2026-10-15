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
 * SVG for Figma: every node is its own layer in its place, and every frame is a nested <svg> —
 * which Figma imports as a real frame — holding the nodes that lie inside it. Pictures go in at
 * up to 4096px (Figma's limit); that is fine for a pasted or dropped file, but far too big to
 * paste as text (Figma silently ignores SVG text over roughly 120–250 KB).
 */
export async function boardSvg(lib: Library, board: Board): Promise<{ svg: string; name: string }> {
  const nodes = prepared(board)
  const b = boundsOf(nodes)
  if (!b) throw new Error('Доска пуста')
  const W = Math.round(b.w + PAD * 2)
  const H = Math.round(b.h + PAD * 2)
  const frames = nodes.filter((n) => n.type === 'frame')
  // Innermost frame holding each node (the smallest one it lies entirely inside).
  const parentOf = new Map<string, string>()
  for (const n of nodes) {
    let best: BoardNode | undefined
    for (const f of frames) if (insideFrame(n, f) && (!best || f.w * f.h < best.w * best.h)) best = f
    if (best) parentOf.set(n.id, best.id)
  }
  const layer = async (n: BoardNode, ox: number, oy: number): Promise<string> => {
    if (n.type === 'frame') {
      const kids = await Promise.all(nodes.filter((c) => parentOf.get(c.id) === n.id).map((c) => layer(c, n.x, n.y)))
      const fill = n.fill ?? 'rgba(255,255,255,0.035)'
      return `<svg id="${esc(n.name || 'Frame')}" x="${(n.x - ox).toFixed(1)}" y="${(n.y - oy).toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" viewBox="0 0 ${n.w.toFixed(1)} ${n.h.toFixed(1)}" opacity="${n.opacity ?? 1}"><rect width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" fill="${esc(fill)}"/>${kids.join('')}</svg>`
    }
    const cx = n.x + n.w / 2 - ox
    const cy = n.y + n.h / 2 - oy
    const transform = `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${n.rotation ?? 0}) scale(${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1}) translate(${(-n.w / 2).toFixed(1)} ${(-n.h / 2).toFixed(1)})`
    let inner = ''
    let id: string = n.type
    if (n.type === 'item' && n.itemId) {
      const src = sourceFor(lib, n.itemId)
      if (!src) return ''
      try {
        const img = sharp(src, { animated: false, limitInputPixels: false }).rotate()
        const meta = await img.metadata()
        const [mw, mh] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 1, meta.width ?? 1] : [meta.width ?? 1, meta.height ?? 1]
        // As sharp as the source allows for the node's crop, capped at 4096px.
        const px = Math.max(1, Math.min(4096, mw, Math.round((mh * n.w) / n.h)))
        const sized = img.resize(px, Math.max(1, Math.round((px * n.h) / n.w)), { fit: 'cover' })
        const [mime, buf] = meta.hasAlpha ? ['image/png', await sized.png().toBuffer()] : ['image/jpeg', await sized.jpeg({ quality: 92 }).toBuffer()]
        inner = `<image width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" href="data:${mime};base64,${buf.toString('base64')}"/>`
        id = lib.getItem(n.itemId)?.name ?? 'image'
      } catch {
        return ''
      }
    } else inner = nodeInnerSvg(n)
    return `<g id="${esc(id)}" transform="${transform}" opacity="${n.opacity ?? 1}">${inner}</g>`
  }
  const tops = nodes.filter((n) => !parentOf.has(n.id))
  const xmlns = 'xmlns="http://www.w3.org/2000/svg"'
  // Figma turns the root <svg> itself into a frame (named after the file). When the copy is one
  // frame with its contents, that frame *is* the root — otherwise Figma nests it in a second frame.
  if (tops.length === 1 && tops[0].type === 'frame') {
    const f = tops[0]
    const [w, h] = [f.w.toFixed(1), f.h.toFixed(1)]
    const kids = await Promise.all(nodes.filter((c) => parentOf.get(c.id) === f.id).map((c) => layer(c, f.x, f.y)))
    const svg = `<svg ${xmlns} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${esc(board.data.bg)}"/><rect width="${w}" height="${h}" fill="${esc(f.fill ?? 'rgba(255,255,255,0.035)')}"/>${kids.join('')}</svg>`
    return { svg, name: f.name || 'Frame' }
  }
  const top = await Promise.all(tops.map((n) => layer(n, b.x - PAD, b.y - PAD)))
  return { svg: `<svg ${xmlns} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${esc(board.data.bg)}"/>${top.join('')}</svg>`, name: board.name }
}
