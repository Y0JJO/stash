import { useEffect, useRef, useState } from 'react'
import type { ItemLite } from '../../../shared/types'
import { thumbUrl } from '../api'
import { dims, fmtDate, fmtDuration, fmtSize } from '../util'
import type { GridHandlers } from './Grid'
import { Icon } from './Icon'

const ROW = 52
const OVERSCAN = 12

interface Props extends Pick<GridHandlers, 'down' | 'click' | 'open' | 'menu' | 'drag'> {
  items: ItemLite[]
  selected: Set<string>
  reveal: { index: number } | null
  resetKey: string
  onBackground(): void
  empty: React.ReactNode
}

/** The "Список" view: one row per item with its details; virtualized like the grid. */
export function ListView({ items, selected, reveal, resetKey, onBackground, empty, ...h }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, h: 800 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setView({ top: el.scrollTop, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    ref.current?.scrollTo({ top: 0 })
  }, [resetKey])

  useEffect(() => {
    const el = ref.current
    if (!el || !reveal) return
    const y = reveal.index * ROW
    if (y < el.scrollTop || y + ROW > el.scrollTop + el.clientHeight) el.scrollTo({ top: y - el.clientHeight / 2 + ROW / 2 })
  }, [reveal])

  if (!items.length) return <div className="grid-empty">{empty}</div>

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
  const last = Math.min(items.length, Math.ceil((view.top + view.h) / ROW) + OVERSCAN)

  return (
    <div className="list-view">
      <div className="list-head">
        <span className="lc-thumb" />
        <span className="lc-name">Имя</span>
        <span className="lc-type">Тип</span>
        <span className="lc-dims">Размеры</span>
        <span className="lc-dur">Длит.</span>
        <span className="lc-size">Вес</span>
        <span className="lc-rating">Рейтинг</span>
        <span className="lc-date">Добавлен</span>
      </div>
      <div
        className="list-scroll"
        ref={ref}
        onScroll={(e) => setView((v) => ({ ...v, top: e.currentTarget.scrollTop }))}
        onMouseDown={(e) => {
          if (e.button === 0 && e.target === e.currentTarget) onBackground()
        }}
      >
        <div className="list-canvas" style={{ height: items.length * ROW }}>
          {items.slice(first, last).map((it, k) => {
            const i = first + k
            return (
              <div
                key={it.id}
                className={`list-row${selected.has(it.id) ? ' selected' : ''}`}
                style={{ transform: `translateY(${i * ROW}px)` }}
                onMouseDown={(e) => h.down(i, e)}
                onClick={(e) => h.click(i, e)}
                onDoubleClick={() => h.open(i)}
                onContextMenu={(e) => h.menu(i, e)}
                draggable
                onDragStart={(e) => {
                  e.preventDefault()
                  h.drag(i)
                }}
              >
                <span className="lc-thumb">{it.thumb === 1 && <img src={thumbUrl(it.id, it.thumbV)} draggable={false} decoding="async" alt="" />}</span>
                <span className="lc-name">{it.name}</span>
                <span className="lc-type">{it.ext.toUpperCase()}</span>
                <span className="lc-dims">{dims(it)}</span>
                <span className="lc-dur">{it.duration ? fmtDuration(it.duration) : ''}</span>
                <span className="lc-size">{fmtSize(it.size)}</span>
                <span className="lc-rating">
                  {Array.from({ length: it.rating }, (_, n) => (
                    <Icon key={n} name="star" size={11} filled />
                  ))}
                </span>
                <span className="lc-date">{fmtDate(it.addedAt)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
