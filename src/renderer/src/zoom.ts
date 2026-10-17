import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp } from './util'

/** Gap between the picture and the edges of the viewer when it is fitted. */
const MARGIN = 24

/**
 * Size that fits `natural` into the stage (keeping proportions), small pictures scaled up too.
 * Returns null until both sizes are known.
 */
export function useFit(stage: React.RefObject<HTMLElement | null>, natural: { w: number; h: number } | null) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])
  if (!box || !natural || !natural.w || !natural.h) return null
  const k = Math.min((box.w - MARGIN * 2) / natural.w, (box.h - MARGIN * 2) / natural.h)
  return { width: Math.max(1, Math.round(natural.w * k)), height: Math.max(1, Math.round(natural.h * k)), scale: k }
}

export interface ZoomPan {
  /** Scale on top of the fitted size, and the pan offset in pixels. */
  t: { s: number; x: number; y: number }
  set(t: { s: number; x: number; y: number }): void
  /** Zooms keeping the point under (clientX, clientY) fixed; no point = the centre. */
  zoomAt(next: number, clientX?: number, clientY?: number): void
  /** Same, relative to the current scale (safe inside listeners that captured an old state). */
  zoomBy(factor: number, clientX?: number, clientY?: number): void
  reset(): void
  /** Spread on the stage: drag to pan once zoomed in. */
  handlers: {
    onPointerDown(e: React.PointerEvent): void
    onPointerMove(e: React.PointerEvent): void
    onPointerUp(e: React.PointerEvent): void
  }
  /** True right after a pan drag, so the click that ends it can be ignored. */
  dragged(): boolean
  style: React.CSSProperties
}

export function useZoomPan(stage: React.RefObject<HTMLElement | null>): ZoomPan {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)
  const moved = useRef(false)

  const zoom = useCallback(
    (next: (s: number) => number, clientX?: number, clientY?: number) => {
      const r = stage.current?.getBoundingClientRect()
      if (!r) return
      const cx = clientX === undefined ? 0 : clientX - r.left - r.width / 2
      const cy = clientY === undefined ? 0 : clientY - r.top - r.height / 2
      setT((p) => {
        const s = clamp(next(p.s), 0.1, 40)
        if (Math.abs(s - 1) < 0.01) return { s: 1, x: 0, y: 0 }
        const k = s / p.s
        return { s, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }
      })
    },
    [stage]
  )

  return {
    t,
    set: setT,
    zoomAt: (next, x, y) => zoom(() => next, x, y),
    zoomBy: (f, x, y) => zoom((s) => s * f, x, y),
    reset: () => setT({ s: 1, x: 0, y: 0 }),
    handlers: {
      onPointerDown(e) {
        moved.current = false
        if (e.button !== 0 || t.s === 1) return
        drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y, moved: false }
      },
      onPointerMove(e) {
        const d = drag.current
        if (!d || !(e.buttons & 1)) return
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
        if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId)
        d.moved = true
        setT((p) => ({ ...p, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
      },
      onPointerUp() {
        moved.current = !!drag.current?.moved
        drag.current = null
      }
    },
    dragged: () => moved.current,
    style: {
      transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
      cursor: t.s > 1 ? 'grab' : undefined
    }
  }
}
