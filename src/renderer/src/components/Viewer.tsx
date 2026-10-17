import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ItemLite } from '../../../shared/types'
import { api, fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, BROWSER_VIDEO, dims } from '../util'
import { useFit, useZoomPan } from '../zoom'
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

/** GIFs get the video player (frame stepping, speed, trimming); needs the browser's ImageDecoder. */
const isGif = (item: ItemLite | undefined) => item?.ext === 'gif' && 'ImageDecoder' in window

/** Full-window preview with zoom/pan for images and a player for video. */
export function Viewer({ items, index, onIndex, onClose, onGrabFrame }: Props) {
  const item = items[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isVideo = items[index]?.kind === 'video' || isGif(items[index])
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
        {(item.kind === 'video' && BROWSER_VIDEO.has(item.ext)) || isGif(item) ? (
          <VideoPlayer key={item.id} item={item} gif={isGif(item)} onGrab={(t, target) => onGrabFrame?.(item.id, t, target) ?? Promise.resolve()} />
        ) : (
          <ZoomImage
            key={item.id}
            src={item.kind === 'image' && BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : null}
            label={item.ext.toUpperCase()}
            size={item.width && item.height ? { w: item.width, h: item.height } : null}
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

function ZoomImage({ src, label, size, onStep }: { src: string | null; label: string; size: { w: number; h: number } | null; onStep(dir: number): void }) {
  const prefs = useSettings()
  const stage = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState(size)
  const fit = useFit(stage, natural)
  const z = useZoomPan(stage)
  const startedOriginal = useRef(false)

  // "Исходный размер": start at 100% (a zoom of 1 / fit scale) instead of fitting the window.
  useEffect(() => {
    if (!fit || startedOriginal.current || prefs.imageDefaultSize !== 'original') return
    startedOriginal.current = true
    if (fit.scale > 1.001 || fit.scale < 0.999) z.set({ s: 1 / fit.scale, x: 0, y: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit?.scale, prefs.imageDefaultSize])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey) return
      if (e.key === '+' || e.key === '=') z.zoomAt(z.t.s * 1.25)
      else if (e.key === '-') z.zoomAt(z.t.s / 1.25)
      else if (e.key === '0') z.reset()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!src) return <div className="viewer-ph">{label}</div>

  return (
    <div
      ref={stage}
      className="zoom-stage"
      onWheel={(e) =>
        // Ctrl always zooms; otherwise the wheel follows the "Управление" preference.
        prefs.imageWheel === 'navigate' && !e.ctrlKey ? onStep(e.deltaY > 0 ? 1 : -1) : z.zoomAt(z.t.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY)
      }
      onDoubleClick={(e) => (z.t.s === 1 ? z.zoomAt(2.5, e.clientX, e.clientY) : z.reset())}
      {...z.handlers}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className={prefs.transparentGrid ? 'checker' : undefined}
        onLoad={(e) => {
          const img = e.currentTarget
          if (!natural || natural.w !== img.naturalWidth || natural.h !== img.naturalHeight) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
        }}
        style={{
          ...(fit ? { width: fit.width, height: fit.height } : { maxWidth: '100%', maxHeight: '100%' }),
          ...z.style,
          cursor: z.t.s > 1 ? 'grab' : 'zoom-in',
          imageRendering: prefs.imageSmoothing === 'pixelated' ? 'pixelated' : 'auto'
        }}
      />
      {z.t.s !== 1 && (
        <button className="zoom-badge" onClick={z.reset} title="Вписать в окно (0)">
          {Math.round(z.t.s * (fit?.scale ?? 1) * 100)}%
        </button>
      )}
    </div>
  )
}
