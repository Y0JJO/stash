import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { Folder, Scope, TagCount } from '../../../shared/types'
import { folderPaths } from '../util'

interface Props {
  folders: Folder[]
  tags: TagCount[]
  onPick(s: Scope): void
  onClose(): void
}

type Tab = 'folders' | 'tags'

/** Ctrl+K palette: jump to any folder or tag by typing part of its name. */
export function QuickSwitch({ folders, tags, onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('folders')
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const paths = useMemo(() => folderPaths(folders), [folders])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (tab === 'folders') {
      return folders
        .map((f) => ({ key: f.id, label: f.name, hint: paths.get(f.id)!, count: f.count, scope: { type: 'folder', id: f.id } as Scope }))
        .filter((r) => !needle || r.hint.toLowerCase().includes(needle))
        .sort((a, b) => a.hint.localeCompare(b.hint))
    }
    return tags
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .map((t) => ({ key: t.name, label: `#${t.name}`, hint: '', count: t.count, scope: { type: 'tag', name: t.name } as Scope }))
  }, [tab, q, folders, tags, paths])

  useEffect(() => setActive(0), [q, tab])
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (i: number) => {
    const r = rows[i]
    if (r) {
      onPick(r.scope)
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="quick" onMouseDown={(e) => e.stopPropagation()}>
        <div className="quick-input">
          <Icon name="search" size={16} className="muted" />
          <input
            autoFocus
            value={q}
            placeholder={tab === 'folders' ? 'Найти папку…' : 'Найти тег…'}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, rows.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') pick(active)
              else if (e.key === 'Escape') onClose()
              else if (e.key === 'Tab') {
                e.preventDefault()
                setTab((t) => (t === 'folders' ? 'tags' : 'folders'))
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="quick-tabs">
          <button className={tab === 'folders' ? 'on' : ''} onClick={() => setTab('folders')}>
            Папки
          </button>
          <button className={tab === 'tags' ? 'on' : ''} onClick={() => setTab('tags')}>
            Теги
          </button>
          <span className="muted quick-tip">Tab — переключить</span>
        </div>
        <div className="quick-list" ref={listRef}>
          {rows.map((r, i) => (
            <div key={r.key} className={`quick-row${i === active ? ' active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
              <span className="quick-label">{r.label}</span>
              {r.hint && r.hint !== r.label && <span className="muted quick-hint">{r.hint}</span>}
              <span className="muted">{r.count || ''}</span>
            </div>
          ))}
          {!rows.length && <div className="muted quick-row">Ничего не найдено</div>}
        </div>
      </div>
    </div>
  )
}
