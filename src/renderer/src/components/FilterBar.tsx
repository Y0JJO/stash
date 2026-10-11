import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ExtCount, Filters, Shape } from '../../../shared/types'
import { NO_FILTERS } from '../../../shared/types'
import { api } from '../api'
import { TagInput } from './TagInput'

const SHAPES: { key: Shape; label: string }[] = [
  { key: 'any', label: 'Любая' },
  { key: 'landscape', label: 'Горизонтальная' },
  { key: 'portrait', label: 'Вертикальная' },
  { key: 'square', label: 'Квадрат' },
  { key: 'panorama', label: 'Панорама' }
]

const SWATCHES = [
  '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#ec407a',
  '#6d4c41', '#000000', '#9e9e9e', '#ffffff'
]

interface Props {
  filters: Filters
  onFilters(f: Filters): void
  color: string | null
  onColor(c: string | null): void
  allTags: string[]
  version: number
}

export const activeFilterCount = (f: Filters, color: string | null) =>
  (f.shape !== 'any' ? 1 : 0) +
  (f.minRating ? 1 : 0) +
  (f.exts.length ? 1 : 0) +
  (f.minWidth || f.minHeight ? 1 : 0) +
  (f.tags.length ? 1 : 0) +
  (color ? 1 : 0)

/** Row of filter dropdowns under the toolbar (the "Filter" panel). */
export function FilterBar({ filters, onFilters, color, onColor, allTags, version }: Props) {
  const [exts, setExts] = useState<ExtCount[]>([])
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch })

  useEffect(() => {
    api.exts().then(setExts)
  }, [version])

  return (
    <div className="filter-bar">
      <Drop label="Цвет" active={!!color} value={color ? <span className="dot-swatch" style={{ background: color }} /> : null}>
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
            <button className="icon-btn small" onClick={() => onColor(null)}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </Drop>

      <Drop label="Форма" active={filters.shape !== 'any'} value={filters.shape !== 'any' ? SHAPES.find((s) => s.key === filters.shape)?.label : null}>
        {SHAPES.map((s) => (
          <button key={s.key} className={`menu-item${filters.shape === s.key ? ' on' : ''}`} onClick={() => set({ shape: s.key })}>
            <ShapeIcon shape={s.key} />
            {s.label}
          </button>
        ))}
      </Drop>

      <Drop label="Рейтинг" active={filters.minRating > 0} value={filters.minRating ? <Stars n={filters.minRating} /> : null}>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={`menu-item${filters.minRating === n ? ' on' : ''}`} onClick={() => set({ minRating: n })}>
            {n === 0 ? 'Любой' : <Stars n={n} />}
          </button>
        ))}
      </Drop>

      <Drop label="Тип" active={filters.exts.length > 0} value={filters.exts.length ? filters.exts.map((e) => e.toUpperCase()).join(', ') : null}>
        {exts.map((e) => (
          <label key={e.ext} className="menu-item check">
            <input
              type="checkbox"
              checked={filters.exts.includes(e.ext)}
              onChange={(ev) => set({ exts: ev.target.checked ? [...filters.exts, e.ext] : filters.exts.filter((x) => x !== e.ext) })}
            />
            <span className="grow">{e.ext.toUpperCase()}</span>
            <span className="muted">{e.count}</span>
          </label>
        ))}
        {!exts.length && <div className="muted menu-item">Нет файлов</div>}
      </Drop>

      <Drop
        label="Размеры"
        active={!!(filters.minWidth || filters.minHeight)}
        value={filters.minWidth || filters.minHeight ? `от ${filters.minWidth || '…'}×${filters.minHeight || '…'}` : null}
      >
        <div className="dims-row">
          <label>
            Ширина от
            <input type="number" min={0} step={100} value={filters.minWidth || ''} onChange={(e) => set({ minWidth: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Высота от
            <input type="number" min={0} step={100} value={filters.minHeight || ''} onChange={(e) => set({ minHeight: Number(e.target.value) || 0 })} />
          </label>
        </div>
        <div className="preset-row">
          {[
            [1280, 720],
            [1920, 1080],
            [3840, 2160]
          ].map(([w, h]) => (
            <button key={w} onClick={() => set({ minWidth: w, minHeight: h })}>
              {h}p+
            </button>
          ))}
        </div>
      </Drop>

      <Drop label="Теги" active={filters.tags.length > 0} value={filters.tags.length ? filters.tags.join(', ') : null} wide>
        <TagInput
          tags={filters.tags}
          suggestions={allTags}
          placeholder="Все эти теги…"
          onAdd={(t) => set({ tags: [...new Set([...filters.tags, t])] })}
          onRemove={(t) => set({ tags: filters.tags.filter((x) => x !== t) })}
        />
      </Drop>

      {activeFilterCount(filters, color) > 0 && (
        <button
          className="icon-btn"
          onClick={() => {
            onFilters(NO_FILTERS)
            onColor(null)
          }}
        >
          Сбросить
        </button>
      )}
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
  const box: Record<Shape, [number, number]> = { any: [12, 12], landscape: [14, 9], portrait: [9, 14], square: [12, 12], panorama: [16, 6] }
  const [w, h] = box[shape]
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" className="shape-icon">
      <rect x={(18 - w) / 2} y={(16 - h) / 2} width={w} height={h} rx="1.5" fill="none" stroke="currentColor" strokeDasharray={shape === 'any' ? '2 2' : undefined} />
    </svg>
  )
}

/** Small dropdown button + popover that closes on outside click. */
function Drop({ label, value, active, wide, children }: { label: string; value?: React.ReactNode; active: boolean; wide?: boolean; children: React.ReactNode }) {
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
      <button className={`drop-btn${active ? ' active' : ''}`} onClick={() => setOpen((o) => !o)}>
        {label}
        {value && <span className="drop-value">{value}</span>}
        <Icon name="chevron-down" size={13} className="muted" />
      </button>
      {open && <div className={`drop-pop${wide ? ' wide' : ''}`}>{children}</div>}
    </div>
  )
}
