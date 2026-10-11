import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ItemLite } from '../../../shared/types'
import { api, fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, BROWSER_VIDEO, clamp, dims } from '../util'
import { VideoPlayer } from './VideoPlayer'
import { useSettings } from '../settings'

interface Props {
  items: ItemLite[]
  index: number
  onIndex(i: number): void
  onClose(): void
  /** Save a video frame: to the library, the clipboard or a file. */
  onGrabFrame?(id: string, time: number, target: 'library' | 'clipboard' | 'file'): Promise<unknown>
}

/** Full-window preview with zoom/pan for images and a player for video. */
export function Viewer({ items, index, onIndex, onClose, onGrabFrame }: Props) {
  const item = items[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isVideo = items[index]?.kind === 'video'
      if (e.key === 'Escape' || (e.key === ' ' && !isVideo) || e.key === 'Enter') {
        e.preventDefault()
        onClose()
      } else if (isVideo && (e.shiftKey || e.ctrlKey) && e.key.startsWith('Arrow')) {
        return // the player uses Shift/Ctrl + arrows for seeking and frame stepping
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (index > 0) onIndex(index - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (index < items.length - 1) onIndex(index + 1)
      } else return
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, index, onIndex, onClose])

  if (!item) return null

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <div className="viewer-title">
          {item.name}
          <span className="muted">
            {' '}
            · {item.ext.toUpperCase()} {dims(item)}
          </span>
        </div>
        <div className="muted">
          {index + 1} / {items.length}
        </div>
        <button className="icon-btn" onClick={() => api.openExternal(item.id)} title="Открыть во внешнем приложении">
          <Icon name="external" size={15} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Закрыть (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="viewer-stage">
        {item.kind === 'video' && BROWSER_VIDEO.has(item.ext) ? (
          <VideoPlayer key={item.id} item={item} onGrab={(t, target) => onGrabFrame?.(item.id, t, target) ?? Promise.resolve()} />
        ) : (
          <ZoomImage
            key={item.id}
            src={item.kind === 'image' && BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : null}
            label={item.ext.toUpperCase()}
            onStep={(dir) => {
              const next = index + dir
              if (next >= 0 && next < items.length) onIndex(next)
            }}
          />
        )}
        {index > 0 && (
          <button className="viewer-nav prev" onClick={() => onIndex(index - 1)}>
            <Icon name="chevron-left" size={26} />
          </button>
        )}
        {index < items.length - 1 && (
          <button className="viewer-nav next" onClick={() => onIndex(index + 1)}>
            <Icon name="chevron-right" size={26} />
          </button>
        )}
      </div>
    </div>
  )
}

function ZoomImage({ src, label, onStep }: { src: string | null; label: string; onStep(dir: number): void }) {
  const prefs = useSettings()
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // Zoom keeping the point under the cursor fixed.
  const zoomAt = (clientX: number, clientY: number, next: number) => {
    const r = stage.current!.getBoundingClientRect()
    const cx = clientX - r.left - r.width / 2
    const cy = clientY - r.top - r.height / 2
    setT((p) => {
      const s = clamp(next, 0.2, 32)
      const k = s / p.s
      return s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }
    })
  }

  if (!src) return <div className="viewer-ph">{label}</div>

  return (
    <div
      ref={stage}
      className="zoom-stage"
      onWheel={(e) =>
        // Ctrl always zooms; otherwise the wheel follows the "Управление" preference.
        prefs.imageWheel === 'navigate' && !e.ctrlKey ? onStep(e.deltaY > 0 ? 1 : -1) : zoomAt(e.clientX, e.clientY, t.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
      }
      onDoubleClick={(e) => (t.s === 1 ? zoomAt(e.clientX, e.clientY, 2.5) : setT({ s: 1, x: 0, y: 0 }))}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y }
      }}
      onMouseMove={(e) => {
        const d = drag.current
        if (d) setT((p) => ({ ...p, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
      }}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className={prefs.transparentGrid ? 'checker' : undefined}
        onLoad={(e) => {
          // "Исходный размер": start at 100% instead of fitting the window.
          const img = e.currentTarget
          if (prefs.imageDefaultSize === 'original' && img.clientWidth && img.naturalWidth > img.clientWidth) setT({ s: img.naturalWidth / img.clientWidth, x: 0, y: 0 })
        }}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          cursor: t.s > 1 ? 'grab' : 'zoom-in',
          imageRendering: prefs.imageSmoothing === 'pixelated' ? 'pixelated' : 'auto'
        }}
      />
      {t.s !== 1 && <div className="zoom-badge">{Math.round(t.s * 100)}%</div>}
    </div>
  )
}
