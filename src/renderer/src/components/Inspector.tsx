import { useEffect, useMemo, useRef, useState } from 'react'
import { Glyph, Icon } from './Icon'
import type { Folder, Item, ItemLite } from '../../../shared/types'
import { api, fileUrl, thumbUrl } from '../api'
import { BROWSER_IMAGE, fmtDate, fmtDuration, fmtSize, folderPaths, itemsLabel } from '../util'
import { Picker, type PickOption } from './Picker'

interface TagStat {
  name: string
  count: number
}

interface Props {
  selected: string[]
  items: ItemLite[]
  version: number
  tags: TagStat[]
  folders: Folder[]
  scopeTitle: string
  onColor(hex: string): void
}

export function Inspector({ selected, items, version, tags, folders, scopeTitle, onColor }: Props) {
  const paths = useMemo(() => folderPaths(folders), [folders])

  if (selected.length === 0) {
    const total = items.reduce((s, i) => s + i.size, 0)
    return (
      <aside className="inspector">
        <div className="insp-empty">
          <div className="insp-title">{scopeTitle}</div>
          <div className="muted">
            {itemsLabel(items.length)} · {fmtSize(total)}
          </div>
        </div>
      </aside>
    )
  }
  if (selected.length > 1) return <MultiInspector ids={selected} tags={tags} folders={folders} paths={paths} />
  return <SingleInspector key={selected[0]} id={selected[0]} version={version} tags={tags} folders={folders} paths={paths} onColor={onColor} />
}

function SingleInspector({
  id,
  version,
  tags,
  folders,
  paths,
  onColor
}: {
  id: string
  version: number
  tags: TagStat[]
  folders: Folder[]
  paths: Map<string, string>
  onColor(hex: string): void
}) {
  const [item, setItem] = useState<Item | null>(null)

  useEffect(() => {
    let alive = true
    api.getItem(id).then((it) => alive && setItem(it))
    return () => {
      alive = false
    }
  }, [id, version])

  if (!item) return <aside className="inspector" />

  const preview =
    item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : item.kind === 'image' && BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : null
  const ids = [item.id]

  return (
    <aside className="inspector">
      <div className="insp-preview">
        {preview ? <img src={preview} alt="" draggable={false} /> : <div className="insp-ph">{item.ext.toUpperCase()}</div>}
      </div>

      {item.palette.length > 0 && (
        <div className="palette-dots">
          {item.palette.map((c) => (
            <button
              key={c.hex}
              className="pdot"
              style={{ background: c.hex }}
              data-tip={`${c.hex.toUpperCase()} (${(c.ratio * 100).toFixed(1)}%)`}
              onClick={() => onColor(c.hex)}
              onContextMenu={async (e) => {
                e.preventDefault()
                const r = await api.menu([
                  { id: 'copy', label: `Копировать ${c.hex.toUpperCase()}`, icon: 'copy' },
                  { id: 'find', label: 'Показать похожие по цвету', icon: 'palette' }
                ])
                if (r === 'copy') navigator.clipboard.writeText(c.hex.toUpperCase())
                else if (r === 'find') onColor(c.hex)
              }}
            />
          ))}
        </div>
      )}

      <div className="insp-section">
        <CommitInput className="insp-name" value={item.name} onCommit={(name) => api.update(ids, { name })} />
        <Stars value={item.rating} onChange={(rating) => api.update(ids, { rating })} />
      </div>

      <div className="insp-section">
        <div className="insp-label">Теги</div>
        <TagField
          tags={item.tags}
          autoTags={item.autoTags}
          all={tags}
          onAdd={(t) => api.addTags(ids, [t])}
          onRemove={(t) => api.removeTag(ids, t)}
        />
      </div>

      <div className="insp-section">
        <div className="insp-label">Папки</div>
        <FolderField
          value={item.folderIds}
          folders={folders}
          paths={paths}
          onAdd={(fid) => api.addToFolder(ids, fid)}
          onRemove={(fid) => api.removeFromFolder(ids, fid)}
        />
      </div>

      <div className="insp-section">
        <div className="insp-label">Заметки</div>
        <CommitInput multiline value={item.notes} placeholder="Добавить заметку…" onCommit={(notes) => api.update(ids, { notes })} />
      </div>

      <div className="insp-section">
        <div className="insp-label">Источник</div>
        <div className="url-row">
          <CommitInput value={item.url} placeholder="https://…" onCommit={(url) => api.update(ids, { url })} />
          {/^https?:\/\//i.test(item.url) && (
            <button className="icon-btn" title="Открыть ссылку" onClick={() => api.openUrl(item.url)}>
              <Icon name="external" size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="insp-section">
        <div className="insp-label">Информация</div>
        <dl className="props">
          <dt>Формат</dt>
          <dd>{item.ext.toUpperCase()}</dd>
          {item.width && item.height && (
            <>
              <dt>Размеры</dt>
              <dd>
                {item.width} × {item.height}
              </dd>
            </>
          )}
          {item.duration != null && (
            <>
              <dt>Длительность</dt>
              <dd>{fmtDuration(item.duration)}</dd>
            </>
          )}
          <dt>Размер</dt>
          <dd>{fmtSize(item.size)}</dd>
          <dt>Добавлен</dt>
          <dd>{fmtDate(item.addedAt)}</dd>
        </dl>
      </div>

      <div className="insp-actions">
        <button onClick={() => api.openExternal(item.id)}>Открыть</button>
        <button onClick={() => api.showInFolder(item.id)}>Показать в проводнике</button>
      </div>
    </aside>
  )
}

function MultiInspector({ ids, tags, folders, paths }: { ids: string[]; tags: TagStat[]; folders: Folder[]; paths: Map<string, string> }) {
  const [added, setAdded] = useState<string[]>([])
  const [inFolders, setInFolders] = useState<string[]>([])
  return (
    <aside className="inspector">
      <div className="insp-empty">
        <div className="insp-title">Выбрано: {itemsLabel(ids.length)}</div>
      </div>
      <div className="insp-section">
        <div className="insp-label">Добавить теги всем</div>
        <TagField
          tags={added}
          all={tags}
          onAdd={(t) => {
            api.addTags(ids, [t])
            setAdded((a) => [...new Set([...a, t])])
          }}
          onRemove={(t) => {
            api.removeTag(ids, t)
            setAdded((a) => a.filter((x) => x !== t))
          }}
        />
      </div>
      <div className="insp-section">
        <div className="insp-label">Рейтинг</div>
        <Stars value={0} onChange={(rating) => api.update(ids, { rating })} />
      </div>
      <div className="insp-section">
        <div className="insp-label">Добавить в папки</div>
        <FolderField
          value={inFolders}
          folders={folders}
          paths={paths}
          onAdd={(fid) => {
            api.addToFolder(ids, fid)
            setInFolders((a) => [...new Set([...a, fid])])
          }}
          onRemove={(fid) => {
            api.removeFromFolder(ids, fid)
            setInFolders((a) => a.filter((x) => x !== fid))
          }}
        />
      </div>
    </aside>
  )
}

/** Tag chips plus the "new tag" button that opens the picker. */
function TagField({
  tags,
  autoTags = [],
  all,
  onAdd,
  onRemove
}: {
  tags: string[]
  /** Tags set by the auto-tagger; shown differently, clicking one confirms it. */
  autoTags?: string[]
  all: TagStat[]
  onAdd(tag: string): void
  onRemove(tag: string): void
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const have = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags])

  const options = useMemo<PickOption[]>(() => {
    const known = new Set(all.map((t) => t.name.toLowerCase()))
    // Tags added a moment ago may not be in the library list yet.
    const extra = tags.filter((t) => !known.has(t.toLowerCase())).map((name) => ({ name, count: 0 }))
    return [...all, ...extra]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ id: t.name, label: t.name, count: t.count || undefined, icon: <Icon name="tag" size={13} />, checked: have.has(t.name.toLowerCase()) }))
  }, [all, tags, have])
  const popular = useMemo(
    () => [...all].filter((t) => !have.has(t.name.toLowerCase())).sort((a, b) => b.count - a.count).slice(0, 8).map((t) => t.name),
    [all, have]
  )

  return (
    <>
      {tags.length > 0 && (
        <div className="tag-chips field-chips">
          {tags.map((t) => {
            const auto = autoTags.includes(t)
            return (
              <span
                key={t}
                className={`chip${auto ? ' auto' : ''}`}
                title={auto ? 'Автотег — нажмите, чтобы подтвердить' : undefined}
                onClick={auto ? () => onAdd(t) : undefined}
              >
                {auto && <Icon name="sparkle" size={11} className="chip-spark" />}
                {t}
                <button
                  className="chip-x"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(t)
                  }}
                  title="Убрать тег"
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      <button ref={btn} className={`field-add${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={15} />
        Новый тег
      </button>
      {open && btn.current && (
        <Picker
          anchor={btn.current}
          options={options}
          recommended={popular}
          recentKey="stash.recent.tags"
          placeholder="Найти или создать тег…"
          allTitle="Все теги"
          createLabel={(t) => `Создать тег «${t}»`}
          onCreate={onAdd}
          onToggle={(o) => (o.checked ? onRemove(o.id) : onAdd(o.id))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Folder chips plus the "add to folder" button that opens the picker. */
function FolderField({
  value,
  folders,
  paths,
  onAdd,
  onRemove
}: {
  value: string[]
  folders: Folder[]
  paths: Map<string, string>
  onAdd(id: string): void
  onRemove(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const glyph = (f: Folder | undefined, size: number) => (
    <span className="folder-glyph" style={f?.color ? { color: f.color } : undefined}>
      {f?.icon ? <Glyph value={f.icon} size={size} /> : <Icon name="folder" size={size} />}
    </span>
  )

  const options = useMemo<PickOption[]>(
    () =>
      [...folders]
        .sort((a, b) => (paths.get(a.id) ?? '').localeCompare(paths.get(b.id) ?? ''))
        .map((f) => ({ id: f.id, label: f.name, search: paths.get(f.id) ?? f.name, icon: glyph(f, 13), checked: value.includes(f.id) })),
    [folders, paths, value]
  )

  return (
    <>
      {value.length > 0 && (
        <div className="tag-chips field-chips">
          {value.map((fid) => (
            <span key={fid} className="chip folder-chip" title={paths.get(fid)}>
              {glyph(byId.get(fid), 12)}
              {byId.get(fid)?.name ?? '—'}
              <button className="chip-x" onClick={() => onRemove(fid)} title="Убрать из папки">
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <button ref={btn} className={`field-add${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={15} />
        Добавить в папку
      </button>
      {open && btn.current && (
        <Picker
          anchor={btn.current}
          options={options}
          recentKey="stash.recent.folders"
          placeholder="Найти или создать папку…"
          allTitle="Все папки"
          createLabel={(t) => `Создать папку «${t}»`}
          onCreate={async (name) => onAdd((await api.createFolder(name, null)).id)}
          onToggle={(o) => (o.checked ? onRemove(o.id) : onAdd(o.id))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function Stars({ value, onChange }: { value: number; onChange(v: number): void }) {
  const [hover, setHover] = useState(0)
  return (
    <div className="stars" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={(hover || value) >= n ? 'on' : ''}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? 0 : n)}
          title={`${n}`}
        >
          <Icon name="star" size={17} filled={(hover || value) >= n} />
        </button>
      ))}
    </div>
  )
}

/** Text field that saves on blur / Enter instead of on every keystroke. */
function CommitInput({
  value,
  onCommit,
  multiline,
  placeholder,
  className
}: {
  value: string
  onCommit(v: string): void
  multiline?: boolean
  placeholder?: string
  className?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    if (text !== value) onCommit(text)
  }
  const common = {
    className,
    value: text,
    placeholder,
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setText(e.target.value)
  }
  return multiline ? (
    <textarea {...common} rows={3} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(value)
          setTimeout(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}
