/**
 * SVG markup for non-image board nodes. Shared by the canvas (rendered via innerHTML) and the
 * PNG / Figma exporters, so what you see on the board is exactly what gets exported.
 */
import type { BoardNode, TextRun } from './types'
import { wrapText } from './boardLayout'
import { iconInner } from './icons'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  h = Math.round(h * 60 + 360) % 360
  return [h, Math.round(s * 100), Math.round(l * 100)]
}

/** Height of a palette card for n colours. */
export const paletteHeight = (n: number) => 32 + n * 88
export const PALETTE_W = 316

/** Smooth path through points (quadratic curves through midpoints). */
function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return ''
  if (pts.length < 3) return `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L')}`
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2
    const my = (pts[i][1] + pts[i + 1][1]) / 2
    d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  return `${d} L${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}

/** Points scaled from the node's original (vw × vh) box into its current w × h. */
function scaledPoints(n: BoardNode): [number, number][] {
  const sx = n.vw ? n.w / n.vw : 1
  const sy = n.vh ? n.h / n.vh : 1
  return (n.points ?? []).map(([x, y]) => [x * sx, y * sy])
}

/** Inner SVG (no <svg> wrapper) of a node, in its own w × h coordinate box. */
export function nodeInnerSvg(n: BoardNode): string {
  const stroke = n.stroke ?? '#e8e9ee'
  const sw = n.strokeWidth ?? 3
  switch (n.type) {
    case 'shape': {
      if (n.shape === 'line' || n.shape === 'arrow') {
        const pts = scaledPoints(n)
        if (pts.length < 2) return ''
        const [a, b] = [pts[0], pts[pts.length - 1]]
        let head = ''
        if (n.shape === 'arrow') {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
          const len = Math.max(12, sw * 4)
          const p1 = [b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45)]
          const p2 = [b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45)]
          head = `<path d="M${p1[0]} ${p1[1]} L${b[0]} ${b[1]} L${p2[0]} ${p2[1]}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
        }
        return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round"/>${head}`
      }
      const fill = n.fill ? esc(n.fill) : 'none'
      const inset = sw / 2
      if (n.shape === 'ellipse') {
        return `<ellipse cx="${n.w / 2}" cy="${n.h / 2}" rx="${Math.max(0, n.w / 2 - inset)}" ry="${Math.max(0, n.h / 2 - inset)}" fill="${fill}" stroke="${esc(stroke)}" stroke-width="${sw}"/>`
      }
      return `<rect x="${inset}" y="${inset}" width="${Math.max(0, n.w - sw)}" height="${Math.max(0, n.h - sw)}" rx="6" fill="${fill}" stroke="${esc(stroke)}" stroke-width="${sw}"/>`
    }
    case 'path':
      return `<path d="${smoothPath(scaledPoints(n))}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
    case 'sticker': {
      // "i:<name>" — an icon on a coloured badge; anything else is a legacy emoji sticker.
      if (n.emoji?.startsWith('i:')) {
        const d = Math.min(n.w, n.h)
        const k = (d * 0.52) / 24
        const color = n.stroke ?? '#4d8fe8'
        return `<circle cx="${n.w / 2}" cy="${n.h / 2}" r="${d / 2 - 1}" fill="${esc(color)}"/>
          <circle cx="${n.w / 2}" cy="${n.h / 2}" r="${d / 2 - 1}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="${Math.max(1, d * 0.03)}"/>
          <g transform="translate(${n.w / 2 - 12 * k} ${n.h / 2 - 12 * k}) scale(${k})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner(n.emoji.slice(2))}</g>`
      }
      const size = Math.min(n.w, n.h) * 0.82
      return `<text x="${n.w / 2}" y="${n.h / 2}" font-size="${size}" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">${esc(n.emoji ?? '⭐')}</text>`
    }
    case 'frame': {
      const title = n.name ? `<text x="14" y="26" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="600" fill="rgba(232,233,238,0.75)">${esc(n.name)}</text>` : ''
      return `<rect x="0.5" y="0.5" width="${n.w - 1}" height="${n.h - 1}" rx="12" fill="${esc(n.fill ?? 'rgba(255,255,255,0.035)')}" stroke="rgba(255,255,255,0.14)"/>${title}`
    }
    case 'palette': {
      const rows = (n.colors ?? []).map((hex, i) => {
        const rgb = hexToRgb(hex)
        const [h, s, l] = rgbToHsl(rgb)
        const y = 16 + i * 88
        return `<rect x="16" y="${y}" width="${n.w - 32}" height="76" rx="12" fill="#2b2c32" stroke="#3a3c44"/>
          <circle cx="54" cy="${y + 38}" r="21" fill="${esc(hex)}" stroke="rgba(0,0,0,0.35)"/>
          <text x="92" y="${y + 24}" font-family="Consolas, monospace" font-size="15" font-weight="700" fill="#f1f2f5">${esc(hex.toUpperCase())}</text>
          <text x="92" y="${y + 45}" font-family="Consolas, monospace" font-size="12.5" fill="#a3a6b0">rgb(${rgb.join(', ')})</text>
          <text x="92" y="${y + 63}" font-family="Consolas, monospace" font-size="12.5" fill="#a3a6b0">hsl(${h}°, ${s}%, ${l}%)</text>`
      })
      return `<rect x="0.5" y="0.5" width="${n.w - 1}" height="${n.h - 1}" rx="16" fill="#222328" stroke="#34363d"/>${rows.join('')}`
    }
    case 'text': {
      const anchor = n.align === 'center' ? 'middle' : n.align === 'right' ? 'end' : 'start'
      const x = n.align === 'center' ? n.w / 2 : n.align === 'right' ? n.w : 0
      let y = 0
      return styledLines(n)
        .map((segs) => {
          // A line is as tall as its largest piece.
          const lh = Math.max(...segs.map((s) => s.fontSize ?? n.fontSize ?? 22)) * 1.3
          y += lh
          const spans = segs
            .map((s) => {
              const font = textFont({ ...n, font: s.font ?? n.font })
              return `<tspan font-family="${esc(font)}" font-weight="${s.weight ?? n.weight ?? 600}" font-size="${s.fontSize ?? n.fontSize ?? 22}" fill="${esc(s.color ?? n.color ?? '#e8e9ee')}">${esc(s.text)}</tspan>`
            })
            .join('')
          return `<text x="${x}" y="${y - lh * 0.25}" text-anchor="${anchor}" xml:space="preserve">${spans}</text>`
        })
        .join('')
    }
    default:
      return ''
  }
}

/** Standalone SVG document for one node (used by the PNG exporter and the canvas). */
export function nodeSvg(n: BoardNode, scale = 1): string {
  const w = Math.max(1, n.w)
  const h = Math.max(1, n.h)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="0 0 ${w} ${h}" overflow="visible">${nodeInnerSvg(n)}</svg>`
}

/** Height a text node really needs for its wrapped lines. */
export function textHeight(n: BoardNode): number {
  const lines = styledLines(n)
  const h = lines.reduce((sum, segs) => sum + Math.max(...segs.map((s) => s.fontSize ?? n.fontSize ?? 22)) * 1.3, 0)
  return Math.max(n.h, h + 4)
}

/**
 * The text's lines as styled pieces. Lines come from `textLines` (which may collapse spaces when
 * wrapping), so each of their characters is matched back to the run it came from.
 */
export function styledLines(n: BoardNode): TextRun[][] {
  const runs = n.runs?.length ? n.runs : [{ text: n.text ?? '' }]
  const chars: { ch: string; run: TextRun }[] = []
  for (const r of runs) for (const ch of r.text) chars.push({ ch, run: r })
  let p = 0
  return textLines(n).map((line) => {
    const segs: TextRun[] = []
    for (const ch of line) {
      while (p < chars.length && chars[p].ch !== ch) p++
      const run = chars[p]?.run ?? runs[runs.length - 1]
      p++
      const last = segs[segs.length - 1]
      if (last && sameStyle(last, run)) last.text += ch
      else segs.push({ ...run, text: ch })
    }
    return segs.length ? segs : [{ ...(chars[p]?.run ?? runs[0]), text: '' }]
  })
}

/** Do two runs look the same (ignoring their text)? */
export const sameStyle = (a: TextRun, b: TextRun) => a.color === b.color && a.font === b.font && a.fontSize === b.fontSize && a.weight === b.weight

/** CSS / SVG font-family list for a text node: its chosen font first, then the default ones. */
export function textFont(n: BoardNode): string {
  return n.font ? `'${n.font.replace(/'/g, '')}', Segoe UI, Arial, sans-serif` : 'Segoe UI, Arial, sans-serif'
}

/** A text node's lines: auto-width text breaks only at Enter, fixed-width text also wraps. */
export function textLines(n: BoardNode): string[] {
  return n.autoWidth ? (n.text ?? '').split('\n') : wrapText(n.text ?? '', n.w, n.fontSize ?? 22)
}
