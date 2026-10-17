import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardData, BoardNode, ItemLite, MenuEntry, TextRun } from '../../../shared/types'
import { NO_FILTERS } from '../../../shared/types'
import { masonry, newNodeId } from '../../../shared/boardLayout'
import { nodeSvg, PALETTE_W, paletteHeight, sameStyle, textFont } from '../../../shared/boardSvg'
import { api, droppedPaths, fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, clamp, itemsLabel, keyOf, loadPref, plural, savePref } from '../util'
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

type SideTab = 'props' | 'layers' | 'assets'

type Drag =
  | { kind: 'move'; sx: number; sy: number; orig: Map<string, { x: number; y: number }>; before: BoardNode[]; moved: boolean }
  | { kind: 'resize'; n0: BoardNode; hx: number; hy: number; sx: number; sy: number; before: BoardNode[] }
  | { kind: 'rotate'; id: string; cx: number; cy: number; before: BoardNode[] }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'marquee'; bx: number; by: number; cx: number; cy: number; add: boolean }
  | { kind: 'draw'; pts: [number, number][]; marker: boolean }
  | { kind: 'create'; tool: Tool; bx: number; by: number; cx: number; cy: number }
  | { kind: 'textbox'; bx: number; by: number; cx: number; cy: number }

interface ToolOpts {
  color: string
  strokeWidth: number
  fill: boolean
  fontSize: number
  /** Font for new text; unset = default. */
  font?: string
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
  /** Where the click that started text editing was (the caret goes there). */
  const editCaret = useRef<{ x: number; y: number } | null>(null)
  const startEditing = (id: string, at: { x: number; y: number } | null) => {
    editCaret.current = at
    setEditing(id)
  }
  /** Last pointer-down on a node: double-clicks are spotted here, as the canvas captures the pointer. */
  const lastDown = useRef({ id: '', t: 0 })
  const [tool, setTool] = useState<Tool>('select')
  const [opts, setOpts] = useState<ToolOpts>({ color: '#e8c547', strokeWidth: 4, fill: false, fontSize: 22 })
  /** Right side panel: open/closed and which tab; remembered between sessions. */
  const [side, setSide] = useState<{ open: boolean; tab: SideTab }>(() => loadPref('board.side', { open: true, tab: 'props' as SideTab }))
  useEffect(() => savePref('board.side', side), [side])
  const [stickers, setStickers] = useState(false)
  const [preview, setPreview] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [draft, setDraft] = useState<BoardNode | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** Copy progress / "ready to paste" card, separate from the short toasts. */
  const [copyNote, setCopyNote] = useState<{ busy: boolean; title: string } | null>(null)
  const copyNoteTimer = useRef<number | undefined>(undefined)
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

  /** New text, as in Figma: a click gives auto-width text, a drag a fixed-width box; typing starts at once. */
  const addText = (at = center(), width?: number) => {
    const node = addNode({
      type: 'text',
      x: at.x,
      y: width ? at.y : at.y - opts.fontSize * 0.65,
      w: width ?? opts.fontSize,
      h: opts.fontSize * 1.3,
      text: '',
      fontSize: opts.fontSize,
      font: opts.font,
      color: opts.color === '#1b1c20' ? '#f1f2f5' : opts.color,
      autoWidth: !width
    })
    startEditing(node.id, null)
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

  /** Ctrl+C / Ctrl+X of the selection — or of the whole board (Send → copy board). */
  const copySelected = async (cut = false, whole = false) => {
    const all = nodesRef.current
    const frames = all.filter((f) => selected.has(f.id) && f.type === 'frame')
    // A copied frame takes along everything lying entirely inside it (as dragging it does).
    const picked = whole
      ? all.filter((n) => !n.hidden)
      : all.filter((n) => selected.has(n.id) || frames.some((f) => n.id !== f.id && n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h))
    if (!picked.length) return
    try {
      window.clearTimeout(copyNoteTimer.current)
      setCopyNote({ busy: true, title: cut ? 'Вырезаю…' : 'Копирую…' })
      await api.boardCopyNodes(boardId, picked)
      if (cut) {
        const gone = new Set(picked.filter((n) => !n.locked).map((n) => n.id))
        apply(all.filter((n) => !gone.has(n.id)))
        setSelected(new Set())
      }
      // The "ready to paste" card comes with boards:copyReady, once Figma's file is built too.
    } catch (e) {
      setCopyNote(null)
      flash(errText(e))
    }
  }

  useEffect(
    () =>
      api.onCopyReady(({ count, frames }) => {
        const what = `${itemsLabel(count)}${frames ? `, ${frames} ${plural(frames, 'фрейм', 'фрейма', 'фреймов')}` : ''}`
        setCopyNote({ busy: false, title: `Скопировано: ${what}` })
        window.clearTimeout(copyNoteTimer.current)
        copyNoteTimer.current = window.setTimeout(() => setCopyNote(null), 4000)
      }),
    []
  )

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
    const now = performance.now()
    const double = lastDown.current.id === n.id && now - lastDown.current.t < 400
    lastDown.current = { id: n.id, t: double ? 0 : now }
    if (double && !e.shiftKey && !e.ctrlKey) {
      // Double-click: edit text with the caret where it was clicked, open pictures.
      if (n.type === 'text' && !n.locked) {
        e.preventDefault()
        setSelected(new Set([n.id]))
        return startEditing(n.id, { x: e.clientX, y: e.clientY })
      }
      if (n.itemId) return onOpenItem(n.itemId)
    }
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
    else if (t === 'text') {
      e.preventDefault() // keeps the new text's focus
      drag.current = { kind: 'textbox', bx: p.x, by: p.y, cx: p.x, cy: p.y }
    }
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
    } else if (d.kind === 'textbox') {
      const p = toBoard(e.clientX, e.clientY)
      d.cx = p.x
      d.cy = p.y
      setMarquee({ x: Math.min(d.bx, d.cx), y: Math.min(d.by, d.cy), w: Math.abs(d.cx - d.bx), h: Math.abs(d.cy - d.by) })
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
    } else if (d.kind === 'textbox') {
      setMarquee(null)
      const w = Math.abs(d.cx - d.bx)
      // A real drag sets a fixed width; a click (or a tiny drag) makes auto-width text.
      if (w * viewRef.current.zoom > 12) addText({ x: Math.min(d.bx, d.cx), y: Math.min(d.by, d.cy) }, w)
      else addText({ x: d.bx, y: d.by })
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
      if ((e.target as HTMLElement).closest('.cv-dock, .cv-bottom, .cv-props')) return
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
      if (editing) return
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
      } else if (e.key === 'Enter' && sel.size === 1) {
        // Enter edits the selected text, as in Figma.
        const n = nodesRef.current.find((x) => sel.has(x.id))
        if (n?.type === 'text' && !n.locked) {
          e.preventDefault()
          startEditing(n.id, null)
        }
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
    else if (r === 'edit') startEditing(n.id, null)
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
      { id: 'copy-board', label: 'Копировать всю доску', icon: 'copy' },
      { type: 'separator' },
      { label: 'Figma', icon: 'send', submenu: [
        { id: 'figma-svg', label: 'Копировать слоями' },
        { id: 'figma-file', label: 'Сохранить SVG-файл…' },
        { type: 'separator' },
        { id: 'figma-open', label: 'Открыть Figma' }
      ] },
      { label: 'Miro', icon: 'send', submenu: [
        { id: 'miro-files', label: 'Сохранить картинки в папку' },
        { type: 'separator' },
        { id: 'miro-open', label: 'Открыть Miro в браузере' }
      ] },
      { label: 'PureRef', icon: 'send', submenu: [{ id: 'pr-open', label: 'Открыть с раскладкой в новом окне' }] },
      { type: 'separator' },
      { id: 'png', label: 'Скопировать одной картинкой', icon: 'image' }
    ])
    if (r === 'copy-board') copySelected(false, true)
    else if (r === 'figma-svg') run(() => api.boardSvg(boardId, 'clipboard'), 'Скопировано — вставьте в Figma (Ctrl+V)')
    else if (r === 'figma-file') run(() => api.boardSvg(boardId, 'file'), 'SVG сохранён — перетащите его в Figma')
    else if (r === 'figma-open') api.openApp('figma')
    else if (r === 'miro-open') api.openApp('miro')
    else if (r === 'miro-files') run(() => api.miroFiles(boardId), 'Папка открыта — перетащите картинки в Miro')
    else if (r === 'pr-open') run(() => api.openInPureRef(boardId), 'Открыто в PureRef')
    else if (r === 'png') run(() => api.exportBoard(boardId, 'clipboard'), 'Скопировано одной картинкой — вставьте Ctrl+V')
  }

  // ---------- properties of the selection / current tool ----------

  const selNodes = nodes.filter((n) => selected.has(n.id))
  const styled = selNodes.filter((n) => n.type === 'text' || n.type === 'shape' || n.type === 'path')
  const drawingTool = ['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow', 'text'].includes(tool)
  const showProps = !preview && (drawingTool || styled.length > 0 || selNodes.length > 0)
  /** A style set on a whole text replaces its pieces' own values of it (as in Figma). */
  const unrun = (n: BoardNode, keys: (keyof TextRun)[]) =>
    n.runs?.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k as keyof TextRun))) as unknown as TextRun)
  const setColor = (c: string) => {
    // Editing with part of the text selected: only that part (and not the style for new text).
    if (editing && styleSelection({ color: c })) return
    setOpts((o) => ({ ...o, color: c }))
    if (styled.length) patch(new Set(styled.map((n) => n.id)), (n) => (n.type === 'text' ? { color: c, runs: unrun(n, ['color']) } : { stroke: c, fill: n.fill ? `${c}55` : n.fill }))
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
    if (editing && styleSelection({ fontSize: size })) return
    setOpts((o) => ({ ...o, fontSize: size }))
    const ids = styled.filter((n) => n.type === 'text').map((n) => n.id)
    if (ids.length) patch(new Set(ids), (n) => ({ fontSize: size, runs: unrun(n, ['fontSize']) }))
  }
  const texts = selNodes.filter((n) => n.type === 'text')
  /** Text style for the selected part while editing, else for the whole selected texts. */
  const patchTexts = (p: Partial<BoardNode>) => {
    const runKeys = (['color', 'font', 'fontSize', 'weight'] as const).filter((k) => k in p)
    if (editing && runKeys.length && styleSelection(Object.fromEntries(runKeys.map((k) => [k, p[k]])))) return
    if (texts.length) patch(new Set(texts.map((n) => n.id)), (n) => ({ ...p, ...(runKeys.length ? { runs: unrun(n, [...runKeys]) } : {}) }))
  }
  /** Font shown on the selected text while browsing the font list (false = no preview). */
  const [fontPreview, setFontPreview] = useState<string | undefined | false>(false)
  /** Font list hover: on the selected part while editing (Photoshop-like), else on the whole text. */
  const previewFont = (f: string | undefined | false) => {
    if (f === false) {
      previewPartFont(false)
      return setFontPreview(false)
    }
    if (editing && previewPartFont(f)) return
    setFontPreview(f)
  }
  /** Font for the selected text and for new text from the tool. */
  const setFontFamily = (font: string | undefined) => {
    if (editing && styleSelection({ font })) return
    setOpts((o) => ({ ...o, font }))
    patchTexts({ font })
  }

  /** Colour / stroke / fill / font controls for the selection or the drawing tool in hand. */
  const styleControls = (compact: boolean) => {
    const strokes = ['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow'].includes(tool) || styled.some((n) => n.type !== 'text')
    const fills = ['rect', 'ellipse'].includes(tool) || styled.some((n) => n.shape === 'rect' || n.shape === 'ellipse')
    const fonts = tool === 'text' || texts.length > 0
    const colors = drawingTool || styled.length > 0
    const current = single?.type === 'text' ? single.color : single?.stroke ?? opts.color
    const row = (title: string, body: React.ReactNode) =>
      compact ? body : (
        <div className="bside-row">
          <div className="bside-label">{title}</div>
          <div className="bside-ctl">{body}</div>
        </div>
      )
    return (
      <>
        {colors &&
          row(
            'Цвет',
            <div className="cv-colors">
              {COLORS.map((c) => (
                <button key={c} className={`cv-color${(current ?? opts.color) === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
              <input type="color" value={current ?? opts.color} onChange={(e) => setColor(e.target.value)} title="Свой цвет" />
            </div>
          )}
        {strokes &&
          row(
            'Обводка',
            <div className="bside-chips">
              {STROKES.map(([label, w]) => (
                <button key={w} className={`cv-chip${(single?.strokeWidth ?? opts.strokeWidth) === w ? ' on' : ''}`} title={label} onClick={() => setStroke(w)}>
                  <span style={{ height: Math.max(1, w / 1.5), width: 18, background: 'currentColor', borderRadius: 4, display: 'block' }} />
                </button>
              ))}
            </div>
          )}
        {fills &&
          row(
            'Заливка',
            <button className={`cv-chip${(single ? !!single.fill : opts.fill) ? ' on' : ''}`} onClick={() => setFill(!(single ? !!single.fill : opts.fill))}>
              {(single ? single.fill : opts.fill) ? 'Есть' : 'Нет'}
            </button>
          )}
        {fonts && (
          <>
            {!compact && row('Шрифт', <FontPicker value={single?.type === 'text' ? single.font : opts.font} onPick={setFontFamily} onPreview={previewFont} />)}
            {row(
              'Размер',
              <div className="bside-chips">
                {!compact && <NumField value={single?.fontSize ?? opts.fontSize} min={6} max={400} onCommit={setFont} />}
                {FONT_SIZES.map(([label, size]) => (
                  <button key={label} className={`cv-chip${(single?.fontSize ?? opts.fontSize) === size ? ' on' : ''}`} onClick={() => setFont(size)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {texts.length > 0 &&
              row(
                'Начертание',
                <div className="bside-chips">
                  {([['Обычный', 400], ['Средний', 600], ['Жирный', 700]] as const).map(([label, w]) => (
                    <button key={w} className={`cv-chip${(single?.weight ?? 600) === w ? ' on' : ''}`} style={{ fontWeight: w }} onClick={() => patchTexts({ weight: w })}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            {texts.length > 0 &&
              row(
                'Выравнивание',
                <div className="bside-chips">
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button key={a} className={`cv-chip${(single?.align ?? 'left') === a ? ' on' : ''}`} onClick={() => patchTexts({ align: a })}>
                      <Icon name={`align-${a}`} size={15} />
                    </button>
                  ))}
                </div>
              )}
            {texts.length > 0 &&
              !compact &&
              row(
                'Ширина',
                <div className="bside-chips">
                  <button className={`cv-chip${single?.autoWidth ? ' on' : ''}`} title="Растёт вместе с текстом" onClick={() => patchTexts({ autoWidth: true })}>
                    Авто
                  </button>
                  <button className={`cv-chip${single && !single.autoWidth ? ' on' : ''}`} title="Фиксированная, строки переносятся" onClick={() => patchTexts({ autoWidth: false })}>
                    Фиксированная
                  </button>
                </div>
              )}
          </>
        )}
      </>
    )
  }

  /** Opacity of the selection: live while dragging, one undo step on release. */
  const opacityControl = () => (
    <label className="cv-opacity" title="Непрозрачность">
      <Icon name="eye" size={15} />
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
      <span className="bside-val">{Math.round((single?.opacity ?? 1) * 100)}%</span>
    </label>
  )

  /** Board-wide actions: in the side panel's footer, or the compact dock when it's hidden. */
  const actionButtons = (
    <>
      <button className="cv-btn" title="Сохранить копию доски" onClick={() => run(() => api.duplicateBoard(boardId), 'Копия доски создана')}>
        <Icon name="copy" size={19} />
      </button>
      <button className="cv-btn" title="Сохранить картинкой в библиотеку" onClick={() => run(() => api.exportBoard(boardId, 'library'), 'Добавлено в библиотеку')}>
        <Icon name="save" size={19} />
      </button>
      <button className="cv-btn" title="Экспорт" onClick={async () => runExport(await api.menu(exportEntries(false)))}>
        <Icon name="export" size={19} />
      </button>
      <button className="cv-btn accent" title="Отправить в Figma / Miro / PureRef" onClick={sendMenu}>
        <Icon name="send" size={19} />
      </button>
      <span
        className="cv-btn"
        draggable
        title="Перетащите в другую программу — картинки доски отдельными файлами"
        onDragStart={(e) => {
          e.preventDefault()
          const ids = [...new Set(nodesRef.current.filter((n) => n.itemId && items.has(n.itemId)).map((n) => n.itemId!))]
          if (ids.length) api.startDrag(ids)
        }}
      >
        <Icon name="external" size={19} />
      </span>
    </>
  )

  /** Side panel "Свойства": the selection, else the tool in hand, else the board. */
  const propsPanel = () => {
    if (!selNodes.length) {
      if (drawingTool) {
        return (
          <div className="bside-section">
            <div className="bside-title">{TOOLS.find((t) => t.tool === tool)?.label}</div>
            {styleControls(false)}
          </div>
        )
      }
      return (
        <>
          <div className="bside-section">
            <div className="bside-title">Холст</div>
            <div className="bside-row">
              <div className="bside-label">Фон</div>
              <div className="bside-ctl cv-colors">
                {['#1a1b1f', '#121316', '#26272d', '#3a3b40', '#f4f4f2', '#ffffff', '#efe6d8', '#1e2433'].map((c) => (
                  <button key={c} className={`cv-color${bg === c ? ' on' : ''}`} style={{ background: c }} onClick={() => (setBg(c), (settingsRef.current.bg = c), save())} />
                ))}
                <input type="color" value={bg} onChange={(e) => (setBg(e.target.value), (settingsRef.current.bg = e.target.value), save())} />
              </div>
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
          <details className="bside-section">
            <summary className="bside-title">Горячие клавиши</summary>
            <KeysPanel />
          </details>
        </>
      )
    }
    const n = single
    const ids = new Set(selNodes.map((x) => x.id))
    const geom = (k: 'x' | 'y' | 'w' | 'h' | 'rotation', v: number) =>
      n && patch(new Set([n.id]), () => ({ [k]: v, ...(n.type === 'text' && k === 'w' ? { autoWidth: false } : {}) }))
    return (
      <>
        <div className="bside-section">
          <div className="bside-title">
            <Icon name={n ? LAYER_ICON[n.type] : 'layers'} size={16} />
            <span className="bside-name">{n ? nodeLabel(n, items) : `Выбрано: ${selNodes.length}`}</span>
          </div>
          {n && (
            <div className="bside-grid">
              <NumField label="X" value={n.x} onCommit={(v) => geom('x', v)} />
              <NumField label="Y" value={n.y} onCommit={(v) => geom('y', v)} />
              <NumField label="Ш" value={n.w} min={1} onCommit={(v) => geom('w', v)} />
              <NumField label="В" value={n.h} min={1} onCommit={(v) => geom('h', v)} disabled={n.type === 'text'} />
              <NumField label="°" value={n.rotation ?? 0} onCommit={(v) => geom('rotation', ((v % 360) + 360) % 360)} />
            </div>
          )}
          {n?.type === 'frame' && (
            <div className="bside-row">
              <div className="bside-label">Название</div>
              <input className="bside-ctl" defaultValue={n.name ?? ''} key={n.id} onBlur={(e) => patch(ids, () => ({ name: e.target.value || 'Фрейм' }))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            </div>
          )}
          {n?.type === 'item' && n.itemId && (
            <div className="bside-chips">
              <button className="cv-chip" onClick={() => onOpenItem(n.itemId!)}>Открыть</button>
              <button className="cv-chip" onClick={() => onLocateItem(n.itemId!)}>В библиотеке</button>
              <button className="cv-chip" onClick={() => makePalette(n)}>Палитра</button>
            </div>
          )}
        </div>
        {(styled.length > 0 || (n && (n.type === 'frame' || n.type === 'sticker'))) && (
          <div className="bside-section">
            <div className="bside-title">{texts.length ? 'Текст' : 'Стиль'}</div>
            {styleControls(false)}
            {n?.type === 'frame' && (
              <div className="bside-row">
                <div className="bside-label">Заливка</div>
                <div className="bside-ctl cv-colors">
                  {['rgba(255,255,255,0.035)', '#26272d', '#3a3b40', '#ffffff', '#efe6d8', '#1e2433'].map((c) => (
                    <button key={c} className={`cv-color${(n.fill ?? 'rgba(255,255,255,0.035)') === c ? ' on' : ''}`} style={{ background: c }} onClick={() => patch(ids, () => ({ fill: c }))} />
                  ))}
                </div>
              </div>
            )}
            {n?.type === 'sticker' && (
              <div className="bside-row">
                <div className="bside-label">Цвет</div>
                <div className="bside-ctl cv-colors">
                  {COLORS.map((c) => (
                    <button key={c} className={`cv-color${n.stroke === c ? ' on' : ''}`} style={{ background: c }} onClick={() => patch(ids, () => ({ stroke: c }))} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="bside-section">
          <div className="bside-title">Слой</div>
          {opacityControl()}
          <div className="bside-chips">
            <button className="cv-chip" title="Отразить по горизонтали (Shift+H)" onClick={() => patch(ids, (x) => ({ flipX: !x.flipX }))}>
              <Icon name="flip-h" size={15} />
            </button>
            <button className="cv-chip" title="Отразить по вертикали (Shift+V)" onClick={() => patch(ids, (x) => ({ flipY: !x.flipY }))}>
              <Icon name="flip-v" size={15} />
            </button>
            <button className="cv-chip" title="Выше (Ctrl+])" onClick={() => restack('up')}>
              <Icon name="arrow-up" size={15} />
            </button>
            <button className="cv-chip" title="Ниже (Ctrl+[)" onClick={() => restack('down')}>
              <Icon name="arrow-down" size={15} />
            </button>
            <button className={`cv-chip${n?.locked ? ' on' : ''}`} title="Заблокировать (Ctrl+L)" onClick={() => patch(ids, (x) => ({ locked: !n?.locked }))}>
              <Icon name={n?.locked ? 'lock' : 'unlock'} size={15} />
            </button>
            <button className="cv-chip" title="Дублировать (Ctrl+D)" onClick={duplicate}>
              <Icon name="copy" size={15} />
            </button>
            <button className="cv-chip danger" title="Удалить (Del)" onClick={removeSelected}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        </div>
      </>
    )
  }

  // ---------- render ----------

  const sorted = [...nodes]
    .filter((n) => !n.hidden)
    .sort((a, b) => a.z - b.z)
    // Font preview: only how it's drawn, nothing is saved until a font is picked.
    .map((n) => (fontPreview !== false && n.type === 'text' && selected.has(n.id) ? { ...n, font: fontPreview } : n))
  const single = selNodes.length === 1 ? selNodes[0] : null
  const cursor = effectiveTool === 'pan' ? 'grab' : effectiveTool === 'select' ? 'default' : effectiveTool === 'text' ? 'text' : 'crosshair'
  const gridSize = 24 * view.zoom

  return (
    <div className="board-shell">
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
            onOpen={() => (n.type === 'text' ? startEditing(n.id, null) : n.itemId && onOpenItem(n.itemId))}
            caret={editing === n.id ? editCaret.current : null}
            onMeasure={(w, h) => {
              // Text grows with its content; keep the stored size in sync without an undo step.
              const next = nodesRef.current.map((x) => (x.id === n.id ? { ...x, h, ...(x.autoWidth ? { w } : {}) } : x))
              setNodes(next)
              nodesRef.current = next
              save()
            }}
            onTextDone={(text, runs) => {
              setEditing(null)
              const cur = nodesRef.current.find((x) => x.id === n.id)
              if (!cur) return
              if (!text.trim()) return apply(nodesRef.current.filter((x) => x.id !== n.id))
              const nextRuns = runs.some((r) => r.color || r.font || r.fontSize || r.weight) ? runs : undefined
              if (text !== cur.text || JSON.stringify(nextRuns) !== JSON.stringify(cur.runs))
                apply(nodesRef.current.map((x) => (x.id === n.id ? { ...x, text, runs: nextRuns } : x)))
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

          {/* right: compact dock while the side panel is hidden */}
          {!side.open && (
            <div className="cv-dock cv-right" onPointerDown={(e) => e.stopPropagation()}>
              <div className="cv-grip" />
              <button className="cv-btn" title="Показать панель" onClick={() => setSide((v) => ({ ...v, open: true }))}>
                <Icon name="panel-right-open" size={20} />
              </button>
              <div className="cv-sep" />
              {actionButtons}
            </div>
          )}

          {/* floating style bar only while the side panel (which has these) is hidden */}
          {showProps && !side.open && (
            <div className="cv-props" onPointerDown={(e) => e.stopPropagation()}>
              {styleControls(true)}
              {selNodes.length > 0 && opacityControl()}
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

      {toast && <div className="board-toast">{toast}</div>}
      {copyNote && (
        <div className={`board-copy-note${copyNote.busy ? ' busy' : ''}`}>
          <Icon name={copyNote.busy ? 'copy' : 'check'} size={22} />
          <div>
            <div className="board-copy-title">{copyNote.title}</div>
            {!copyNote.busy && <div className="board-copy-sub">Ctrl+V — вставить в мудборд, Miro, Figma или PureRef</div>}
          </div>
        </div>
      )}
    </div>

      {/* right: side panel (properties / layers / assets), can be hidden */}
      {!preview && side.open && (
        <aside className="bside" onPointerDown={(e) => e.stopPropagation()}>
          <div className="bside-tabs">
            {(
              [
                ['props', 'Свойства'],
                ['layers', 'Слои'],
                ['assets', 'Ассеты']
              ] as const
            ).map(([t, label]) => (
              <button key={t} className={`bside-tab${side.tab === t ? ' on' : ''}`} onClick={() => setSide((v) => ({ ...v, tab: t }))}>
                {label}
              </button>
            ))}
            <button className="cv-btn sm bside-hide" title="Скрыть панель" onClick={() => setSide((v) => ({ ...v, open: false }))}>
              <Icon name="panel-right-close" size={18} />
            </button>
          </div>
          <div className="bside-body">
            {side.tab === 'props' && propsPanel()}
            {side.tab === 'layers' && (
              <LayersPanel
                nodes={nodes}
                items={items}
                selected={selected}
                onSelect={(id, add) => setSelected((s) => (add ? new Set([...s, id]) : new Set([id])))}
                onToggle={(id, key) => patch(new Set([id]), (n) => ({ [key]: !n[key] }))}
                onRestack={restack}
              />
            )}
            {side.tab === 'assets' && <AssetsPanel onAdd={(ids) => addItems(ids, center())} version={version} />}
          </div>
          <div className="bside-actions">{actionButtons}</div>
        </aside>
      )}
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
    // Dragging a text box's side fixes its width (auto width off), as in Figma.
    return { x: cx - w / 2, y: cy - h / 2, w, h, ...(isText ? { autoWidth: false } : {}) }
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
  onTextDone(text: string, runs: TextRun[]): void
  /** A text node's rendered size changed (height always; width too for auto-width text). */
  onMeasure(w: number, h: number): void
  /** Where the click that started editing was, to put the caret there (null: select all). */
  caret?: { x: number; y: number } | null
}

const NodeView = memo(function NodeView({ node: n, item, zoom, selected, editing, onDown, onMenu, onOpen, onTextDone, onMeasure, caret }: NodeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  /** Text edit already saved (so the end-of-editing effect doesn't save it twice). */
  const committed = useRef(false)
  /** The element being edited: when editing ends from outside it's already swapped for a fresh one. */
  const editEl = useRef<HTMLDivElement | null>(null)
  const finishRef = useRef<() => void>(() => {})
  const wasEditing = useRef(editing)
  useLayoutEffect(() => {
    if (editing && !wasEditing.current) committed.current = false
    // Editing ended from outside (canvas click) while focus sat in the side panel: save now.
    if (!editing && wasEditing.current) {
      finishRef.current()
      editEl.current = null
    }
    wasEditing.current = editing
  }, [editing])
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
    const el = ref.current
    if (!editing || !el) return
    el.focus()
    const sel = document.getSelection()
    // Caret where the double-click was (as in Figma); new or menu-opened text gets everything selected.
    const at = caret && document.caretRangeFromPoint?.(caret.x, caret.y)
    if (sel && at && el.contains(at.startContainer)) {
      sel.removeAllRanges()
      sel.addRange(at)
    } else sel?.selectAllChildren(el)
  }, [editing])

  useLayoutEffect(() => {
    if (n.type !== 'text' || !ref.current || n.id === 'draft') return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    if (Math.abs(h - n.h) > 1 || (n.autoWidth && Math.abs(w - n.w) > 1)) onMeasure(w, h)
  })

  const common = {
    onPointerDown: (e: React.PointerEvent) => onDown(e, n),
    onContextMenu: (e: React.MouseEvent) => onMenu(e, n)
  }

  if (n.type === 'text') {
    // Finishing an edit: on blur (unless focus went to the side panel, e.g. to style the
    // selected part) or when the board ends editing (click on the canvas).
    const finish = () => {
      const el = editEl.current ?? ref.current
      if (committed.current || !el) return
      committed.current = true
      const runs = readRuns(el, n)
      onTextDone(runs.map((r) => r.text).join(''), runs)
    }
    finishRef.current = finish
    return (
      <div
        // A fresh element per mode: React must not reconcile children the user has edited.
        key={editing ? 'edit' : 'view'}
        ref={(el) => {
          ref.current = el
          if (editing && el) editEl.current = el
        }}
        className={`bnode btext${selected ? ' selected' : ''}${n.autoWidth ? ' auto' : ''}`}
        style={{
          ...style,
          width: n.autoWidth ? undefined : n.w,
          fontSize: n.fontSize ?? 22,
          fontWeight: n.weight ?? 600,
          fontFamily: n.font ? textFont(n) : undefined,
          color: n.color ?? '#e8e9ee',
          textAlign: n.align ?? 'left'
        }}
        contentEditable={editing}
        suppressContentEditableWarning
        {...common}
        onPointerDown={(e) => (editing ? e.stopPropagation() : onDown(e, n))}
        onBlur={(e) => {
          if (!editing) return
          const to = e.relatedTarget as Element | null
          if (!to?.closest('.bside')) finish()
        }}
        onPaste={(e) => {
          // Plain text only; styles come from the side panel.
          e.preventDefault()
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
        }}
        onKeyDown={(e) => {
          // Enter makes a new line (as in Figma); Esc or a click outside finishes editing.
          if (e.key === 'Escape') (e.target as HTMLElement).blur()
          else if (e.key === 'Enter') {
            e.preventDefault()
            document.execCommand('insertLineBreak')
          }
          e.stopPropagation()
        }}
      >
        {n.runs?.length
          ? n.runs.map((r, i) => (
              <span key={i} style={runCss(r)}>
                {r.text}
              </span>
            ))
          : n.text}
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

// ---------- rich text ----------

/** Inline style of a text run (unset fields inherit the node's). */
function runCss(r: Partial<TextRun>): React.CSSProperties {
  return {
    color: r.color,
    fontFamily: r.font ? `'${r.font}', 'Segoe UI', Arial, sans-serif` : undefined,
    fontSize: r.fontSize,
    fontWeight: r.weight
  }
}

/** Last selection inside the text being edited — kept while the side panel has the focus. */
let textRange: Range | null = null
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection()
  if (!sel?.rangeCount) return
  const r = sel.getRangeAt(0)
  const at = r.commonAncestorContainer
  if ((at instanceof Element ? at : at.parentElement)?.closest('.btext[contenteditable="true"]')) textRange = r.cloneRange()
})

const toHex = (c: string) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : c
}

/** The edited text back as runs: walks the spans' inline styles; <br> is a line break. */
function readRuns(el: HTMLElement, base: BoardNode): TextRun[] {
  const out: TextRun[] = []
  const push = (text: string, st: Omit<TextRun, 'text'>) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && sameStyle(last, st as TextRun)) last.text += text
    else out.push({ ...st, text })
  }
  const walk = (node: Node, st: Omit<TextRun, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE) return push(node.textContent ?? '', st)
    if (!(node instanceof HTMLElement)) return
    // A trailing <br> only keeps an empty last line visible while typing — it isn't text.
    if (node.tagName === 'BR') return node === el.lastChild || (node.parentElement !== el && node === node.parentElement?.lastChild && node.previousSibling === null) ? undefined : push('\n', st)
    const s = { ...st }
    const cs = node.style
    if (cs.color) s.color = toHex(cs.color)
    const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim()
    if (family && family !== 'undefined') s.font = family
    if (cs.fontSize) s.fontSize = parseFloat(cs.fontSize)
    if (cs.fontWeight) s.weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : undefined)
    // Pasted or browser-made blocks start a new line.
    if (node !== el && /^(DIV|P)$/.test(node.tagName) && out.length && !out[out.length - 1].text.endsWith('\n')) push('\n', st)
    node.childNodes.forEach((c) => walk(c, s))
  }
  el.childNodes.forEach((c) => walk(c, {}))
  // Styles equal to the node's own are dropped; all plain = no runs at all.
  const clean = out.map((r) => ({
    text: r.text,
    color: r.color && r.color !== (base.color ?? '#e8e9ee') ? r.color : undefined,
    font: r.font && r.font !== base.font ? r.font : undefined,
    fontSize: r.fontSize && r.fontSize !== (base.fontSize ?? 22) ? r.fontSize : undefined,
    weight: r.weight && r.weight !== (base.weight ?? 600) ? r.weight : undefined
  }))
  const merged: TextRun[] = []
  for (const r of clean) {
    const last = merged[merged.length - 1]
    if (last && sameStyle(last, r)) last.text += r.text
    else merged.push(r)
  }
  // All in the node's own style: plain text, no runs (the caller joins the text itself).
  return merged.every((r) => !r.color && !r.font && !r.fontSize && !r.weight) ? merged.map((r) => ({ text: r.text })) : merged
}

/** The selected part while a font is being previewed on it: the wrapper shown, the original kept. */
let partPreview: { span: HTMLSpanElement; original: DocumentFragment } | null = null

/**
 * Shows `font` on the selected part of the text being edited, as Photoshop does while browsing
 * fonts; `false` puts the original back. Returns false when there's no selected part.
 */
function previewPartFont(font: string | undefined | false): boolean {
  if (font === false) {
    if (!partPreview) return true
    const { span, original } = partPreview
    partPreview = null
    const nodes = [...original.childNodes]
    if (!span.isConnected || !nodes.length) return true
    span.replaceWith(...nodes)
    const r = document.createRange()
    r.setStartBefore(nodes[0])
    r.setEndAfter(nodes[nodes.length - 1])
    const sel = document.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
    textRange = r.cloneRange()
    return true
  }
  if (!partPreview) {
    const r = textRange
    const at = r?.commonAncestorContainer
    const host = at && (at instanceof Element ? at : at.parentElement)?.closest('.btext[contenteditable="true"]')
    if (!r || r.collapsed || !host) return false
    const original = r.cloneContents()
    const span = document.createElement('span')
    span.appendChild(r.extractContents())
    r.insertNode(span)
    partPreview = { span, original }
  }
  const { span } = partPreview
  span.style.fontFamily = font ? `'${font}', 'Segoe UI', Arial, sans-serif` : ''
  // Inner pieces' own fonts would hide the preview; the original comes back on restore anyway.
  span.querySelectorAll('span').forEach((x) => (x.style.fontFamily = ''))
  return true
}

/**
 * Styles just the selected part of the text being edited (Figma-like mixed styles). Returns false
 * when there's no such selection — then the style goes to the whole text instead.
 */
function styleSelection(p: Partial<TextRun>): boolean {
  const r = textRange
  const at = r?.commonAncestorContainer
  const host = at && (at instanceof Element ? at : at.parentElement)?.closest<HTMLElement>('.btext[contenteditable="true"]')
  if (!r || r.collapsed || !host) return false
  // Only the properties being set (an undefined one would land as the string "undefined").
  const css = Object.fromEntries(Object.entries(runCss(p)).filter(([, v]) => v !== undefined)) as React.CSSProperties
  const span = document.createElement('span')
  Object.assign(span.style, css)
  const frag = r.extractContents()
  // Inner pieces drop the same property so the new value shows.
  frag.querySelectorAll('span').forEach((x) => {
    for (const k of Object.keys(css) as (keyof React.CSSProperties)[]) if (css[k] !== undefined) (x.style as unknown as Record<string, string>)[k] = ''
  })
  span.appendChild(frag)
  r.insertNode(span)
  const next = document.createRange()
  next.selectNodeContents(span)
  host.focus()
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(next)
  textRange = next.cloneRange()
  return true
}

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

/** What a node is called in the layers list and the properties header. */
function nodeLabel(n: BoardNode, items: Map<string, ItemLite>): string {
  if (n.type === 'item') return items.get(n.itemId!)?.name ?? 'Файл'
  if (n.type === 'text') return (n.text ?? '').split('\n')[0].slice(0, 30) || 'Текст'
  if (n.type === 'shape') return { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия', arrow: 'Стрелка' }[n.shape ?? 'rect']
  if (n.type === 'path') return 'Рисунок'
  if (n.type === 'palette') return 'Палитра'
  if (n.type === 'sticker') return 'Стикер'
  return n.name ?? 'Фрейм'
}

let fontsCache: Promise<string[]> | null = null
/** Icon / symbol fonts: their glyphs aren't letters, so their names stay in the UI font. */
const SYMBOL_FONT = /dings|webdings|^symbol$|marlett|mdl2|fluent icons|mt extra|emoji|bookshelf symbol/i
const ownFont = (f: string): React.CSSProperties | undefined => (SYMBOL_FONT.test(f) ? undefined : { fontFamily: `'${f}'` })

/** Font family dropdown: installed fonts, searchable, each name shown in its own font. */
function FontPicker({ value, onPick, onPreview }: { value?: string; onPick(font: string | undefined): void; onPreview(font: string | undefined | false): void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [list, setList] = useState<string[]>([])
  /** Row under the arrow keys: -1 = "default", then the shown fonts. */
  const [active, setActive] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    setQ('')
    setActive(null)
    onPreview(false)
  }
  useEffect(() => {
    if (!open) return
    void (fontsCache ??= api.fonts()).then(setList)
    const out = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && close()
    document.addEventListener('pointerdown', out, true)
    return () => document.removeEventListener('pointerdown', out, true)
  }, [open])
  useEffect(() => () => onPreview(false), [])
  const needle = q.trim().toLowerCase()
  const shown = (needle ? list.filter((f) => f.toLowerCase().includes(needle)) : list).slice(0, 300)
  const first = needle ? 0 : -1
  const fontAt = (i: number) => (i < 0 ? undefined : shown[i])
  const pick = (f: string | undefined) => {
    onPreview(false)
    onPick(f)
    setOpen(false)
    setQ('')
    setActive(null)
  }
  // Arrow keys move through the list and preview on the board, as in Figma.
  const move = (d: number) => {
    const i = Math.max(first, Math.min(shown.length - 1, (active ?? first - (d > 0 ? 1 : 0)) + d))
    setActive(i)
    onPreview(fontAt(i))
    listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div className="font-pick" ref={box}>
      <button className="font-pick-btn" onClick={() => (open ? close() : setOpen(true))}>
        <span style={value ? ownFont(value) : undefined}>{value ?? 'По умолчанию'}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="font-pick-pop">
          <input
            autoFocus
            placeholder="Найти шрифт…"
            value={q}
            onChange={(e) => (setQ(e.target.value), setActive(null), onPreview(false))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') (e.preventDefault(), move(1))
              else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1))
              else if (e.key === 'Enter') {
                if (active !== null) pick(fontAt(active))
                else if (shown[0]) pick(shown[0])
              }
            }}
          />
          {/* Hovering a font shows it on the selected text; leaving the list puts the old one back. */}
          <div className="font-pick-list" ref={listRef} onMouseLeave={() => active === null && onPreview(false)}>
            {!needle && (
              <button data-i={-1} className={`${!value ? 'on' : ''}${active === -1 ? ' active' : ''}`} onMouseEnter={() => onPreview(undefined)} onClick={() => pick(undefined)}>
                <span className="font-pick-name">По умолчанию</span>
              </button>
            )}
            {shown.map((f, i) => (
              // Each name is drawn in its own font, as in Figma (symbol fonts excepted).
              <button
                key={f}
                data-i={i}
                className={`${value === f ? 'on' : ''}${active === i ? ' active' : ''}`}
                onMouseEnter={() => (setActive(null), onPreview(f))}
                onClick={() => pick(f)}
                title={f}
              >
                <span className="font-pick-name" style={ownFont(f)}>
                  {f}
                </span>
              </button>
            ))}
            {!shown.length && <div className="muted font-pick-empty">{list.length ? 'Ничего не найдено' : 'Загружаю шрифты…'}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Number input that commits on Enter / blur (one undo step), like Figma's fields. */
function NumField({ label, value, min, max, disabled, onCommit }: { label?: string; value: number; min?: number; max?: number; disabled?: boolean; onCommit(v: number): void }) {
  const [text, setText] = useState(String(Math.round(value)))
  useEffect(() => setText(String(Math.round(value))), [value])
  const commit = () => {
    const v = Number(text.replace(',', '.'))
    if (!Number.isFinite(v)) return setText(String(Math.round(value)))
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
    if (Math.round(c) !== Math.round(value)) onCommit(c)
    else setText(String(Math.round(value)))
  }
  return (
    <label className={`bside-num${disabled ? ' disabled' : ''}`}>
      {label && <span>{label}</span>}
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') (setText(String(Math.round(value))), (e.target as HTMLInputElement).blur())
        }}
      />
    </label>
  )
}

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
  const label = (n: BoardNode) => nodeLabel(n, items)
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

// ---------- assets tab ----------

/** The library in the side panel: click or drag a picture onto the board; a check flashes on what was just added. */
function AssetsPanel({ onAdd, version }: { onAdd(ids: string[]): void; version: number }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<ItemLite[]>([])
  const [added, setAdded] = useState<Set<string>>(new Set())
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .query({ scope: { type: 'all' }, search: q, kind: 'all', sort: 'added', desc: true, color: null, filters: NO_FILTERS, seed: 1 })
        .then((rows) => setList(rows.filter((r) => r.kind !== 'other').slice(0, 400)))
    }, 150)
    return () => clearTimeout(t)
  }, [q, version])
  const add = (id: string) => {
    onAdd([id])
    setAdded((s) => new Set(s).add(id))
    window.setTimeout(() => setAdded((s) => (s.delete(id), new Set(s))), 1200)
  }

  return (
    <div className="bside-assets" onContextMenu={(e) => e.stopPropagation()}>
      <input className="bside-search" placeholder="Поиск по библиотеке…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="muted bside-tip">Нажмите на картинку или перетащите её на холст</div>
      <div className="board-drawer-grid">
        {list.map((it) => (
          <div
            key={it.id}
            className={`drawer-cell${added.has(it.id) ? ' added' : ''}`}
            draggable
            onClick={() => add(it.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(ITEMS_MIME, JSON.stringify([it.id]))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            title={it.name}
          >
            {it.thumb === 1 ? <img src={thumbUrl(it.id, it.thumbV)} alt="" draggable={false} /> : <div className="tile-ph">{it.ext.toUpperCase()}</div>}
            <span className="drawer-add">
              <Icon name={added.has(it.id) ? 'check' : 'plus'} size={14} strokeWidth={2.5} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
