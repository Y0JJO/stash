import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MenuEntry } from '../../../shared/types'
import { subscribeMenu, type MenuRequest } from '../menu'
import { Icon } from './Icon'

/** Mount once: renders whatever menu `openMenu()` asked for. */
export function ContextMenuHost() {
  const [req, setReq] = useState<MenuRequest | null>(null)
  useEffect(() => subscribeMenu(setReq), [])
  return req ? <MenuRoot key={`${req.x}:${req.y}:${req.entries.length}`} req={req} /> : null
}

interface Level {
  entries: MenuEntry[]
  x: number
  y: number
  /** x of the parent panel's left edge, so a submenu can flip to the left. */
  flipX?: number
  active: number
}

const isRow = (e: MenuEntry) => !e.type && e.enabled !== false

/** Leaves of the whole tree with a "Parent › Child" path, for search. */
function flatten(list: MenuEntry[], prefix = ''): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const e of list) {
    if (e.type) continue
    const label = prefix ? `${prefix} › ${e.label}` : (e.label ?? '')
    if (e.submenu) out.push(...flatten(e.submenu, label))
    else out.push({ ...e, label })
  }
  return out
}

function MenuRoot({ req }: { req: MenuRequest }) {
  const [q, setQ] = useState('')
  const [stack, setStack] = useState<Level[]>([{ entries: req.entries, x: req.x, y: req.y, active: -1 }])
  const openTimer = useRef<number | undefined>(undefined)
  const close = () => req.resolve(null)

  // Typing in the search box replaces the tree with a flat list of matches.
  useEffect(() => {
    const needle = q.trim().toLowerCase()
    setStack((s) => [{ ...s[0], entries: needle ? flatten(req.entries).filter((e) => e.label!.toLowerCase().includes(needle)) : req.entries, active: needle ? 0 : -1 }])
  }, [q])

  useEffect(() => {
    const onBlur = () => close()
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [])

  const openSub = (level: number, index: number, rect: DOMRect) => {
    const entry = stack[level].entries[index]
    setStack((s) => {
      const next = s.slice(0, level + 1)
      next[level] = { ...next[level], active: index }
      if (entry?.submenu && entry.enabled !== false) next.push({ entries: entry.submenu, x: rect.right - 2, y: rect.top - 6, flipX: rect.left + 2, active: -1 })
      return next
    })
  }

  const pick = (e: MenuEntry) => {
    if (e.enabled === false || e.submenu || !e.id) return
    req.resolve(e.id)
  }

  // Keyboard: arrows move in the deepest panel, → opens a submenu, ← closes it.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const top = stack[stack.length - 1]
      const rows = top.entries.map((e, i) => (isRow(e) ? i : -1)).filter((i) => i >= 0)
      const pos = rows.indexOf(top.active)
      const setActive = (i: number) => setStack((s) => s.map((l, k) => (k === s.length - 1 ? { ...l, active: i } : l)))
      if (ev.key === 'Escape') {
        if (stack.length > 1) setStack((s) => s.slice(0, -1))
        else close()
      } else if (ev.key === 'ArrowDown') setActive(rows[(pos + 1) % rows.length] ?? -1)
      else if (ev.key === 'ArrowUp') setActive(rows[(pos - 1 + rows.length) % rows.length] ?? -1)
      else if (ev.key === 'ArrowRight' && top.entries[top.active]?.submenu) {
        const el = document.querySelector(`.cm-panel[data-level="${stack.length - 1}"] [data-index="${top.active}"]`)
        if (el) openSub(stack.length - 1, top.active, el.getBoundingClientRect())
        setStack((s) => s.map((l, k) => (k === s.length - 1 ? { ...l, active: l.entries.findIndex(isRow) } : l)))
      } else if (ev.key === 'ArrowLeft' && stack.length > 1) setStack((s) => s.slice(0, -1))
      else if (ev.key === 'Enter' && top.active >= 0) pick(top.entries[top.active])
      else return
      ev.preventDefault()
      ev.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stack])

  return (
    <div
      className="cm-backdrop"
      onMouseDown={close}
      onContextMenu={(e) => {
        e.preventDefault()
        close()
      }}
    >
      {stack.map((level, li) => (
        <Panel
          key={li}
          level={li}
          data={level}
          search={li === 0 && req.search}
          q={q}
          setQ={setQ}
          onHover={(i, rect) => {
            window.clearTimeout(openTimer.current)
            const e = level.entries[i]
            // Opening submenus on hover is slightly delayed so diagonal mouse moves don't flicker.
            if (e.submenu) openTimer.current = window.setTimeout(() => openSub(li, i, rect), 110)
            else openSub(li, i, rect)
          }}
          onPick={pick}
        />
      ))}
    </div>
  )
}

function Panel({
  level,
  data,
  search,
  q,
  setQ,
  onHover,
  onPick
}: {
  level: number
  data: Level
  search: boolean
  q: string
  setQ(v: string): void
  onHover(i: number, rect: DOMRect): void
  onPick(e: MenuEntry): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: data.x, top: data.y, ready: false })

  // Keep the panel on screen; submenus flip to the left when there's no room on the right.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = data.x
    if (left + w > window.innerWidth - 6) left = data.flipX !== undefined ? data.flipX - w : window.innerWidth - w - 6
    const top = Math.max(6, Math.min(data.y, window.innerHeight - h - 6))
    setPos({ left: Math.max(6, left), top, ready: true })
  }, [data.x, data.y, data.entries])

  useEffect(() => {
    ref.current?.querySelector(`[data-index="${data.active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [data.active])

  return (
    <div
      ref={ref}
      className="cm-panel"
      data-level={level}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {search && (
        <div className="cm-search">
          <Icon name="search" size={15} />
          <input autoFocus placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="cm-list">
        {data.entries.map((e, i) => {
          if (e.type === 'separator') return <div key={i} className="cm-sep" />
          if (e.type === 'swatches') {
            return (
              <div key={i} className="cm-swatches">
                {e.swatches?.map((s) => (
                  <button
                    key={s.id}
                    className={`cm-dot${s.active ? ' active' : ''}`}
                    style={{ background: s.color }}
                    onClick={() => onPick({ id: s.id })}
                    title={s.id === 'color:none' ? 'Без цвета' : undefined}
                  />
                ))}
              </div>
            )
          }
          const disabled = e.enabled === false
          return (
            <div
              key={i}
              data-index={i}
              className={`cm-row${i === data.active ? ' active' : ''}${disabled ? ' disabled' : ''}${e.danger ? ' danger' : ''}`}
              onMouseEnter={(ev) => !disabled && onHover(i, ev.currentTarget.getBoundingClientRect())}
              onClick={() => onPick(e)}
            >
              <span className="cm-icon">{e.icon ? <Icon name={e.icon} size={15} /> : e.checked ? <Icon name="check" size={15} /> : <Icon size={15} />}</span>
              <span className="cm-label">{e.label}</span>
              {e.shortcut && <span className="cm-key">{e.shortcut}</span>}
              {e.icon && e.checked && <Icon name="check" size={14} className="cm-check" />}
              {e.submenu && <Icon name="chevron-right" size={14} className="cm-chev" />}
            </div>
          )
        })}
        {!data.entries.length && <div className="cm-empty">Ничего не найдено</div>}
      </div>
    </div>
  )
}
