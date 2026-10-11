import type { ItemLite } from '../../../shared/types'
import { fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, dims } from '../util'

export interface PeekState {
  item: ItemLite
  /** Tile rectangle in viewport coordinates. */
  rect: { left: number; top: number; width: number; height: number }
}

const MARGIN = 24

/** Enlarged hover preview, centred on the tile and kept inside the window. */
export function Peek({ item, rect }: PeekState) {
  const ratio = item.width && item.height ? item.width / item.height : 1
  const maxW = Math.min(window.innerWidth * 0.62, (item.width ?? 2000) * 1.0)
  const maxH = window.innerHeight * 0.78
  let w = Math.max(rect.width * 1.6, Math.min(maxW, maxH * ratio))
  let h = w / ratio
  if (h > maxH) {
    h = maxH
    w = h * ratio
  }
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const left = Math.min(Math.max(MARGIN, cx - w / 2), window.innerWidth - w - MARGIN)
  const top = Math.min(Math.max(MARGIN + 44, cy - h / 2), window.innerHeight - h - MARGIN)

  const src = item.kind === 'image' && BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : null
  if (!src) return null

  return (
    <div className="peek" style={{ left, top, width: w, height: h }}>
      {/* Thumbnail first so something shows instantly while the original decodes. */}
      {item.thumb === 1 && <img className="peek-low" src={thumbUrl(item.id, item.thumbV)} alt="" />}
      <img className="peek-full" src={src} alt="" />
      <div className="peek-info">
        {item.name} <span className="muted">· {dims(item)}</span>
      </div>
    </div>
  )
}
