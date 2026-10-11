import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export interface PickOption {
  id: string
  label: string
  /** Text matched by the search in addition to the label (e.g. the full folder path). */
  search?: string
  count?: number
  icon?: ReactNode
  checked?: boolean
}

interface Props {
  /** The button the popup belongs to; the popup opens to its left. */
  anchor: HTMLElement
  options: PickOption[]
  /** Ids shown under "Популярные" while the search is empty. */
  recommended?: string[]
  /** localStorage key for the "Недавние" list. */
  recentKey: string
  placeholder: string
  allTitle: string
  /** Label of the "create" row for a query without an exact match. */
  createLabel?(text: string): string
  onCreate?(text: string): void
  onToggle(option: PickOption): void
  onClose(): void
}

const COLS = 2
const WIDTH = 348

function readRecent(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function pushRecent(key: string, id: string): void {
  try {
    localStorage.setItem(key, JSON.stringify([id, ...readRecent(key).filter((x) => x !== id)].slice(0, 12)))
  } catch {
    /* storage unavailable */
  }
}

/** Searchable popup for picking tags or folders: recent, popular, everything, keyboard navigation. */
export function Picker({ anchor, options, recommended = [], recentKey, placeholder, allTitle, createLabel, onCreate, onToggle, onClose }: Props) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState(() => readRecent(recentKey))
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const q = text.trim().toLowerCase()
  const groups = useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]))
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((o): o is PickOption => !!o)
    if (q) {
      const found = options.filter((o) => (o.search ?? o.label).toLowerCase().includes(q))
      return [{ title: 'Результаты', options: found }]
    }
    return [
      { title: 'Недавние', options: pick(recent).slice(0, 6) },
      { title: 'Популярные', options: pick(recommended).slice(0, 8) },
      { title: allTitle, options }
    ].filter((g) => g.options.length)
  }, [options, recommended, recent, q, allTitle])

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups])
  const exact = q && options.some((o) => o.label.toLowerCase() === q)
  const canCreate = !!onCreate && !!q && !exact
  const total = flat.length + (canCreate ? 1 : 0)

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const h = box.current?.offsetHeight ?? 420
      const left = r.left - WIDTH - 10 >= 8 ? r.left - WIDTH - 10 : Math.max(8, Math.min(window.innerWidth - WIDTH - 8, r.left))
      setPos({ left, top: Math.max(52, Math.min(r.top - 8, window.innerHeight - h - 12)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [anchor, onClose])

  useEffect(() => {
    box.current?.querySelector('.pick-opt.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (o: PickOption) => {
    pushRecent(recentKey, o.id)
    setRecent(readRecent(recentKey))
    onToggle(o)
    setText('')
  }
  const create = () => {
    onCreate?.(text.replace(/\s+/g, ' ').trim())
    setText('')
    setActive(0)
  }

  const move = (d: number) => setActive((a) => Math.max(0, Math.min(total - 1, a + d)))

  let index = 0
  return createPortal(
    <div ref={box} className="picker" style={{ width: WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}>
      <div className="pick-search">
        <Icon name="search" size={16} />
        <input
          autoFocus
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') (e.preventDefault(), move(COLS))
            else if (e.key === 'ArrowUp') (e.preventDefault(), move(-COLS))
            else if (e.key === 'ArrowRight' && !text) (e.preventDefault(), move(1))
            else if (e.key === 'ArrowLeft' && !text) (e.preventDefault(), move(-1))
            else if (e.key === 'Enter') {
              e.preventDefault()
              if (active < flat.length) choose(flat[active])
              else if (canCreate) create()
            }
          }}
        />
      </div>

      <div className="pick-body">
        {groups.map((g) => (
          <div key={g.title} className="pick-group">
            <div className="pick-title">
              {g.title} ({g.options.length})
            </div>
            <div className="pick-grid">
              {g.options.map((o) => {
                const i = index++
                return (
                  <button
                    key={o.id}
                    className={`pick-opt${i === active ? ' active' : ''}${o.checked ? ' checked' : ''}`}
                    title={o.search ?? o.label}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o)}
                  >
                    <span className="pick-icon">{o.checked ? <Icon name="check" size={13} /> : o.icon}</span>
                    <span className="pick-label">{o.label}</span>
                    {o.count != null && <span className="pick-count">{o.count}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        {canCreate && (
          <button className={`pick-opt pick-create${active === flat.length ? ' active' : ''}`} onMouseEnter={() => setActive(flat.length)} onClick={create}>
            <span className="pick-icon">
              <Icon name="plus" size={13} />
            </span>
            <span className="pick-label">{createLabel ? createLabel(text.trim()) : `Создать «${text.trim()}»`}</span>
          </button>
        )}
        {!total && <div className="pick-empty">Ничего не найдено</div>}
      </div>

      <div className="pick-foot">
        <span>
          Навигация <span className="kbd">↑</span> <span className="kbd">↓</span> <span className="kbd">←</span> <span className="kbd">→</span>
        </span>
        <span>
          Выбрать <span className="kbd">↵</span>
        </span>
        <span className="pick-foot-close">
          Закрыть <span className="kbd">Esc</span>
        </span>
      </div>
    </div>,
    document.body
  )
}
