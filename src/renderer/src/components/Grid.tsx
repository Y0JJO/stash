import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { getSettings } from '../settings'
import type { ItemLite } from '../../../shared/types'
import { fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, clamp, dims, fmtDuration } from '../util'

const GAP = 12
const PAD = 16
const LABEL = 40
const OVERSCAN = 900

export interface GridHandlers {
  down(index: number, e: React.MouseEvent): void
  click(index: number, e: React.MouseEvent): void
  open(index: number): void
  menu(index: number, e: React.MouseEvent): void
  drag(index: number): void
  /** Hover preview request (null hides it). */
  peek(index: number | null, rect?: DOMRect): void
  sound(): void
}

interface Props extends GridHandlers {
  items: ItemLite[]
  selected: Set<string>
  tileSize: number
  showLabels: boolean
  /** Index to scroll into view (changes trigger scrolling). */
  reveal: { index: number } | null
  resetKey: string
  hoverPreview: boolean
  soundOn: boolean
  onBackground(): void
  empty: React.ReactNode
}

interface Pos {
  x: number
  y: number
  w: number
  h: number
}

/** Virtualized masonry grid: only tiles near the viewport are mounted. */
export function Grid(props: Props) {
  const { items, selected, tileSize, showLabels, reveal, resetKey } = props
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [top, setTop] = useState(0)

  // Handlers change every parent render; route them through a ref so tiles can stay memoized.
  const latest = useRef(props)
  latest.current = props
  const handlers = useMemo<GridHandlers>(
    () => ({
      down: (i, e) => latest.current.down(i, e),
      click: (i, e) => latest.current.click(i, e),
      open: (i) => latest.current.open(i),
      menu: (i, e) => latest.current.menu(i, e),
      drag: (i) => latest.current.drag(i),
      peek: (i, r) => latest.current.peek(i, r),
      sound: () => latest.current.sound()
    }),
    []
  )

  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0
    setTop(0)
  }, [resetKey])

  const label = showLabels ? LABEL : 0
  const layout = useMemo(() => {
    const inner = Math.max(0, size.w - PAD * 2)
    const cols = Math.max(1, Math.round((inner + GAP) / (tileSize + GAP)))
    const colW = (inner - GAP * (cols - 1)) / cols
    const heights = new Array(cols).fill(PAD)
    const pos: Pos[] = new Array(items.length)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const ratio = it.width && it.height ? clamp(it.height / it.width, 0.3, 2.5) : 1
      const h = Math.round(colW * ratio)
      let c = 0
      for (let j = 1; j < cols; j++) if (heights[j] < heights[c]) c = j
      pos[i] = { x: PAD + c * (colW + GAP), y: heights[c], w: colW, h }
      heights[c] += h + label + GAP
    }
    return { pos, total: Math.max(...heights) + PAD }
  }, [items, size.w, tileSize, label])

  useEffect(() => {
    const el = ref.current
    const p = reveal && layout.pos[reveal.index]
    if (!el || !p) return
    if (p.y < el.scrollTop) el.scrollTop = p.y - PAD
    else if (p.y + p.h + label > el.scrollTop + el.clientHeight) el.scrollTop = p.y + p.h + label - el.clientHeight + PAD
  }, [reveal, layout, label])

  const visible: number[] = []
  const from = top - OVERSCAN
  const to = top + size.h + OVERSCAN
  for (let i = 0; i < layout.pos.length; i++) {
    const p = layout.pos[i]
    if (p.y + p.h + label >= from && p.y <= to) visible.push(i)
  }

  return (
    <div
      className="grid"
      ref={ref}
      onScroll={(e) => {
        setTop(e.currentTarget.scrollTop)
        props.peek(null)
      }}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement
        if (e.button === 0 && (t === e.currentTarget || t.classList.contains('grid-canvas'))) props.onBackground()
      }}
    >
      <div className="grid-canvas" style={{ height: layout.total }}>
        {visible.map((i) => (
          <Tile
            key={items[i].id}
            item={items[i]}
            index={i}
            pos={layout.pos[i]}
            label={label}
            selected={selected.has(items[i].id)}
            hoverPreview={props.hoverPreview}
            soundOn={props.soundOn}
            h={handlers}
          />
        ))}
      </div>
      {items.length === 0 && <div className="grid-empty">{props.empty}</div>}
    </div>
  )
}

interface TileProps {
  item: ItemLite
  index: number
  pos: Pos
  label: number
  selected: boolean
  hoverPreview: boolean
  soundOn: boolean
  h: GridHandlers
}

const Tile = memo(function Tile({ item, index, pos, label, selected, hoverPreview, soundOn, h }: TileProps) {
  const [hover, setHover] = useState(false)
  const [scrub, setScrub] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const peekTimer = useRef<number | undefined>(undefined)
  const video = useRef<HTMLVideoElement>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const isVideo = item.kind === 'video'
  const isGif = item.ext === 'gif'

  useEffect(
    () => () => {
      window.clearTimeout(hoverTimer.current)
      window.clearTimeout(peekTimer.current)
    },
    []
  )

  const src =
    item.thumb === 1
      ? thumbUrl(item.id, item.thumbV)
      : item.thumb === 2 && item.kind === 'image' && BROWSER_IMAGE.has(item.ext)
        ? fileUrl(item.id)
        : null

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = video.current
    if (!v || !v.duration) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = clamp((e.clientX - r.left) / r.width, 0, 1)
    v.pause()
    v.currentTime = ratio * v.duration
    setScrub(ratio)
  }

  return (
    <div
      className={`tile${selected ? ' selected' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`, width: pos.w }}
      onMouseDown={(e) => h.down(index, e)}
      onClick={(e) => h.click(index, e)}
      onDoubleClick={() => h.open(index)}
      onContextMenu={(e) => h.menu(index, e)}
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        h.drag(index)
      }}
    >
      <div
        className="tile-media"
        style={{ height: pos.h }}
        onMouseEnter={(e) => {
          if ((isVideo && getSettings().videoHoverPreview) || isGif) hoverTimer.current = window.setTimeout(() => setHover(true), 120)
          else if (hoverPreview && item.kind === 'image') {
            const el = e.currentTarget
            peekTimer.current = window.setTimeout(() => h.peek(index, el.getBoundingClientRect()), 450)
          }
        }}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current)
          window.clearTimeout(peekTimer.current)
          setHover(false)
          setScrub(null)
          h.peek(null)
        }}
        onMouseMove={isVideo && hover ? onMove : undefined}
      >
        {src ? (
          <img src={src} draggable={false} decoding="async" alt="" />
        ) : (
          <div className={`tile-ph${item.thumb === 0 ? ' loading' : ''}`}>{item.thumb !== 0 && <span>{item.ext.toUpperCase()}</span>}</div>
        )}
        {hover && isVideo && (
          <video
            ref={video}
            className="tile-hover"
            src={fileUrl(item.id)}
            muted={!soundOn}
            autoPlay
            loop
            playsInline
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          />
        )}
        {hover && isVideo && (
          <>
            <span className="tile-time">
              {fmtDuration(time)} / {fmtDuration(item.duration)}
            </span>
            <button
              className={`tile-sound${soundOn ? ' on' : ''}`}
              title={soundOn ? 'Выключить звук' : 'Включить звук'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                h.sound()
              }}
            >
              <Icon name={soundOn ? 'sound' : 'mute'} size={13} />
            </button>
          </>
        )}
        {hover && isGif && <img className="tile-hover" src={fileUrl(item.id)} draggable={false} alt="" />}
        {isVideo && !hover && <span className="tile-badge">{fmtDuration(item.duration)}</span>}
        {isGif && !hover && <span className="tile-badge">GIF</span>}
        {scrub !== null && <div className="tile-scrub" style={{ width: `${scrub * 100}%` }} />}
      </div>
      {label > 0 && (
        <div className="tile-label">
          <div className="tile-name" title={item.name}>
            {item.name}
          </div>
          <div className="tile-meta">
            {item.ext.toUpperCase()}
            {dims(item) && ` · ${dims(item)}`}
            {item.rating > 0 && (
              <span className="tile-stars">
                {Array.from({ length: item.rating }, (_, k) => (
                  <Icon key={k} name="star" size={10} filled />
                ))}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
