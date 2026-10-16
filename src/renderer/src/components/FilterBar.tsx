import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { Facet, FacetCounts, FacetKey, FacetRule, FacetValue, Filters, Folder, Query, Shape } from '../../../shared/types'
import { NO_FILTERS } from '../../../shared/types'
import { api } from '../api'

const SHAPES: { key: Shape; label: string }[] = [
  { key: 'landscape', label: 'Горизонтальные' },
  { key: 'portrait', label: 'Вертикальные' },
  { key: 'square', label: 'Квадратные' },
  { key: 'panorama', label: 'Панорамы' }
]

const SWATCHES = [
  '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#ec407a',
  '#6d4c41', '#000000', '#9e9e9e', '#ffffff'
]

type ChipKey = 'color' | FacetKey
const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'color', label: 'Цвет' },
  { key: 'tags', label: 'Теги' },
  { key: 'folders', label: 'Папка' },
  { key: 'shapes', label: 'Форма' },
  { key: 'ratings', label: 'Рейтинг' },
  { key: 'exts', label: 'Типы' }
]
const CHIPS_PREF = 'filterChips'

function loadChips(): ChipKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(CHIPS_PREF) ?? 'null') as ChipKey[] | null
    if (Array.isArray(v)) return CHIPS.map((c) => c.key).filter((k) => v.includes(k))
  } catch {
    // Storage unavailable — fall back to all chips.
  }
  return CHIPS.map((c) => c.key)
}

const picked = (f: Facet<unknown>) => f.inc.length + f.exc.length

export const activeFilterCount = (f: Filters, color: string | null) =>
  picked(f.tags) + picked(f.folders) + picked(f.shapes) + picked(f.ratings) + picked(f.exts) + (f.minWidth || f.minHeight ? 1 : 0) + (color ? 1 : 0)

interface Props {
  filters: Filters
  onFilters(f: Filters): void
  color: string | null
  onColor(c: string | null): void
  /** The current view; counts are computed for it. */
  query: Query
  folders: Folder[]
  version: number
}

/** Eagle-style filter row under the toolbar: one chip per filter, each opening a list with counts. */
export function FilterBar({ filters, onFilters, color, onColor, query, folders, version }: Props) {
  const [counts, setCounts] = useState<FacetCounts | null>(null)
  const [chips, setChips] = useState<ChipKey[]>(loadChips)

  useEffect(() => {
    let live = true
    api.facets(query).then((c) => live && setCounts(c), () => {})
    return () => {
      live = false
    }
  }, [query, version])

  useEffect(() => {
    try {
      localStorage.setItem(CHIPS_PREF, JSON.stringify(chips))
    } catch {
      // Not remembered this time; harmless.
    }
  }, [chips])

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onFilters({ ...filters, [key]: value })

  const folderLabel = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    const label = (f: Folder, depth = 0): string => {
      const p = f.parentId ? byId.get(f.parentId) : undefined
      return p && depth < 32 ? `${label(p, depth + 1)} / ${f.name}` : f.name
    }
    return (id: string) => (id === '' ? 'Без папки' : byId.has(id) ? label(byId.get(id)!) : null)
  }, [folders])

  const shown = (k: ChipKey) => chips.includes(k) || (k === 'color' ? !!color : picked(filters[k]) > 0)

  return (
    <div className="filter-bar">
      {shown('color') && (
        <Drop icon={<span className="rainbow" />} label="Цвет" active={!!color} badge={color ? <span className="dot-swatch" style={{ background: color }} /> : null}>
          <div className="swatch-grid">
            {SWATCHES.map((c) => (
              <button key={c} className={`swatch-btn${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => onColor(c)} />
            ))}
          </div>
          <div className="color-row">
            <input type="color" value={color ?? '#6b7cff'} onChange={(e) => onColor(e.target.value)} title="Выбрать цвет" />
            <input
              className="hex-input"
              placeholder="#FF6B4D"
              defaultValue={color ?? ''}
              key={color ?? ''}
              onKeyDown={(e) => {
                const v = (e.target as HTMLInputElement).value.trim()
                if (e.key === 'Enter' && /^#?[0-9a-f]{6}$/i.test(v)) onColor(v.startsWith('#') ? v : `#${v}`)
              }}
            />
            {color && (
              <button className="icon-btn small" onClick={() => onColor(null)} title="Сбросить цвет">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
        </Drop>
      )}

      {shown('tags') && (
        <Drop icon={<Icon name="tag" size={14} />} label="Теги" active={picked(filters.tags) > 0} badge={<Badge f={filters.tags} />} wide>
          <TagPanel
            facet={filters.tags}
            values={counts?.tags ?? []}
            onChange={(v) => set('tags', v)}
          />
        </Drop>
      )}

      {shown('folders') && (
        <Drop icon={<Icon name="folder" size={14} />} label="Папка" active={picked(filters.folders) > 0} badge={<Badge f={filters.folders} />}>
          <FacetList
            facet={filters.folders}
            values={(counts?.folders ?? []).filter((v) => folderLabel(v.key) !== null)}
            label={(k) => folderLabel(k) ?? k}
            icon={(k) => <Icon name={k === '' ? 'folder-open' : 'folder'} size={13} className="muted" />}
            sort={(a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : (folderLabel(a.key) ?? '').localeCompare(folderLabel(b.key) ?? ''))}
            search
            rule
            onChange={(v) => set('folders', { ...filters.folders, ...v })}
          />
        </Drop>
      )}

      {shown('shapes') && (
        <Drop
          icon={<Icon name="rectangle-horizontal" size={14} />}
          label="Форма"
          active={picked(filters.shapes) > 0 || !!(filters.minWidth || filters.minHeight)}
          badge={<Badge f={filters.shapes} extra={filters.minWidth || filters.minHeight ? 1 : 0} />}
        >
          <FacetList
            facet={filters.shapes}
            values={SHAPES.map((s) => ({ key: s.key, count: counts?.shapes.find((c) => c.key === s.key)?.count ?? 0 }))}
            label={(k) => SHAPES.find((s) => s.key === k)?.label ?? k}
            icon={(k) => <ShapeIcon shape={k as Shape} />}
            keepEmpty
            onChange={(v) => set('shapes', { ...filters.shapes, ...v } as Facet<Shape>)}
          />
          <div className="facet-sep" />
          <div className="facet-sub">Свой размер, не меньше</div>
          <div className="dims-row">
            <label>
              Ширина
              <input type="number" min={0} step={100} value={filters.minWidth || ''} onChange={(e) => set('minWidth', Number(e.target.value) || 0)} />
            </label>
            <label>
              Высота
              <input type="number" min={0} step={100} value={filters.minHeight || ''} onChange={(e) => set('minHeight', Number(e.target.value) || 0)} />
            </label>
          </div>
          <div className="preset-row">
            {[
              [1280, 720],
              [1920, 1080],
              [3840, 2160]
            ].map(([w, h]) => (
              <button key={w} onClick={() => onFilters({ ...filters, minWidth: w, minHeight: h })}>
                {h}p+
              </button>
            ))}
          </div>
        </Drop>
      )}

      {shown('ratings') && (
        <Drop icon={<Icon name="star" size={14} />} label="Рейтинг" active={picked(filters.ratings) > 0} badge={<Badge f={filters.ratings} />}>
          <FacetList
            facet={{ inc: filters.ratings.inc.map(String), exc: filters.ratings.exc.map(String) }}
            values={counts?.ratings ?? []}
            label={(k) => (k === '0' ? 'Без оценки' : '')}
            icon={(k) => (k === '0' ? null : <Stars n={Number(k)} />)}
            onChange={(v) =>
              set('ratings', {
                inc: (v.inc ?? filters.ratings.inc.map(String)).map(Number),
                exc: (v.exc ?? filters.ratings.exc.map(String)).map(Number)
              })
            }
          />
        </Drop>
      )}

      {shown('exts') && (
        <Drop icon={<Icon name="code-xml" size={14} />} label="Типы" active={picked(filters.exts) > 0} badge={<Badge f={filters.exts} />}>
          <FacetList
            facet={filters.exts}
            values={counts?.exts ?? []}
            label={(k) => k}
            search
            onChange={(v) => set('exts', { ...filters.exts, ...v })}
          />
        </Drop>
      )}

      <Drop icon={<Icon name="plus" size={15} />} title="Какие фильтры показывать" plain>
        {CHIPS.map((c) => (
          <label key={c.key} className="menu-item check">
            <input
              type="checkbox"
              checked={chips.includes(c.key)}
              onChange={(e) => setChips((list) => (e.target.checked ? CHIPS.map((x) => x.key).filter((k) => k === c.key || list.includes(k)) : list.filter((k) => k !== c.key)))}
            />
            {c.label}
          </label>
        ))}
      </Drop>

      {activeFilterCount(filters, color) > 0 && (
        <button
          className="filter-reset"
          onClick={() => {
            onFilters(NO_FILTERS)
            onColor(null)
          }}
        >
          <Icon name="close" size={13} />
          Сбросить
        </button>
      )}
    </div>
  )
}

function Badge({ f, extra = 0 }: { f: Facet<unknown>; extra?: number }) {
  const n = f.inc.length + extra
  if (!n && !f.exc.length) return null
  return (
    <span className="chip-badges">
      {n > 0 && <span className="chip-badge">{n}</span>}
      {f.exc.length > 0 && <span className="chip-badge exc">−{f.exc.length}</span>}
    </span>
  )
}

interface ListProps {
  facet: Facet<string> & { rule?: FacetRule }
  values: FacetValue[]
  label(key: string): React.ReactNode
  icon?(key: string): React.ReactNode
  sort?(a: FacetValue, b: FacetValue): number
  /** Show values with no matches too (fixed lists like shapes). */
  keepEmpty?: boolean
  search?: boolean
  rule?: boolean
  onChange(v: Partial<Facet<string> & { rule: FacetRule }>): void
  /** Extra controls on a row (tag rename / delete). */
  rowTools?(key: string): React.ReactNode
  renderLabel?(key: string, fallback: React.ReactNode): React.ReactNode
}

/** A list of filter values: left click picks, right click excludes; counts on the right. */
function FacetList({ facet, values, label, icon, sort, keepEmpty, search, rule, onChange, rowTools, renderLabel }: ListProps) {
  const [q, setQ] = useState('')
  // Picked values stay listed even when nothing in the view matches them any more.
  const all = new Map(values.map((v) => [v.key, v.count]))
  for (const k of [...facet.inc, ...facet.exc]) if (!all.has(k)) all.set(k, 0)
  let rows = [...all].map(([key, count]) => ({ key, count }))
  if (!keepEmpty) rows = rows.filter((r) => r.count > 0 || facet.inc.includes(r.key) || facet.exc.includes(r.key))
  if (sort) rows.sort(sort)
  if (q.trim()) {
    const needle = q.trim().toLowerCase()
    rows = rows.filter((r) => String(label(r.key) || r.key).toLowerCase().includes(needle))
  }

  const toggle = (key: string, exclude: boolean) => {
    const inc = facet.inc.filter((k) => k !== key)
    const exc = facet.exc.filter((k) => k !== key)
    if (exclude) {
      if (!facet.exc.includes(key)) exc.push(key)
    } else if (!facet.inc.includes(key)) inc.push(key)
    onChange({ inc, exc })
  }

  return (
    <div className="facet">
      {(search || rule) && (
        <div className="facet-head">
          {search && (
            <label className="facet-search">
              <Icon name="search" size={13} className="muted" />
              <input autoFocus placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          )}
          {rule && <RuleSwitch rule={facet.rule ?? 'any'} onRule={(r) => onChange({ rule: r })} />}
        </div>
      )}
      <div className="facet-rows">
        {rows.map((r) => {
          const state = facet.inc.includes(r.key) ? 'inc' : facet.exc.includes(r.key) ? 'exc' : ''
          const text = label(r.key)
          return (
            <div
              key={r.key}
              className={`facet-row ${state}`}
              onClick={() => toggle(r.key, false)}
              onContextMenu={(e) => {
                e.preventDefault()
                toggle(r.key, true)
              }}
            >
              <span className="facet-box">{state === 'inc' ? <Icon name="check" size={11} /> : state === 'exc' ? <Icon name="minus" size={11} /> : null}</span>
              {icon?.(r.key)}
              <span className="facet-label">{renderLabel ? renderLabel(r.key, text) : text}</span>
              {rowTools?.(r.key)}
              <span className="facet-count">{r.count}</span>
            </div>
          )
        })}
        {!rows.length && <div className="facet-empty">{q ? 'Ничего не найдено' : 'Пусто'}</div>}
      </div>
      <div className="facet-foot">
        <span>
          Выбрать <kbd>ЛКМ</kbd>
        </span>
        <span>
          Исключить <kbd>ПКМ</kbd>
        </span>
        {facet.inc.length + facet.exc.length > 0 && (
          <button className="facet-clear" onClick={() => onChange({ inc: [], exc: [] })}>
            Очистить
          </button>
        )}
      </div>
    </div>
  )
}

function RuleSwitch({ rule, onRule }: { rule: FacetRule; onRule(r: FacetRule): void }) {
  return (
    <div className="rule-switch" title="Как сочетать выбранные значения">
      <button className={rule === 'any' ? 'on' : ''} onClick={() => onRule('any')} title="Любой из выбранных">
        Любой
      </button>
      <button className={rule === 'all' ? 'on' : ''} onClick={() => onRule('all')} title="Все выбранные сразу">
        Все
      </button>
    </div>
  )
}

/** Tags: a list with "all / picked" views, plus rename and delete on each tag. */
function TagPanel({ facet, values, onChange }: { facet: Filters['tags']; values: FacetValue[]; onChange(f: Filters['tags']): void }) {
  const [view, setView] = useState<'all' | 'picked'>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const pickedKeys = new Set([...facet.inc, ...facet.exc])
  const tagCount = values.filter((v) => v.key !== '' && v.count > 0).length

  const rename = async (from: string, to: string) => {
    setEditing(null)
    to = to.trim()
    if (!to || to === from) return
    await api.renameTag(from, to)
    const swap = (l: string[]) => [...new Set(l.map((t) => (t === from ? to : t)))]
    onChange({ ...facet, inc: swap(facet.inc), exc: swap(facet.exc) })
  }

  const menu = async (tag: string, count: number) => {
    const r = await api.menu([
      { id: 'rename', label: 'Переименовать', icon: 'rename' },
      { type: 'separator' },
      { id: 'delete', label: 'Удалить тег', icon: 'trash', danger: true }
    ])
    if (r === 'rename') setEditing(tag)
    else if (r === 'delete' && (await api.confirm(`Удалить тег «${tag}»?`, `Он будет снят с ${count} элементов.`))) {
      await api.deleteTag(tag)
      onChange({ ...facet, inc: facet.inc.filter((t) => t !== tag), exc: facet.exc.filter((t) => t !== tag) })
    }
  }

  return (
    <div className="tag-panel">
      <div className="tag-views">
        <button className={view === 'picked' ? 'on' : ''} onClick={() => setView('picked')}>
          Выбранные
          {pickedKeys.size > 0 && <span className="facet-count">{pickedKeys.size}</span>}
        </button>
        <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>
          Все теги
          <span className="facet-count">{tagCount}</span>
        </button>
      </div>
      <FacetList
        facet={facet}
        values={view === 'picked' ? values.filter((v) => pickedKeys.has(v.key)) : values}
        label={(k) => (k === '' ? 'Без тегов' : k)}
        icon={(k) => <Icon name={k === '' ? 'tag' : 'hash'} size={13} className="muted" />}
        sort={(a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : 0)}
        search
        rule
        onChange={(v) => onChange({ ...facet, ...v })}
        renderLabel={(k, text) =>
          editing === k ? (
            <input
              className="facet-edit"
              autoFocus
              defaultValue={k}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
              onBlur={(e) => rename(k, e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            text
          )
        }
        rowTools={(k) =>
          k === '' ? null : (
            <button
              className="facet-tool"
              title="Переименовать или удалить"
              onClick={(e) => {
                e.stopPropagation()
                menu(k, values.find((v) => v.key === k)?.count ?? 0)
              }}
              onContextMenu={(e) => e.stopPropagation()}
            >
              <Icon name="more-horizontal" size={13} />
            </button>
          )
        }
      />
    </div>
  )
}

function Stars({ n }: { n: number }) {
  return (
    <span className="stars-inline">
      {Array.from({ length: n }, (_, k) => (
        <Icon key={k} name="star" size={12} filled />
      ))}
    </span>
  )
}

function ShapeIcon({ shape }: { shape: Shape }) {
  const box: Record<Shape, [number, number]> = { landscape: [14, 9], portrait: [9, 14], square: [12, 12], panorama: [16, 6] }
  const [w, h] = box[shape]
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" className="shape-icon">
      <rect x={(18 - w) / 2} y={(16 - h) / 2} width={w} height={h} rx="1.5" fill="none" stroke="currentColor" />
    </svg>
  )
}

/** A chip in the filter row and its popover, which closes on an outside click or Esc. */
function Drop({
  icon,
  label,
  active,
  badge,
  wide,
  plain,
  title,
  children
}: {
  icon: React.ReactNode
  label?: string
  active?: boolean
  badge?: React.ReactNode
  wide?: boolean
  plain?: boolean
  title?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="drop" ref={ref}>
      <button className={`fchip${active ? ' active' : ''}${open ? ' open' : ''}${plain ? ' plain' : ''}`} onClick={() => setOpen((o) => !o)} title={title}>
        {icon}
        {label}
        {badge}
      </button>
      {open && <div className={`drop-pop${wide ? ' wide' : ''}`}>{children}</div>}
    </div>
  )
}
