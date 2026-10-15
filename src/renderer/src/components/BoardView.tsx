import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardData, BoardNode, ItemLite, MenuEntry } from '../../../shared/types'
import { NO_FILTERS } from '../../../shared/types'
import { masonry, newNodeId } from '../../../shared/boardLayout'
import { nodeSvg, PALETTE_W, paletteHeight } from '../../../shared/boardSvg'
import { api, droppedPaths, fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, clamp, keyOf } from '../util'
import { Icon } from './Icon'
import { STICKER_ICONS } from '../../../shared/icons'

const ITEMS_MIME = 'application/x-stash-items'
const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
const SNAP = 10

type Tool = 'select' | 'pan' | 'text' | 'pen' | 'marker' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'frame'

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: 'select', icon: 'cursor', label: 'Выделение', key: 'V' },
  { tool: 'pan', icon: 'hand', label: 'Перемещение', key: 'H' },
  { tool: 'text', icon: 'type', label: 'Текст', key: 'T' },
  { tool: 'pen', icon: 'pencil', label: 'Карандаш', key: 'P' },
  { tool: 'marker', icon: 'marker', label: 'Маркер', key: 'M' },
  { tool: 'rect', icon: 'square', label: 'Прямоугольник', key: 'R' },
  { tool: 'ellipse', icon: 'circle', label: 'Эллипс', key: 'O' },
  { tool: 'line', icon: 'line', label: 'Линия', key: 'L' },
  { tool: 'arrow', icon: 'arrow', label: 'Стрелка', key: 'A' },
  { tool: 'frame', icon: 'frame', label: 'Фрейм', key: 'F' }
]

const COLORS = ['#f1f2f5', '#9e9e9e', '#1b1c20', '#e5534b', '#e8963a', '#e8c547', '#57b05b', '#4fb6c8', '#4d8fe8', '#a97be8', '#e86fa6']
const FONT_SIZES: [string, number][] = [['S', 16], ['M', 22], ['L', 34], ['XL', 56]]
const STROKES: [string, number][] = [['Тонкая', 2], ['Средняя', 4], ['Толстая', 8]]

interface Props {
  boardId: string
  /** Bumps when the library changes (thumbnails, renames…). */
  version: number
  onSelectItems(ids: string[]): void
  onOpenItem(id: string): void
  onLocateItem(id: string): void
  focus: boolean
  onFocus(on: boolean): void
}

type Drag =
  | { kind: 'move'; sx: number; sy: number; orig: Map<string, { x: number; y: number }>; before: BoardNode[]; moved: boolean }
  | { kind: 'resize'; n0: BoardNode; hx: number; hy: number; sx: number; sy: number; before: BoardNode[] }
  | { kind: 'rotate'; id: string; cx: number; cy: number; before: BoardNode[] }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'marquee'; bx: number; by: number; cx: number; cy: number; add: boolean }
  | { kind: 'draw'; pts: [number, number][]; marker: boolean }
  | { kind: 'create'; tool: Tool; bx: number; by: number; cx: number; cy: number }

interface ToolOpts {
  color: string
  strokeWidth: number
  fill: boolean
  fontSize: number
}

const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const snapTo = (v: number, on: boolean) => (on ? Math.round(v / SNAP) * SNAP : v)
const rad = (deg: number) => (deg * Math.PI) / 180

/** Free-form canvas: tools, shapes, drawing, palettes, layers, rotation, undo, export. */
export function BoardView({ boardId, version, onSelectItems, onOpenItem, onLocateItem, focus, onFocus }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [name, setName] = useState('')
  const [nodes, setNodes] = useState<BoardNode[]>([])
  const [bg, setBg] = useState('#1a1b1f')
  const [grid, setGrid] = useState(true)
  const [snap, setSnap] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [items, setItems] = useState<Map<string, ItemLite>>(new Map())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [opts, setOpts] = useState<ToolOpts>({ color: '#e8c547', strokeWidth: 4, fill: false, fontSize: 22 })
  const [panel, setPanel] = useState<'layers' | 'settings' | 'keys' | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [stickers, setStickers] = useState(false)
  const [preview, setPreview] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [draft, setDraft] = useState<BoardNode | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const viewRef = useRef(view)
  viewRef.current = view
  const settingsRef = useRef({ bg, grid, snap })
  settingsRef.current = { bg, grid, snap }
  const drag = useRef<Drag | null>(null)
  const history = useRef<{ past: BoardNode[][]; future: BoardNode[][] }>({ past: [], future: [] })
  const saveTimer = useRef<number | undefined>(undefined)

  const flash = (text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 2200)
  }

  // ---------- load / save ----------

  const dataNow = (): BoardData => ({ nodes: nodesRef.current, view: viewRef.current, ...settingsRef.current })
  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void api.saveBoard(boardId, dataNow()), 400)
  }, [boardId])

  const fit = useCallback((list = nodesRef.current.filter((n) => !n.hidden)) => {
    const el = wrap.current
    if (!el) return
    if (!list.length) return setView({ x: el.clientWidth / 2, y: el.clientHeight / 2, zoom: 1 })
    const x = Math.min(...list.map((n) => n.x))
    const y = Math.min(...list.map((n) => n.y))
    const w = Math.max(...list.map((n) => n.x + n.w)) - x
    const h = Math.max(...list.map((n) => n.y + n.h)) - y
    const zoom = clamp(Math.min((el.clientWidth - 200) / w, (el.clientHeight - 160) / h), MIN_ZOOM, 2)
    setView({ x: el.clientWidth / 2 - (x + w / 2) * zoom, y: el.clientHeight / 2 - (y + h / 2) * zoom, zoom })
  }, [])

  const load = useCallback(
    async (keepView: boolean) => {
      const b = await api.getBoard(boardId)
      if (!b) return
      setName(b.name)
      setNodes(b.data.nodes)
      nodesRef.current = b.data.nodes
      setBg(b.data.bg)
      setGrid(b.data.grid ?? true)
      setSnap(b.data.snap ?? false)
      setItems(new Map(b.items.map((i) => [i.id, i])))
      if (!keepView) {
        if (b.data.view) setView(b.data.view)
        else requestAnimationFrame(() => fit(b.data.nodes))
      }
      setLoaded(true)
    },
    [boardId, fit]
  )

  useEffect(() => {
    history.current = { past: [], future: [] }
    setSelected(new Set())
    setLoaded(false)
    void load(false)
    const off = api.onBoardChanged((id) => id === boardId && void load(true))
    return () => {
      off()
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        void api.saveBoard(boardId, dataNow())
      }
    }
  }, [boardId, load])

  useEffect(() => {
    if (loaded) api.getBoard(boardId).then((b) => b && setItems(new Map(b.items.map((i) => [i.id, i]))))
  }, [version])

  useEffect(() => {
    onSelectItems(nodes.filter((n) => selected.has(n.id) && n.itemId).map((n) => n.itemId!))
  }, [selected])

  // ---------- history ----------

  const apply = (next: BoardNode[], before = nodesRef.current) => {
    history.current.past.push(before)
    if (history.current.past.length > 100) history.current.past.shift()
    history.current.future = []
    setNodes(next)
    nodesRef.current = next
    save()
  }
  const patch = (ids: Set<string>, fn: (n: BoardNode) => Partial<BoardNode>) => apply(nodesRef.current.map((n) => (ids.has(n.id) ? { ...n, ...fn(n) } : n)))
  const undo = () => {
    const prev = history.current.past.pop()
    if (!prev) return
    history.current.future.push(nodesRef.current)
    setNodes(prev)
    nodesRef.current = prev
    save()
  }
  const redo = () => {
    const next = history.current.future.pop()
    if (!next) return
    history.current.past.push(nodesRef.current)
    setNodes(next)
    nodesRef.current = next
    save()
  }

  // ---------- coordinates ----------

  const toBoard = (clientX: number, clientY: number) => {
    const r = wrap.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }
  const center = () => {
    const el = wrap.current!
    const r = el.getBoundingClientRect()
    return toBoard(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2)
  }
  const maxZ = () => Math.max(0, ...nodesRef.current.map((n) => n.z))
  const minZ = () => Math.min(0, ...nodesRef.current.map((n) => n.z))
  const zoomBy = (k: number) => {
    const el = wrap.current!
    const mx = el.clientWidth / 2
    const my = el.clientHeight / 2
    setView((v) => {
      const zoom = clamp(v.zoom * k, MIN_ZOOM, MAX_ZOOM)
      return { zoom, x: mx - (mx - v.x) * (zoom / v.zoom), y: my - (my - v.y) * (zoom / v.zoom) }
    })
    save()
  }

  // ---------- adding things ----------

  const addItems = async (ids: string[], at?: { x: number; y: number }) => {
    if (!ids.length) return
    const before = nodesRef.current
    try {
      const data = await api.boardAddItems(boardId, ids, at)
      history.current.past.push(before)
      history.current.future = []
      await load(true)
      // Only the new nodes: the same item may already be on the board.
      const had = new Set(before.map((n) => n.id))
      setSelected(new Set(data.nodes.filter((n) => !had.has(n.id)).map((n) => n.id)))
    } catch (e) {
      flash(errText(e))
    }
  }

  const addNode = (n: Omit<BoardNode, 'id' | 'z'>, select = true) => {
    const node = { ...n, id: newNodeId(), z: n.type === 'frame' ? minZ() - 1 : maxZ() + 1 } as BoardNode
    apply([...nodesRef.current, node])
    if (select) setSelected(new Set([node.id]))
    return node
  }

  const addText = (at = center()) => {
    const node = addNode({ type: 'text', x: at.x, y: at.y - opts.fontSize * 0.6, w: 280, h: opts.fontSize * 1.4, text: 'Текст', fontSize: opts.fontSize, color: opts.color === '#1b1c20' ? '#f1f2f5' : opts.color })
    setEditing(node.id)
    setTool('select')
  }

  const addSticker = (icon: string, color: string) => {
    const c = center()
    addNode({ type: 'sticker', x: c.x - 36, y: c.y - 36, w: 72, h: 72, emoji: `i:${icon}`, stroke: color })
    setStickers(false)
  }

  const makePalette = async (n: BoardNode) => {
    if (!n.itemId) return
    const it = await api.getItem(n.itemId)
    const colors = (it?.palette ?? []).map((c) => c.hex)
    if (!colors.length) return flash('У этого файла ещё нет палитры')
    addNode({ type: 'palette', x: n.x + n.w + 24, y: n.y, w: PALETTE_W, h: paletteHeight(colors.length), colors })
  }

  const arrange = () => {
    const list = nodesRef.current
    const targets = list.filter((n) => n.type === 'item' && !n.locked && (selected.size ? selected.has(n.id) : true))
    if (!targets.length) return
    const x = Math.min(...targets.map((n) => n.x))
    const y = Math.min(...targets.map((n) => n.y))
    const laid = masonry(targets.map((n) => ({ id: n.id, width: n.w, height: n.h })), { x, y }, maxZ() + 1)
    const byId = new Map(laid.map((l) => [l.itemId, l]))
    apply(list.map((n) => (byId.has(n.id) ? { ...n, x: byId.get(n.id)!.x, y: byId.get(n.id)!.y, w: byId.get(n.id)!.w, h: byId.get(n.id)!.h, rotation: 0 } : n)))
    requestAnimationFrame(() => fit())
  }

  const removeSelected = () => {
    if (!selected.size) return
    apply(nodesRef.current.filter((n) => !selected.has(n.id) || n.locked))
    setSelected(new Set())
  }

  const duplicate = () => {
    const copies = nodesRef.current.filter((n) => selected.has(n.id)).map((n, i) => ({ ...n, id: newNodeId(), x: n.x + 30, y: n.y + 30, z: maxZ() + 1 + i, locked: false }))
    if (!copies.length) return
    apply([...nodesRef.current, ...copies])
    setSelected(new Set(copies.map((c) => c.id)))
  }

  const copySelected = async (cut = false) => {
    const all = nodesRef.current
    const frames = all.filter((f) => selected.has(f.id) && f.type === 'frame')
    // A copied frame takes along everything lying entirely inside it (as dragging it does).
    const picked = all.filter((n) => selected.has(n.id) || frames.some((f) => n.id !== f.id && n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h))
    if (!picked.length) return
    try {
      await api.boardCopyNodes(boardId, picked)
      if (cut) {
        const gone = new Set(picked.filter((n) => !n.locked).map((n) => n.id))
        apply(all.filter((n) => !gone.has(n.id)))
        setSelected(new Set())
      }
      flash(`${cut ? 'Вырезано' : 'Скопировано'} — можно вставить в Miro с раскладкой (Ctrl+V)`)
    } catch (e) {
      flash(errText(e))
    }
  }

  /** Ctrl+V: copied board nodes keep their layout, centred on `at`; otherwise an image from the clipboard. */
  const paste = async (at = center()) => {
    const r = await api.boardPaste().catch((e) => (flash(errText(e)), undefined))
    if (r === undefined) return
    if (!r) return flash('В буфере нет картинки')
    if ('id' in r) return addItems([r.id], at)
    const xs = r.nodes.map((n) => [n.x, n.x + n.w])
    const ys = r.nodes.map((n) => [n.y, n.y + n.h])
    const dx = at.x - (Math.min(...xs.flat()) + Math.max(...xs.flat())) / 2
    const dy = at.y - (Math.min(...ys.flat()) + Math.max(...ys.flat())) / 2
    const top = maxZ() + 1
    const copies = [...r.nodes].sort((a, b) => a.z - b.z).map((n, i) => ({ ...n, id: newNodeId(), x: n.x + dx, y: n.y + dy, z: top + i, locked: false }))
    apply([...nodesRef.current, ...copies])
    setSelected(new Set(copies.map((c) => c.id)))
  }

  /** z-order: one step up/down among the nodes, or all the way. */
  const restack = (mode: 'up' | 'down' | 'top' | 'bottom') => {
    const list = [...nodesRef.current].sort((a, b) => a.z - b.z)
    if (mode === 'top') return patch(selected, () => ({ z: maxZ() + 1 }))
    if (mode === 'bottom') return patch(selected, () => ({ z: minZ() - 1 }))
    const order = list.map((n) => n.id)
    const idx = (id: string) => order.indexOf(id)
    const sel = order.filter((id) => selected.has(id))
    for (const id of mode === 'up' ? [...sel].reverse() : sel) {
      const i = idx(id)
      const j = mode === 'up' ? i + 1 : i - 1
      if (j < 0 || j >= order.length || selected.has(order[j])) continue
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    const zOf = new Map(order.map((id, k) => [id, k]))
    apply(nodesRef.current.map((n) => ({ ...n, z: zOf.get(n.id)! })))
  }

  // ---------- pointer handling ----------

  const effectiveTool: Tool = spaceDown ? 'pan' : tool

  const onNodeDown = (e: React.PointerEvent, n: BoardNode) => {
    if (e.button !== 0 || editing === n.id || effectiveTool !== 'select') return
    e.stopPropagation()
    let sel = selected
    if (e.shiftKey || e.ctrlKey) {
      sel = new Set(selected)
      sel.has(n.id) ? sel.delete(n.id) : sel.add(n.id)
    } else if (!selected.has(n.id)) sel = new Set([n.id])
    setSelected(sel)
    const movable = nodesRef.current.filter((x) => sel.has(x.id) && !x.locked)
    // Frames carry the nodes that sit entirely inside them.
    for (const f of movable.filter((x) => x.type === 'frame')) {
      for (const x of nodesRef.current) {
        if (x.id !== f.id && !x.locked && x.x >= f.x && x.y >= f.y && x.x + x.w <= f.x + f.w && x.y + x.h <= f.y + f.h && !movable.includes(x)) movable.push(x)
      }
    }
    const orig = new Map(movable.map((x) => [x.id, { x: x.x, y: x.y }]))
    drag.current = { kind: 'move', sx: e.clientX, sy: e.clientY, orig, before: nodesRef.current, moved: false }
    wrap.current!.setPointerCapture(e.pointerId)
  }

  const onHandleDown = (e: React.PointerEvent, n: BoardNode, hx: number, hy: number) => {
    e.stopPropagation()
    const p = toBoard(e.clientX, e.clientY)
    drag.current = { kind: 'resize', n0: n, hx, hy, sx: p.x, sy: p.y, before: nodesRef.current }
    wrap.current!.setPointerCapture(e.pointerId)
  }

  const onRotateDown = (e: React.PointerEvent, n: BoardNode) => {
    e.stopPropagation()
    drag.current = { kind: 'rotate', id: n.id, cx: n.x + n.w / 2, cy: n.y + n.h / 2, before: nodesRef.current }
    wrap.current!.setPointerCapture(e.pointerId)
  }

  const onBgDown = (e: React.PointerEvent) => {
    if (editing) setEditing(null)
    setStickers(false)
    const p = toBoard(e.clientX, e.clientY)
    const t = effectiveTool
    if (e.button === 1 || (e.button === 0 && t === 'pan')) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
    } else if (e.button !== 0) return
    else if (t === 'select') drag.current = { kind: 'marquee', bx: p.x, by: p.y, cx: p.x, cy: p.y, add: e.shiftKey }
    else if (t === 'text') return addText(p)
    else if (t === 'pen' || t === 'marker') drag.current = { kind: 'draw', pts: [[p.x, p.y]], marker: t === 'marker' }
    else drag.current = { kind: 'create', tool: t, bx: snapTo(p.x, snap), by: snapTo(p.y, snap), cx: p.x, cy: p.y }
    wrap.current!.setPointerCapture(e.pointerId)
  }

  /** Builds the node being drawn/created from the current drag state. */
  const draftFrom = (d: Extract<Drag, { kind: 'draw' } | { kind: 'create' }>): BoardNode | null => {
    if (d.kind === 'draw') {
      if (d.pts.length < 2) return null
      const xs = d.pts.map((p) => p[0])
      const ys = d.pts.map((p) => p[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const w = Math.max(1, Math.max(...xs) - x)
      const h = Math.max(1, Math.max(...ys) - y)
      return {
        id: 'draft', type: 'path', x, y, w, h, z: maxZ() + 1, vw: w, vh: h,
        points: d.pts.map(([px, py]) => [px - x, py - y]),
        stroke: opts.color, strokeWidth: d.marker ? Math.max(14, opts.strokeWidth * 4) : opts.strokeWidth, opacity: d.marker ? 0.45 : 1
      }
    }
    const cx = snapTo(d.cx, snap)
    const cy = snapTo(d.cy, snap)
    const x = Math.min(d.bx, cx)
    const y = Math.min(d.by, cy)
    const w = Math.max(1, Math.abs(cx - d.bx))
    const h = Math.max(1, Math.abs(cy - d.by))
    if (d.tool === 'line' || d.tool === 'arrow') {
      return { id: 'draft', type: 'shape', shape: d.tool, x, y, w, h, z: maxZ() + 1, vw: w, vh: h, points: [[d.bx - x, d.by - y], [cx - x, cy - y]], stroke: opts.color, strokeWidth: opts.strokeWidth }
    }
    if (d.tool === 'frame') return { id: 'draft', type: 'frame', x, y, w, h, z: minZ() - 1, name: 'Фрейм' }
    return { id: 'draft', type: 'shape', shape: d.tool === 'ellipse' ? 'ellipse' : 'rect', x, y, w, h, z: maxZ() + 1, stroke: opts.color, strokeWidth: opts.strokeWidth, fill: opts.fill ? `${opts.color}55` : null }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const z = viewRef.current.zoom
    if (d.kind === 'move') {
      const dx = (e.clientX - d.sx) / z
      const dy = (e.clientY - d.sy) / z
      if (!d.moved && Math.hypot(dx * z, dy * z) < 3) return
      d.moved = true
      setNodes(nodesRef.current.map((n) => (d.orig.has(n.id) ? { ...n, x: snapTo(d.orig.get(n.id)!.x + dx, snap), y: snapTo(d.orig.get(n.id)!.y + dy, snap) } : n)))
    } else if (d.kind === 'resize') {
      const p = toBoard(e.clientX, e.clientY)
      setNodes(nodesRef.current.map((n) => (n.id === d.n0.id ? { ...n, ...resized(d, p.x, p.y, e.shiftKey) } : n)))
    } else if (d.kind === 'rotate') {
      const p = toBoard(e.clientX, e.clientY)
      let deg = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90
      if (e.shiftKey) deg = Math.round(deg / 15) * 15
      deg = ((deg % 360) + 360) % 360
      setNodes(nodesRef.current.map((n) => (n.id === d.id ? { ...n, rotation: Math.abs(deg) < 1 || Math.abs(deg - 360) < 1 ? 0 : deg } : n)))
    } else if (d.kind === 'pan') {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }))
    } else if (d.kind === 'marquee') {
      const p = toBoard(e.clientX, e.clientY)
      d.cx = p.x
      d.cy = p.y
      setMarquee({ x: Math.min(d.bx, d.cx), y: Math.min(d.by, d.cy), w: Math.abs(d.cx - d.bx), h: Math.abs(d.cy - d.by) })
    } else if (d.kind === 'draw') {
      const p = toBoard(e.clientX, e.clientY)
      const last = d.pts[d.pts.length - 1]
      if (Math.hypot(p.x - last[0], p.y - last[1]) * z < 2) return
      d.pts.push([p.x, p.y])
      setDraft(draftFrom(d))
    } else if (d.kind === 'create') {
      const p = toBoard(e.clientX, e.clientY)
      d.cx = p.x
      d.cy = p.y
      // Shift: perfect squares / circles / 45° lines.
      if (e.shiftKey) {
        const dx = d.cx - d.bx
        const dy = d.cy - d.by
        if (d.tool === 'line' || d.tool === 'arrow') {
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(dx, dy)
          d.cx = d.bx + Math.cos(a) * len
          d.cy = d.by + Math.sin(a) * len
        } else {
          const m = Math.max(Math.abs(dx), Math.abs(dy))
          d.cx = d.bx + Math.sign(dx || 1) * m
          d.cy = d.by + Math.sign(dy || 1) * m
        }
      }
      setDraft(draftFrom(d))
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'move' && d.moved) apply(nodesRef.current, d.before)
    else if (d.kind === 'resize' || d.kind === 'rotate') apply(nodesRef.current, d.before)
    else if (d.kind === 'pan') {
      if (!d.moved && tool === 'select') setSelected(new Set())
      save()
    } else if (d.kind === 'marquee') {
      const r = { x: Math.min(d.bx, d.cx), y: Math.min(d.by, d.cy), r: Math.max(d.bx, d.cx), b: Math.max(d.by, d.cy) }
      if (r.r - r.x < 3 && r.b - r.y < 3) {
        if (!d.add) setSelected(new Set())
      } else {
        const hit = nodesRef.current.filter((n) => !n.hidden && n.x < r.r && n.x + n.w > r.x && n.y < r.b && n.y + n.h > r.y).map((n) => n.id)
        setSelected((s) => new Set(d.add ? [...s, ...hit] : hit))
      }
      setMarquee(null)
    } else if (d.kind === 'draw' || d.kind === 'create') {
      const node = draftFrom(d)
      setDraft(null)
      if (!node || (d.kind === 'create' && node.w < 4 && node.h < 4)) return
      const { id: _id, z: _z, ...rest } = node
      addNode(rest, d.kind === 'create')
      if (d.kind === 'create') setTool('select')
    }
  }

  // Wheel zooms around the cursor.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.cv-dock, .cv-panel, .cv-bottom, .board-drawer, .cv-props')) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        const zoom = clamp(v.zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM)
        const k = zoom / v.zoom
        return { zoom, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
      })
      save()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [save])

  // ---------- keyboard ----------

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : document.body
      if (t.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.viewer, .modal-backdrop, .pin-panel, .cm-backdrop')) return
      const k = keyOf(e)
      const sel = selected
      if (e.key === ' ') {
        setSpaceDown(true)
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        if (preview) setPreview(false)
        else if (tool !== 'select') setTool('select')
        else setSelected(new Set())
      } else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected()
      else if (e.ctrlKey && k === 'z' && !e.shiftKey) undo()
      else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) redo()
      else if (e.ctrlKey && k === 'a') setSelected(new Set(nodesRef.current.filter((n) => !n.hidden).map((n) => n.id)))
      else if (e.ctrlKey && k === 'd') duplicate()
      else if (e.ctrlKey && k === 'l') sel.size && patch(sel, (n) => ({ locked: !n.locked }))
      else if (e.ctrlKey && e.shiftKey && (e.key === '}' || e.key === ']')) restack('top')
      else if (e.ctrlKey && e.shiftKey && (e.key === '{' || e.key === '[')) restack('bottom')
      else if (e.ctrlKey && e.key === ']') restack('up')
      else if (e.ctrlKey && e.key === '[') restack('down')
      else if (e.ctrlKey && (e.key === '=' || e.key === '+')) zoomBy(1.25)
      else if (e.ctrlKey && e.key === '-') zoomBy(0.8)
      else if (e.ctrlKey && e.key === '0') setView((v) => ({ ...v, zoom: 1 }))
      else if (e.ctrlKey && k === 'c') copySelected()
      else if (e.ctrlKey && k === 'x') copySelected(true)
      else if (e.ctrlKey && k === 'v') paste()
      else if (e.shiftKey && e.key === '!') fit()
      else if (e.shiftKey && k === 'h' && sel.size) patch(sel, (n) => ({ flipX: !n.flipX }))
      else if (e.shiftKey && k === 'v' && sel.size) patch(sel, (n) => ({ flipY: !n.flipY }))
      else if (!e.ctrlKey && !e.altKey && !e.shiftKey && TOOLS.some((x) => x.key.toLowerCase() === k)) setTool(TOOLS.find((x) => x.key.toLowerCase() === k)!.tool)
      else if (!e.ctrlKey && k === 'e') setStickers((s) => !s)
      else if (e.key.startsWith('Arrow') && sel.size) {
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        patch(sel, (n) => (n.locked ? {} : { x: n.x + dx, y: n.y + dy }))
      } else return
      e.preventDefault()
    }
    const onUpKey = (e: KeyboardEvent) => e.key === ' ' && setSpaceDown(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUpKey)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUpKey)
    }
  })

  // ---------- drop ----------

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const at = toBoard(e.clientX, e.clientY)
    const ids = e.dataTransfer.getData(ITEMS_MIME)
    if (ids) return addItems(JSON.parse(ids) as string[], at)
    const paths = droppedPaths(e.dataTransfer)
    if (!paths.length) return
    const before = nodesRef.current
    flash('Добавляю…')
    try {
      await api.boardAddPaths(boardId, paths, at)
      history.current.past.push(before)
      await load(true)
    } catch (err) {
      flash(errText(err))
    }
  }

  // ---------- menus ----------

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      flash('Готовлю…')
      if ((await fn()) !== false) flash(ok)
    } catch (e) {
      flash(errText(e))
    }
  }

  const exportEntries = (onlySel: boolean): MenuEntry[] => [
    { id: 'exp:file', label: onlySel ? 'Экспорт выделенного в PNG…' : 'Экспорт в PNG…', icon: 'export' },
    { id: 'exp:clip', label: 'Скопировать картинкой', icon: 'copy' },
    { id: 'exp:lib', label: 'Сохранить картинкой в библиотеку', icon: 'save' }
  ]
  const runExport = (r: string | null, only?: string[]) => {
    if (r === 'exp:file') run(() => api.exportBoard(boardId, 'file', only), 'Сохранено')
    else if (r === 'exp:clip') run(() => api.exportBoard(boardId, 'clipboard', only), 'Скопировано — вставьте Ctrl+V')
    else if (r === 'exp:lib') run(() => api.exportBoard(boardId, 'library', only), 'Добавлено в библиотеку')
  }

  const nodeMenu = async (e: React.MouseEvent, n: BoardNode) => {
    e.preventDefault()
    e.stopPropagation()
    const sel = selected.has(n.id) ? selected : new Set([n.id])
    if (!selected.has(n.id)) setSelected(sel)
    const r = await api.menu([
      ...(n.itemId
        ? [
            { id: 'open', label: 'Открыть', icon: 'eye' },
            { id: 'locate', label: 'Показать в библиотеке', icon: 'search' },
            { id: 'reveal', label: 'Показать в проводнике', icon: 'folder-open' },
            { type: 'separator' as const }
          ]
        : []),
      ...(n.type === 'text' ? [{ id: 'edit', label: 'Редактировать текст', icon: 'rename' }, { type: 'separator' as const }] : []),
      ...exportEntries(true),
      { type: 'separator' },
      ...(n.itemId ? [{ id: 'palette', label: 'Создать палитру', icon: 'palette' }] : []),
      { id: 'flipx', label: 'Отразить по горизонтали', icon: 'flip-h', shortcut: 'Shift+H' },
      { id: 'flipy', label: 'Отразить по вертикали', icon: 'flip-v', shortcut: 'Shift+V' },
      { type: 'separator' },
      { id: 'lock', label: n.locked ? 'Разблокировать' : 'Заблокировать', icon: n.locked ? 'unlock' : 'lock', shortcut: 'Ctrl+L' },
      { id: 'dup', label: 'Дублировать', icon: 'copy', shortcut: 'Ctrl+D' },
      { id: 'copyid', label: 'Копировать ID', icon: 'id' },
      { type: 'separator' },
      { id: 'up', label: 'Выше', icon: 'arrow-up', shortcut: 'Ctrl+]' },
      { id: 'down', label: 'Ниже', icon: 'arrow-down', shortcut: 'Ctrl+[' },
      { id: 'top', label: 'На передний план', icon: 'to-top', shortcut: 'Ctrl+Shift+]' },
      { id: 'bottom', label: 'На задний план', icon: 'to-bottom', shortcut: 'Ctrl+Shift+[' },
      { type: 'separator' },
      { id: 'remove', label: 'Убрать с доски', icon: 'trash', shortcut: 'Del', danger: true }
    ])
    if (r?.startsWith('exp:')) return runExport(r, [...sel])
    if (r === 'open' && n.itemId) onOpenItem(n.itemId)
    else if (r === 'locate' && n.itemId) onLocateItem(n.itemId)
    else if (r === 'reveal' && n.itemId) api.showInFolder(n.itemId)
    else if (r === 'edit') setEditing(n.id)
    else if (r === 'palette') makePalette(n)
    else if (r === 'flipx') patch(sel, (x) => ({ flipX: !x.flipX }))
    else if (r === 'flipy') patch(sel, (x) => ({ flipY: !x.flipY }))
    else if (r === 'lock') patch(sel, () => ({ locked: !n.locked }))
    else if (r === 'dup') duplicate()
    else if (r === 'copyid') navigator.clipboard.writeText(n.itemId ?? n.id).then(() => flash('ID скопирован'))
    else if (r === 'up' || r === 'down' || r === 'top' || r === 'bottom') restack(r)
    else if (r === 'remove') removeSelected()
  }

  const bgMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const at = toBoard(e.clientX, e.clientY)
    const r = await api.menu([
      { id: 'text', label: 'Добавить текст', icon: 'type', shortcut: 'T' },
      { id: 'image', label: 'Добавить картинку с диска…', icon: 'image' },
      { id: 'paste', label: 'Вставить', icon: 'copy', shortcut: 'Ctrl+V' },
      { type: 'separator' },
      { id: 'all', label: 'Выделить всё', icon: 'cursor', shortcut: 'Ctrl+A' },
      { id: 'arrange', label: 'Разложить аккуратно', icon: 'board' },
      { id: 'fit', label: 'Показать всё', icon: 'home', shortcut: 'Shift+1' },
      { type: 'separator' },
      { id: 'copy', label: 'Сохранить копию доски', icon: 'copy' },
      ...exportEntries(false)
    ])
    if (r?.startsWith('exp:')) return runExport(r)
    if (r === 'text') addText(at)
    else if (r === 'image') api.boardAddFromDialog(boardId, at).then(() => load(true))
    else if (r === 'paste') paste(at)
    else if (r === 'all') setSelected(new Set(nodesRef.current.map((n) => n.id)))
    else if (r === 'arrange') arrange()
    else if (r === 'fit') fit()
    else if (r === 'copy') run(() => api.duplicateBoard(boardId), 'Копия доски создана')
  }

  const sendMenu = async () => {
    const r = await api.menu([
      { label: 'Figma', icon: 'send', submenu: [
        { id: 'figma-svg', label: 'Скопировать слоями (SVG)' },
        { id: 'figma-file', label: 'Сохранить SVG для Figma…' },
        { id: 'figma-png', label: 'Скопировать одной картинкой' },
        { type: 'separator' },
        { id: 'figma-open', label: 'Открыть Figma' }
      ] },
      { label: 'PureRef', icon: 'send', submenu: [
        { id: 'pr-open', label: 'Открыть в PureRef отдельными картинками' },
        { id: 'pr-png', label: 'Скопировать одной картинкой' }
      ] },
      { label: 'Miro', icon: 'send', submenu: [
        { id: 'miro-files', label: '1. Сохранить отдельными картинками' },
        { id: 'miro-arrange', label: '2. Разложить скопированное в Miro' },
        { id: 'miro-png', label: 'Скопировать одной картинкой' },
        { type: 'separator' },
        { id: 'miro-open', label: 'Открыть Miro в браузере' }
      ] }
    ])
    if (r === 'figma-svg') run(() => api.boardSvg(boardId, 'clipboard'), 'SVG скопирован — вставьте в Figma (Ctrl+V)')
    else if (r === 'figma-file') run(() => api.boardSvg(boardId, 'file'), 'SVG сохранён — перетащите его в Figma')
    else if (r === 'figma-open') api.openApp('figma')
    else if (r === 'miro-open') api.openApp('miro')
    else if (r === 'miro-files') run(() => api.miroFiles(boardId), 'Перетащите всё из папки в Miro, там выделите их и нажмите Ctrl+X')
    else if (r === 'miro-arrange') run(() => api.miroArrange(boardId), 'Готово — вставьте в Miro (Ctrl+V)')
    else if (r === 'pr-open') run(() => api.openInPureRef(boardId), 'Открыто в PureRef')
    else if (r?.endsWith('-png')) run(() => api.exportBoard(boardId, 'clipboard'), 'Скопировано — вставьте Ctrl+V')
  }

  // ---------- properties of the selection / current tool ----------

  const selNodes = nodes.filter((n) => selected.has(n.id))
  const styled = selNodes.filter((n) => n.type === 'text' || n.type === 'shape' || n.type === 'path')
  const drawingTool = ['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow', 'text'].includes(tool)
  const showProps = !preview && (drawingTool || styled.length > 0 || selNodes.length > 0)
  const setColor = (c: string) => {
    setOpts((o) => ({ ...o, color: c }))
    if (styled.length) patch(new Set(styled.map((n) => n.id)), (n) => (n.type === 'text' ? { color: c } : { stroke: c, fill: n.fill ? `${c}55` : n.fill }))
  }
  const setStroke = (w: number) => {
    setOpts((o) => ({ ...o, strokeWidth: w }))
    const ids = styled.filter((n) => n.type !== 'text').map((n) => n.id)
    if (ids.length) patch(new Set(ids), (n) => ({ strokeWidth: n.opacity !== undefined && n.opacity < 1 ? Math.max(14, w * 4) : w }))
  }
  const setFill = (on: boolean) => {
    setOpts((o) => ({ ...o, fill: on }))
    const ids = styled.filter((n) => n.type === 'shape' && (n.shape === 'rect' || n.shape === 'ellipse')).map((n) => n.id)
    if (ids.length) patch(new Set(ids), (n) => ({ fill: on ? `${n.stroke ?? opts.color}55` : null }))
  }
  const setFont = (size: number) => {
    setOpts((o) => ({ ...o, fontSize: size }))
    const ids = styled.filter((n) => n.type === 'text').map((n) => n.id)
    if (ids.length) patch(new Set(ids), () => ({ fontSize: size }))
  }

  // ---------- render ----------

  const sorted = [...nodes].filter((n) => !n.hidden).sort((a, b) => a.z - b.z)
  const single = selNodes.length === 1 ? selNodes[0] : null
  const cursor = effectiveTool === 'pan' ? 'grab' : effectiveTool === 'select' ? 'default' : effectiveTool === 'text' ? 'text' : 'crosshair'
  const gridSize = 24 * view.zoom

  return (
    <div
      className={`canvas${preview ? ' preview' : ''}`}
      ref={wrap}
      style={{
        background: bg,
        cursor,
        backgroundImage: grid ? `radial-gradient(rgba(255,255,255,0.09) ${Math.max(0.6, view.zoom)}px, transparent ${Math.max(0.6, view.zoom)}px)` : 'none',
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${view.x}px ${view.y}px`
      }}
      onPointerDown={onBgDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={bgMenu}
      onDragEnter={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onDrop={onDrop}
    >
      <div className="board-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        {sorted.map((n) => (
          <NodeView
            key={n.id}
            node={n}
            item={n.itemId ? items.get(n.itemId) : undefined}
            zoom={view.zoom}
            selected={!preview && selected.has(n.id)}
            editing={editing === n.id}
            onDown={onNodeDown}
            onMenu={nodeMenu}
            onOpen={() => (n.type === 'text' ? setEditing(n.id) : n.itemId && onOpenItem(n.itemId))}
            onMeasure={(h) => {
              // Text grows with its content; keep the stored height in sync without an undo step.
              const next = nodesRef.current.map((x) => (x.id === n.id ? { ...x, h } : x))
              setNodes(next)
              nodesRef.current = next
              save()
            }}
            onTextDone={(text) => {
              setEditing(null)
              const cur = nodesRef.current.find((x) => x.id === n.id)
              if (!cur) return
              if (!text.trim()) return apply(nodesRef.current.filter((x) => x.id !== n.id))
              if (text !== cur.text) apply(nodesRef.current.map((x) => (x.id === n.id ? { ...x, text } : x)))
            }}
          />
        ))}
        {draft && <NodeView node={draft} zoom={view.zoom} selected={false} editing={false} onDown={() => {}} onMenu={() => {}} onOpen={() => {}} onTextDone={() => {}} onMeasure={() => {}} />}
        {!preview && single && editing !== single.id && (
          <SelectionBox node={single} zoom={view.zoom} onHandle={onHandleDown} onRotate={onRotateDown} />
        )}
        {!preview && selNodes.length > 1 && <GroupBox nodes={selNodes} zoom={view.zoom} />}
        {marquee && <div className="board-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / view.zoom }} />}
      </div>

      {loaded && !nodes.length && (
        <div className="board-empty">
          <div className="grid-empty-title">Пустой холст</div>
          <div className="muted">Перетащите картинки из «Ассетов» справа или с диска, вставьте Ctrl+V, рисуйте инструментами слева.</div>
        </div>
      )}

      {!preview && (
        <>
          {/* left: tools */}
          <div className="cv-dock cv-left" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cv-grip" />
            {TOOLS.map((t, i) => (
              <span key={t.tool} style={{ display: 'contents' }}>
                {(i === 2 || i === 5 || i === 9) && <div className="cv-sep" />}
                <button className={`cv-btn${tool === t.tool ? ' on' : ''}`} title={`${t.label} (${t.key})`} onClick={() => setTool(t.tool)}>
                  <Icon name={t.icon} size={18} />
                </button>
              </span>
            ))}
            <div className="cv-sep" />
            <button className={`cv-btn${stickers ? ' on' : ''}`} title="Стикеры (E)" onClick={() => setStickers((s) => !s)}>
              <Icon name="sticker" size={18} />
            </button>
            <button className="cv-btn" title="Картинка с диска" onClick={() => api.boardAddFromDialog(boardId, center()).then(() => load(true))}>
              <Icon name="image" size={18} />
            </button>
            {stickers && (
              <div className="cv-stickers">
                {STICKER_ICONS.map(([icon, color]) => (
                  <button key={icon} style={{ background: color }} onClick={() => addSticker(icon, color)}>
                    <Icon name={icon} size={17} strokeWidth={2} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* right: board */}
          <div className="cv-dock cv-right" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cv-grip" />
            <button className={`cv-btn${drawer ? ' on' : ''}`} title="Ассеты библиотеки" onClick={() => setDrawer((d) => !d)}>
              <Icon name="board" size={18} />
            </button>
            <button className={`cv-btn${panel === 'layers' ? ' on' : ''}`} title="Слои" onClick={() => setPanel((p) => (p === 'layers' ? null : 'layers'))}>
              <Icon name="library" size={18} />
            </button>
            <button className={`cv-btn${panel === 'settings' ? ' on' : ''}`} title="Настройки холста" onClick={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}>
              <Icon name="settings" size={18} />
            </button>
            <button className={`cv-btn${panel === 'keys' ? ' on' : ''}`} title="Горячие клавиши" onClick={() => setPanel((p) => (p === 'keys' ? null : 'keys'))}>
              <Icon name="keyboard" size={18} />
            </button>
            <div className="cv-sep" />
            <button className="cv-btn" title="Сохранить копию доски" onClick={() => run(() => api.duplicateBoard(boardId), 'Копия доски создана')}>
              <Icon name="copy" size={18} />
            </button>
            <button className="cv-btn" title="Сохранить картинкой в библиотеку" onClick={() => run(() => api.exportBoard(boardId, 'library'), 'Добавлено в библиотеку')}>
              <Icon name="save" size={18} />
            </button>
            <button className="cv-btn" title="Экспорт" onClick={async () => runExport(await api.menu(exportEntries(false)))}>
              <Icon name="export" size={18} />
            </button>
            <button className="cv-btn accent" title="Отправить в Figma / PureRef / Miro" onClick={sendMenu}>
              <Icon name="send" size={18} />
            </button>
            <span
              className="cv-btn"
              draggable
              title="Перетащите в PureRef, Figma или Miro — картинки доски отдельными файлами"
              onDragStart={(e) => {
                e.preventDefault()
                const ids = [...new Set(nodesRef.current.filter((n) => n.itemId && items.has(n.itemId)).map((n) => n.itemId!))]
                if (ids.length) api.startDrag(ids)
              }}
            >
              <Icon name="external" size={18} />
            </span>
          </div>

          {panel && (
            <div className="cv-panel" onPointerDown={(e) => e.stopPropagation()}>
              {panel === 'layers' && (
                <LayersPanel
                  nodes={nodes}
                  items={items}
                  selected={selected}
                  onSelect={(id, add) => setSelected((s) => (add ? new Set([...s, id]) : new Set([id])))}
                  onToggle={(id, key) => patch(new Set([id]), (n) => ({ [key]: !n[key] }))}
                  onRestack={restack}
                />
              )}
              {panel === 'settings' && (
                <div className="cv-settings">
                  <div className="insp-label">Фон холста</div>
                  <div className="cv-colors">
                    {['#1a1b1f', '#121316', '#26272d', '#3a3b40', '#f4f4f2', '#ffffff', '#efe6d8', '#1e2433'].map((c) => (
                      <button key={c} className={`cv-color${bg === c ? ' on' : ''}`} style={{ background: c }} onClick={() => (setBg(c), (settingsRef.current.bg = c), save())} />
                    ))}
                    <input type="color" value={bg} onChange={(e) => (setBg(e.target.value), (settingsRef.current.bg = e.target.value), save())} />
                  </div>
                  <label className="check-row">
                    <input type="checkbox" checked={grid} onChange={(e) => (setGrid(e.target.checked), (settingsRef.current.grid = e.target.checked), save())} />
                    Точечная сетка
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={snap} onChange={(e) => (setSnap(e.target.checked), (settingsRef.current.snap = e.target.checked), save())} />
                    Привязка к сетке
                  </label>
                </div>
              )}
              {panel === 'keys' && <KeysPanel />}
            </div>
          )}

          {showProps && (
            <div className="cv-props" onPointerDown={(e) => e.stopPropagation()}>
              {(drawingTool || styled.length > 0) && (
                <>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      className={`cv-color${opts.color === c ? ' on' : ''}`}
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                  <input type="color" value={opts.color} onChange={(e) => setColor(e.target.value)} title="Свой цвет" />
                  <div className="cv-sep v" />
                </>
              )}
              {(['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow'].includes(tool) || styled.some((n) => n.type !== 'text')) &&
                STROKES.map(([label, w]) => (
                  <button key={w} className={`cv-chip${opts.strokeWidth === w ? ' on' : ''}`} title={label} onClick={() => setStroke(w)}>
                    <span style={{ height: Math.max(1, w / 1.5), width: 16, background: 'currentColor', borderRadius: 4, display: 'block' }} />
                  </button>
                ))}
              {(['rect', 'ellipse'].includes(tool) || styled.some((n) => n.shape === 'rect' || n.shape === 'ellipse')) && (
                <button className={`cv-chip${opts.fill ? ' on' : ''}`} onClick={() => setFill(!opts.fill)} title="Заливка">
                  Заливка
                </button>
              )}
              {(tool === 'text' || styled.some((n) => n.type === 'text')) && (
                <>
                  {FONT_SIZES.map(([label, size]) => (
                    <button key={label} className={`cv-chip${opts.fontSize === size ? ' on' : ''}`} onClick={() => setFont(size)}>
                      {label}
                    </button>
                  ))}
                  {styled.some((n) => n.type === 'text') &&
                    (['left', 'center', 'right'] as const).map((a) => (
                      <button
                        key={a}
                        className={`cv-chip${single?.align === a || (!single?.align && a === 'left') ? ' on' : ''}`}
                        onClick={() => patch(new Set(styled.filter((n) => n.type === 'text').map((n) => n.id)), () => ({ align: a }))}
                      >
                        <Icon name={`align-${a}`} size={14} />
                      </button>
                    ))}
                </>
              )}
              {selNodes.length > 0 && (
                <label className="cv-opacity" title="Непрозрачность">
                  <Icon name="eye" size={14} />
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={single?.opacity ?? 1}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      const next = nodesRef.current.map((n) => (selected.has(n.id) ? { ...n, opacity: v } : n))
                      setNodes(next)
                      nodesRef.current = next
                    }}
                    onPointerUp={() => apply(nodesRef.current)}
                  />
                </label>
              )}
            </div>
          )}
        </>
      )}

      {/* bottom status bar */}
      <div className="cv-bottom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="cv-btn sm" title="Показать всё (Shift+1)" onClick={() => fit()}>
          <Icon name="home" size={15} />
        </button>
        <input
          className="cv-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => api.renameBoard(boardId, name)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="cv-sep v" />
        <button className="cv-btn sm" onClick={() => zoomBy(0.8)} title="Отдалить (Ctrl −)">
          <Icon name="minus2" size={15} />
        </button>
        <button className="cv-zoom" onClick={() => setView((v) => ({ ...v, zoom: 1 }))} title="100% (Ctrl+0)">
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="cv-btn sm" onClick={() => zoomBy(1.25)} title="Приблизить (Ctrl +)">
          <Icon name="plus" size={15} />
        </button>
        <span className="cv-sep v" />
        <button className="cv-btn sm" onClick={undo} title="Отменить (Ctrl+Z)" disabled={!history.current.past.length}>
          <Icon name="undo" size={15} />
        </button>
        <button className="cv-btn sm" onClick={redo} title="Повторить (Ctrl+Y)" disabled={!history.current.future.length}>
          <Icon name="redo" size={15} />
        </button>
        <span className="cv-sep v" />
        <span className="cv-count">
          {nodes.length} {nodes.length === 1 ? 'элемент' : nodes.length < 5 && nodes.length > 0 ? 'элемента' : 'элементов'}
          {selected.size > 0 && ` | ${selected.size} выбрано`}
        </span>
        <span className="cv-sep v" />
        <button className={`cv-btn sm${focus ? ' on' : ''}`} onClick={() => onFocus(!focus)} title="Во весь экран (скрыть панели D3S3RT)">
          <Icon name="fullscreen" size={15} />
        </button>
        <button className={`cv-btn sm${preview ? ' on' : ''}`} onClick={() => setPreview((p) => !p)} title="Режим просмотра (Esc — выйти)">
          <Icon name="eye" size={15} />
        </button>
      </div>

      {drawer && !preview && <AssetDrawer onBoard={new Set(nodes.map((n) => n.itemId).filter(Boolean) as string[])} onAdd={(ids) => addItems(ids, center())} onClose={() => setDrawer(false)} version={version} />}
      {toast && <div className="board-toast">{toast}</div>}
    </div>
  )

  /** New geometry for a resize drag; the opposite handle stays put, even for rotated nodes. */
  function resized(d: Extract<Drag, { kind: 'resize' }>, px: number, py: number, shift: boolean): Partial<BoardNode> {
    const n0 = d.n0
    const t = rad(n0.rotation ?? 0)
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    const dx = px - d.sx
    const dy = py - d.sy
    const lx = dx * cos + dy * sin
    const ly = -dx * sin + dy * cos
    const isText = n0.type === 'text'
    const hy = isText ? 0 : d.hy
    let w = Math.max(isText ? 60 : 8, n0.w + d.hx * lx)
    let h = Math.max(8, n0.h + hy * ly)
    const keep = (['item', 'sticker', 'palette'].includes(n0.type) ? !shift : shift) && !isText
    if (keep) {
      const ar = n0.w / n0.h
      if (d.hx && hy) {
        if (Math.abs(w / n0.w) > Math.abs(h / n0.h)) h = w / ar
        else w = h * ar
      } else if (d.hx) h = w / ar
      else if (hy) w = h * ar
    }
    if (isText) h = n0.h
    const c0x = n0.x + n0.w / 2
    const c0y = n0.y + n0.h / 2
    const fx = (-d.hx * n0.w) / 2
    const fy = (-hy * n0.h) / 2
    const fixedX = c0x + fx * cos - fy * sin
    const fixedY = c0y + fx * sin + fy * cos
    const ox = (d.hx * w) / 2
    const oy = (hy * h) / 2
    const cx = d.hx || hy ? fixedX + ox * cos - oy * sin : c0x
    const cy = d.hx || hy ? fixedY + ox * sin + oy * cos : c0y
    return { x: cx - w / 2, y: cy - h / 2, w, h }
  }
}

// ---------- a node ----------

interface NodeProps {
  node: BoardNode
  item?: ItemLite
  zoom: number
  selected: boolean
  editing: boolean
  onDown(e: React.PointerEvent, n: BoardNode): void
  onMenu(e: React.MouseEvent, n: BoardNode): void
  onOpen(): void
  onTextDone(text: string): void
  onMeasure(h: number): void
}

const NodeView = memo(function NodeView({ node: n, item, zoom, selected, editing, onDown, onMenu, onOpen, onTextDone, onMeasure }: NodeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const style: React.CSSProperties = {
    left: n.x,
    top: n.y,
    width: n.w,
    height: n.type === 'text' ? undefined : n.h,
    zIndex: n.z,
    opacity: n.opacity ?? 1,
    transform: `rotate(${n.rotation ?? 0}deg) scale(${n.flipX ? -1 : 1}, ${n.flipY ? -1 : 1})`,
    outlineWidth: selected ? 1.5 / zoom : 0
  }

  useLayoutEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      document.getSelection()?.selectAllChildren(ref.current)
    }
  }, [editing])

  useLayoutEffect(() => {
    if (n.type !== 'text' || !ref.current || n.id === 'draft') return
    const h = ref.current.offsetHeight
    if (Math.abs(h - n.h) > 1) onMeasure(h)
  })

  const common = {
    onPointerDown: (e: React.PointerEvent) => onDown(e, n),
    onDoubleClick: onOpen,
    onContextMenu: (e: React.MouseEvent) => onMenu(e, n)
  }

  if (n.type === 'text') {
    return (
      <div
        ref={ref}
        className={`bnode btext${selected ? ' selected' : ''}`}
        style={{ ...style, fontSize: n.fontSize ?? 22, color: n.color ?? '#e8e9ee', textAlign: n.align ?? 'left' }}
        contentEditable={editing}
        suppressContentEditableWarning
        {...common}
        onPointerDown={(e) => (editing ? e.stopPropagation() : onDown(e, n))}
        onBlur={(e) => editing && onTextDone(e.currentTarget.innerText)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLElement).blur()
        }}
      >
        {n.text}
      </div>
    )
  }

  if (n.type !== 'item') {
    return <div className={`bnode bsvg b-${n.type}${selected ? ' selected' : ''}`} style={style} {...common} dangerouslySetInnerHTML={{ __html: nodeSvg(n) }} />
  }

  // Thumbnails are 640px; switch to the original when the node is shown larger than that.
  const big = n.w * zoom > 600 && item?.kind === 'image' && BROWSER_IMAGE.has(item.ext)
  const src = !item ? null : big ? fileUrl(item.id) : item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : null
  return (
    <div
      className={`bnode bitem${selected ? ' selected' : ''}`}
      style={style}
      {...common}
      onMouseEnter={() => item?.kind === 'video' && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <div className="tile-ph">{item ? item.ext.toUpperCase() : 'Файл удалён'}</div>}
      {hover && item?.kind === 'video' && <video className="tile-hover" src={fileUrl(item.id)} muted autoPlay loop playsInline />}
    </div>
  )
})

// ---------- selection chrome ----------

const HANDLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
const CURSORS: Record<string, string> = { '-1,-1': 'nwse-resize', '1,1': 'nwse-resize', '1,-1': 'nesw-resize', '-1,1': 'nesw-resize', '0,-1': 'ns-resize', '0,1': 'ns-resize', '1,0': 'ew-resize', '-1,0': 'ew-resize' }

function SelectionBox({ node: n, zoom, onHandle, onRotate }: { node: BoardNode; zoom: number; onHandle(e: React.PointerEvent, n: BoardNode, hx: number, hy: number): void; onRotate(e: React.PointerEvent, n: BoardNode): void }) {
  const s = 10 / zoom
  const handles = n.type === 'text' ? HANDLES.filter(([, y]) => y === 0) : HANDLES
  return (
    <div className="sel-box" style={{ left: n.x, top: n.y, width: n.w, height: n.h, transform: `rotate(${n.rotation ?? 0}deg)`, borderWidth: 1.5 / zoom, zIndex: 999999 }}>
      {n.locked ? (
        <div className="sel-lock" style={{ top: -24 / zoom, transform: `scale(${1 / zoom})`, transformOrigin: '0 100%' }}>
          <Icon name="lock" size={15} />
        </div>
      ) : (
        <>
          <div className="sel-stem" style={{ height: 22 / zoom, top: -22 / zoom, width: 1.5 / zoom }} />
          <div className="sel-rot" style={{ width: s * 1.4, height: s * 1.4, top: -22 / zoom - s * 0.7, marginLeft: -s * 0.7, borderWidth: 1.5 / zoom }} onPointerDown={(e) => onRotate(e, n)} />
          {handles.map(([hx, hy]) => (
            <div
              key={`${hx},${hy}`}
              className="sel-handle"
              style={{ width: s, height: s, left: `calc(${(hx + 1) * 50}% - ${s / 2}px)`, top: `calc(${(hy + 1) * 50}% - ${s / 2}px)`, borderWidth: 1.5 / zoom, cursor: CURSORS[`${hx},${hy}`] }}
              onPointerDown={(e) => onHandle(e, n, hx, hy)}
            />
          ))}
        </>
      )}
    </div>
  )
}

function GroupBox({ nodes, zoom }: { nodes: BoardNode[]; zoom: number }) {
  const x = Math.min(...nodes.map((n) => n.x))
  const y = Math.min(...nodes.map((n) => n.y))
  const w = Math.max(...nodes.map((n) => n.x + n.w)) - x
  const h = Math.max(...nodes.map((n) => n.y + n.h)) - y
  return <div className="sel-box group" style={{ left: x, top: y, width: w, height: h, borderWidth: 1.5 / zoom, zIndex: 999999 }} />
}

// ---------- side panels ----------

const LAYER_ICON: Record<string, string> = { item: 'image', text: 'type', shape: 'square', path: 'pencil', palette: 'palette', sticker: 'sticker', frame: 'frame' }

function LayersPanel({
  nodes,
  items,
  selected,
  onSelect,
  onToggle,
  onRestack
}: {
  nodes: BoardNode[]
  items: Map<string, ItemLite>
  selected: Set<string>
  onSelect(id: string, add: boolean): void
  onToggle(id: string, key: 'hidden' | 'locked'): void
  onRestack(mode: 'up' | 'down'): void
}) {
  const label = (n: BoardNode) =>
    n.type === 'item'
      ? items.get(n.itemId!)?.name ?? 'Файл'
      : n.type === 'text'
        ? (n.text ?? '').slice(0, 30) || 'Текст'
        : n.type === 'shape'
          ? { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия', arrow: 'Стрелка' }[n.shape ?? 'rect']
          : n.type === 'path'
            ? 'Рисунок'
            : n.type === 'palette'
              ? 'Палитра'
              : n.type === 'sticker'
                ? 'Стикер'
                : n.name ?? 'Фрейм'
  return (
    <div className="cv-layers">
      <div className="cv-panel-head">
        <span>Слои</span>
        <span>
          <button className="cv-btn sm" title="Выше" onClick={() => onRestack('up')}>
            <Icon name="arrow-up" size={14} />
          </button>
          <button className="cv-btn sm" title="Ниже" onClick={() => onRestack('down')}>
            <Icon name="arrow-down" size={14} />
          </button>
        </span>
      </div>
      <div className="cv-layer-list">
        {[...nodes]
          .sort((a, b) => b.z - a.z)
          .map((n) => (
            <div key={n.id} className={`cv-layer${selected.has(n.id) ? ' on' : ''}${n.hidden ? ' hidden' : ''}`} onClick={(e) => onSelect(n.id, e.shiftKey || e.ctrlKey)}>
              <Icon name={LAYER_ICON[n.type]} size={14} />
              <span className="cv-layer-name">{label(n)}</span>
              <button className="cv-mini" title={n.hidden ? 'Показать' : 'Скрыть'} onClick={(e) => (e.stopPropagation(), onToggle(n.id, 'hidden'))}>
                <Icon name={n.hidden ? 'minus2' : 'eye'} size={13} />
              </button>
              <button className="cv-mini" title={n.locked ? 'Разблокировать' : 'Заблокировать'} onClick={(e) => (e.stopPropagation(), onToggle(n.id, 'locked'))}>
                <Icon name={n.locked ? 'lock' : 'unlock'} size={13} />
              </button>
            </div>
          ))}
        {!nodes.length && <div className="muted" style={{ padding: 10 }}>Слоёв пока нет</div>}
      </div>
    </div>
  )
}

function KeysPanel() {
  const rows: [string, string][] = [
    ['V / H', 'Выделение / перемещение'],
    ['Пробел + тянуть', 'Двигать холст'],
    ['T', 'Текст'],
    ['P / M', 'Карандаш / маркер'],
    ['R / O', 'Прямоугольник / эллипс'],
    ['L / A', 'Линия / стрелка'],
    ['F', 'Фрейм'],
    ['E', 'Стикеры'],
    ['Shift при рисовании', 'Квадрат, круг, 45°'],
    ['Shift при повороте', 'Шаг 15°'],
    ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'],
    ['Ctrl+D', 'Дублировать'],
    ['Ctrl+L', 'Заблокировать'],
    ['Shift+H / Shift+V', 'Отразить'],
    ['Ctrl+] / Ctrl+[', 'Выше / ниже'],
    ['Ctrl+C / Ctrl+X', 'Копировать / вырезать'],
    ['Ctrl+V', 'Вставить'],
    ['Shift+1', 'Показать всё'],
    ['Ctrl+0', 'Масштаб 100%'],
    ['Колесо', 'Масштаб'],
    ['Del', 'Удалить']
  ]
  return (
    <div className="cv-keys">
      <div className="cv-panel-head">
        <span>Горячие клавиши</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="cv-key-row">
          <span className="kbd">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- asset drawer ----------

function AssetDrawer({ onBoard, onAdd, onClose, version }: { onBoard: Set<string>; onAdd(ids: string[]): void; onClose(): void; version: number }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<ItemLite[]>([])
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .query({ scope: { type: 'all' }, search: q, kind: 'all', sort: 'added', desc: true, color: null, filters: NO_FILTERS, seed: 1 })
        .then((rows) => setList(rows.filter((r) => r.kind !== 'other').slice(0, 400)))
    }, 150)
    return () => clearTimeout(t)
  }, [q, version])

  return (
    <div className="board-drawer" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="board-drawer-head">
        <input autoFocus placeholder="Поиск по библиотеке…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn small" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="muted board-drawer-tip">Перетащите на холст или нажмите +</div>
      <div className="board-drawer-grid">
        {list.map((it) => (
          <div
            key={it.id}
            className={`drawer-cell${onBoard.has(it.id) ? ' on' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ITEMS_MIME, JSON.stringify([it.id]))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            title={it.name}
          >
            {it.thumb === 1 ? <img src={thumbUrl(it.id, it.thumbV)} alt="" draggable={false} /> : <div className="tile-ph">{it.ext.toUpperCase()}</div>}
            <button className="drawer-add" onClick={() => onAdd([it.id])} title="Добавить на холст">
              <Icon name={onBoard.has(it.id) ? 'check' : 'plus'} size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
