import { useEffect, useMemo, useState } from 'react'
import type { BoardInfo, Counts, Folder, MenuEntry, Scope, SortKey, TagCount } from '../../../shared/types'
import { FOLDER_COLORS } from '../../../shared/types'
import { api, droppedPaths } from '../api'
import { folderPaths, keyOf, loadPref, savePref } from '../util'
import { AiStatusBar } from './AiStatusBar'
import { useSettings } from '../settings'
import { AutoTagDialog, PasswordDialog } from './FolderDialogs'
import { Glyph, Icon } from './Icon'
import { PICKABLE } from '../../../shared/icons'

const FOLDER_MIME = 'application/x-stash-folder'

const SORT_LABELS: [SortKey, string][] = [
  ['added', 'Дата добавления'],
  ['name', 'Имя'],
  ['size', 'Размер файла'],
  ['rating', 'Рейтинг'],
  ['duration', 'Длительность'],
  ['random', 'Случайно']
]


interface Props {
  scope: Scope
  onScope(s: Scope): void
  folders: Folder[]
  tags: TagCount[]
  counts: Counts
  boards: BoardInfo[]
  libPath: string
  /** Re-locks a folder that was unlocked in this session. */
  onLock(id: string): void
  unlocked: Set<string>
}

export function Sidebar({ scope, onScope, folders, tags, counts, boards, libPath, onLock, unlocked }: Props) {
  const prefs = useSettings()
  const [editing, setEditing] = useState<string | null>(null)
  const [editingBoard, setEditingBoard] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>(() => loadPref('collapsed', []))
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [autoTagFor, setAutoTagFor] = useState<Folder | null>(null)
  const [password, setPassword] = useState<{ folder: Folder; mode: 'set' | 'remove' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => savePref('collapsed', collapsed), [collapsed])

  const flash = (text: string) => {
    setNotice(text)
    setTimeout(() => setNotice(null), 2500)
  }

  const children = useMemo(() => {
    const m = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const list = m.get(f.parentId) ?? []
      list.push(f)
      m.set(f.parentId, list)
    }
    return m
  }, [folders])
  const paths = useMemo(() => folderPaths(folders), [folders])
  const hasKids = (id: string) => (children.get(id)?.length ?? 0) > 0
  const isOpen = (id: string) => !collapsed.includes(id)

  const isActive = (s: Scope) =>
    s.type === scope.type &&
    (s.type !== 'folder' || (scope.type === 'folder' && s.id === scope.id)) &&
    (s.type !== 'tag' || (scope.type === 'tag' && s.name === scope.name)) &&
    (s.type !== 'board' || (scope.type === 'board' && s.id === scope.id))

  const current = scope.type === 'folder' ? folders.find((f) => f.id === scope.id) ?? null : null

  const newFolder = async (parentId: string | null) => {
    const f = await api.createFolder('Новая папка', parentId)
    if (parentId) setCollapsed((c) => c.filter((x) => x !== parentId))
    setEditing(f.id)
    onScope({ type: 'folder', id: f.id })
  }

  // ----- expand / collapse -----

  const setOpen = (ids: string[], open: boolean) =>
    setCollapsed((c) => (open ? c.filter((x) => !ids.includes(x)) : [...new Set([...c, ...ids])]))
  const toggleOne = (f: Folder) => setOpen([f.id], !isOpen(f.id))
  const toggleGroup = (list: Folder[]) => {
    const ids = list.filter((f) => hasKids(f.id)).map((f) => f.id)
    setOpen(ids, !ids.some(isOpen))
  }
  const toggleSame = (f: Folder) => toggleGroup(children.get(f.parentId) ?? [])
  const toggleAll = () => toggleGroup(folders)

  const descendants = (id: string): Set<string> => {
    const out = new Set<string>([id])
    const walk = (fid: string) => (children.get(fid) ?? []).forEach((c) => (out.add(c.id), walk(c.id)))
    walk(id)
    return out
  }

  // ----- the folder menu -----

  const folderMenu = async (f: Folder) => {
    const others = (await api.recentLibraries()).filter((p) => p !== libPath)
    const blocked = descendants(f.id)
    const moveTargets = folders.filter((x) => !blocked.has(x.id) && x.id !== f.parentId).sort((a, b) => paths.get(a.id)!.localeCompare(paths.get(b.id)!))
    const entries: MenuEntry[] = [
      { id: 'new', label: 'Новая папка', icon: 'folder-plus', shortcut: 'Ctrl+Shift+N' },
      { id: 'sub', label: 'Новая подпапка', icon: 'folder-sub', shortcut: 'Alt+N' },
      {
        label: 'Переместить папку',
        icon: 'move',
        submenu: [
          { id: 'move:root', label: 'В корень', icon: 'folder', enabled: !!f.parentId },
          ...(moveTargets.length ? [{ type: 'separator' as const }] : []),
          ...moveTargets.map((x) => ({ id: `move:${x.id}`, label: paths.get(x.id)!, icon: 'folder' }))
        ]
      },
      { type: 'separator' },
      { id: 'pin', label: f.pinned ? 'Убрать из быстрого доступа' : 'В быстрый доступ', icon: 'star' },
      { type: 'separator' },
      { id: 'rename', label: 'Переименовать', icon: 'rename', shortcut: 'F2' },
      { id: 'link', label: 'Копировать ссылку', icon: 'link' },
      { id: 'autotag', label: f.autoTags.length ? `Автотег: ${f.autoTags.join(', ')}` : 'Автотег…', icon: 'tag', shortcut: 'Ctrl+Shift+R' },
      {
        label: 'Пароль',
        icon: 'lock',
        submenu: f.locked
          ? [
              { id: 'pw:set', label: 'Сменить пароль…' },
              { id: 'pw:remove', label: 'Снять пароль…' },
              { id: 'pw:lock', label: 'Закрыть сейчас', enabled: unlocked.has(f.id) }
            ]
          : [{ id: 'pw:set', label: 'Установить пароль…' }]
      },
      {
        label: 'Сортировка',
        icon: 'sort',
        submenu: [
          { id: 'sort:default', label: 'Как в остальной библиотеке', checked: !f.sortKey },
          { type: 'separator' },
          ...SORT_LABELS.map(([k, label]) => ({ id: `sort:${k}`, label, checked: f.sortKey === k })),
          { type: 'separator' },
          { id: 'sortdir:desc', label: 'По убыванию', checked: !!f.sortKey && f.sortDesc, enabled: !!f.sortKey && f.sortKey !== 'random' },
          { id: 'sortdir:asc', label: 'По возрастанию', checked: !!f.sortKey && !f.sortDesc, enabled: !!f.sortKey && f.sortKey !== 'random' }
        ]
      },
      { type: 'separator' },
      { id: 'toggle:one', label: 'Свернуть/развернуть папку', icon: 'expand-one', enabled: hasKids(f.id) },
      { id: 'toggle:same', label: 'Свернуть/развернуть папки уровня', icon: 'expand-same' },
      { id: 'toggle:all', label: 'Свернуть/развернуть все папки', icon: 'expand-all', shortcut: '/' },
      { type: 'separator' },
      { id: 'duplicate', label: 'Дублировать', icon: 'copy' },
      { type: 'separator' },
      {
        label: 'Экспорт',
        icon: 'export',
        submenu: [
          { id: 'export:dir', label: 'В папку на диске…', icon: 'folder-open' },
          { id: 'export:zip', label: 'ZIP-архив…', icon: 'copy' }
        ]
      },
      {
        label: 'Добавить в другую библиотеку',
        icon: 'library',
        submenu: [
          ...others.map((p) => ({ id: `lib:${p}`, label: p.split(/[\\/]/).pop()!.replace(/\.stash$/i, ''), icon: 'library' })),
          ...(others.length ? [{ type: 'separator' as const }] : []),
          { id: 'lib:pick', label: 'Выбрать библиотеку…' }
        ]
      },
      { type: 'separator' },
      { id: 'showsub', label: 'Показывать содержимое подпапок', icon: 'layers', checked: f.showSub },
      { type: 'separator' },
      {
        label: 'Сменить иконку',
        icon: 'smile',
        submenu: [
          { id: 'icon:none', label: 'Обычная папка', icon: 'folder', checked: !f.icon },
          { type: 'separator' },
          ...PICKABLE.map(([name, label]) => ({ id: `icon:i:${name}`, label, icon: name, checked: f.icon === `i:${name}` }))
        ]
      },
      {
        type: 'swatches',
        swatches: [{ id: 'color:none', color: '#5b5e68', active: !f.color }, ...FOLDER_COLORS.slice(1).map((c) => ({ id: `color:${c}`, color: c, active: f.color === c }))]
      },
      { type: 'separator' },
      { id: 'delete', label: 'Удалить папку', icon: 'trash', danger: true }
    ]

    const r = await api.menu(entries, { search: true })
    if (!r) return
    try {
      await runFolderAction(f, r)
    } catch (err) {
      flash(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const runFolderAction = async (f: Folder, r: string) => {
    if (r === 'new') return newFolder(f.parentId)
    if (r === 'sub') return newFolder(f.id)
    if (r === 'move:root') return api.moveFolder(f.id, null)
    if (r.startsWith('move:')) {
      setOpen([r.slice(5)], true)
      return api.moveFolder(f.id, r.slice(5))
    }
    if (r === 'pin') return api.updateFolder(f.id, { pinned: !f.pinned })
    if (r === 'rename') return setEditing(f.id)
    if (r === 'link') {
      await api.copyFolderLink(f.id)
      return flash('Ссылка скопирована — вставьте её в заметки или чат')
    }
    if (r === 'autotag') return setAutoTagFor(f)
    if (r === 'pw:set') return setPassword({ folder: f, mode: 'set' })
    if (r === 'pw:remove') return setPassword({ folder: f, mode: 'remove' })
    if (r === 'pw:lock') return onLock(f.id)
    if (r === 'sort:default') return api.updateFolder(f.id, { sortKey: null })
    if (r.startsWith('sort:')) return api.updateFolder(f.id, { sortKey: r.slice(5) as SortKey })
    if (r === 'sortdir:desc') return api.updateFolder(f.id, { sortDesc: true })
    if (r === 'sortdir:asc') return api.updateFolder(f.id, { sortDesc: false })
    if (r === 'toggle:one') return toggleOne(f)
    if (r === 'toggle:same') return toggleSame(f)
    if (r === 'toggle:all') return toggleAll()
    if (r === 'duplicate') {
      const copy = await api.duplicateFolder(f.id)
      if (copy) onScope({ type: 'folder', id: copy.id })
      return
    }
    if (r === 'export:dir') {
      flash('Экспортирую…')
      const n = await api.exportFolderDir(f.id)
      if (n !== null) flash(`Экспортировано файлов: ${n}`)
      return
    }
    if (r === 'export:zip') {
      flash('Собираю архив…')
      const n = await api.exportFolderZip(f.id)
      if (n !== null) flash(`В архиве файлов: ${n}`)
      return
    }
    if (r.startsWith('lib:')) {
      flash('Копирую в другую библиотеку…')
      const n = await api.copyFolderToLibrary(f.id, r === 'lib:pick' ? null : r.slice(4))
      if (n !== null) flash(`Скопировано новых файлов: ${n}`)
      return
    }
    if (r === 'showsub') return api.updateFolder(f.id, { showSub: !f.showSub })
    if (r === 'icon:none') return api.updateFolder(f.id, { icon: null })
    if (r.startsWith('icon:')) return api.updateFolder(f.id, { icon: r.slice(5) })
    if (r === 'color:none') return api.updateFolder(f.id, { color: null })
    if (r.startsWith('color:')) return api.updateFolder(f.id, { color: r.slice(6) })
    if (r === 'delete') {
      const ok = await api.confirm(`Удалить папку «${f.name}»?`, 'Вложенные папки тоже будут удалены. Файлы останутся в библиотеке.')
      if (ok) {
        await api.deleteFolder(f.id)
        if (scope.type === 'folder' && descendants(f.id).has(scope.id)) onScope({ type: 'all' })
      }
    }
  }

  // ----- keyboard shortcuts -----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : document.body
      if (t.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.cm-backdrop, .modal-backdrop, .viewer')) return
      const k = keyOf(e)
      if (e.ctrlKey && e.shiftKey && k === 'n') newFolder(current ? current.parentId : null)
      else if (e.altKey && k === 'n' && current) newFolder(current.id)
      else if (e.key === 'F2' && current) setEditing(current.id)
      else if (e.ctrlKey && e.shiftKey && k === 'r' && current) setAutoTagFor(current)
      else if (e.key === '/' && !e.ctrlKey && scope.type !== 'board') toggleAll()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const dropProps = (targetKey: string, onDrop: (e: React.DragEvent) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(FOLDER_MIME)) {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(targetKey)
      }
    },
    onDragLeave: () => setDropTarget((t) => (t === targetKey ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      onDrop(e)
    }
  })

  const folderIcon = (f: Folder) =>
    f.icon ? <Glyph value={f.icon} size={15} className="side-folder-icon" /> : <Icon name="folder" size={15} className="side-folder-icon" />

  const renameInput = (f: Folder) => (
    <input
      className="side-edit"
      autoFocus
      defaultValue={f.name}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        api.renameFolder(f.id, e.target.value)
        setEditing(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )

  const folderRow = (f: Folder, depth: number, quick = false) => {
    const kids = children.get(f.id) ?? []
    const open = isOpen(f.id)
    const s: Scope = { type: 'folder', id: f.id }
    const key = quick ? `q:${f.id}` : f.id
    return (
      <div
        key={key}
        className={`side-row${isActive(s) ? ' active' : ''}${dropTarget === key ? ' drop' : ''}`}
        style={{ paddingLeft: 10 + depth * 14, ...(f.color ? { ['--folder-color' as string]: f.color } : {}) }}
        onClick={() => onScope(s)}
        onDoubleClick={() => (prefs.folderDoubleClick === 'toggle' ? toggleOne(f) : setEditing(f.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          folderMenu(f)
        }}
        draggable={editing !== f.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, f.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        {...dropProps(key, (e) => {
          const moved = e.dataTransfer.getData(FOLDER_MIME)
          if (moved) api.moveFolder(moved, f.id)
          else api.importPaths(droppedPaths(e.dataTransfer), f.id)
        })}
      >
        {!quick && (
          <span
            className={`caret${kids.length ? '' : ' hidden'}${open ? ' open' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              toggleOne(f)
            }}
          >
            <Icon name="chevron-right" size={12} />
          </span>
        )}
        <span className="side-icon">{folderIcon(f)}</span>
        {editing === f.id && !quick ? renameInput(f) : <span className="side-name">{f.name}</span>}
        {f.locked && <Icon name="lock" size={12} className="side-lock" />}
        <span className="side-count">{f.count || ''}</span>
      </div>
    )
  }

  const renderFolder = (f: Folder, depth: number): React.ReactNode => (
    <div key={f.id}>
      {folderRow(f, depth)}
      {isOpen(f.id) && (children.get(f.id) ?? []).map((k) => renderFolder(k, depth + 1))}
    </div>
  )

  const pinned = folders.filter((f) => f.pinned)

  const allFixed: { s: Scope; label: string; icon: string; count: number; show: boolean }[] = [
    { s: { type: 'all' }, label: 'Все', icon: 'image', count: counts.all, show: true },
    { s: { type: 'uncategorized' }, label: 'Без папки', icon: 'folder', count: counts.uncategorized, show: prefs.showUncategorized },
    { s: { type: 'untagged' }, label: 'Без тегов', icon: 'tag', count: counts.untagged, show: prefs.showUntagged },
    { s: { type: 'trash' }, label: 'Корзина', icon: 'trash', count: counts.trash, show: true }
  ]
  const fixed = allFixed.filter((f) => f.show)
  const hide = [!prefs.showQuickAccess && 'hide-quick', !prefs.showFolders && 'hide-folders', !prefs.showBoards && 'hide-boards'].filter(Boolean).join(' ')

  return (
    <nav className={`sidebar ${hide}`}>
      <div className="side-scroll">
        <div className="side-group">
          {fixed.map((f) => (
            <div
              key={f.s.type}
              className={`side-row${isActive(f.s) ? ' active' : ''}`}
              onClick={() => onScope(f.s)}
              onContextMenu={async (e) => {
                if (f.s.type !== 'trash') return
                e.preventDefault()
                if ((await api.menu([{ id: 'empty', label: 'Очистить корзину', icon: 'trash', danger: true, enabled: counts.trash > 0 }])) === 'empty') {
                  if (await api.confirm('Очистить корзину?', 'Файлы будут удалены с диска безвозвратно.')) api.emptyTrash()
                }
              }}
            >
              <span className="side-icon">
                <Icon name={f.icon} size={15} />
              </span>
              <span className="side-name">{f.label}</span>
              <span className="side-count">{f.count || ''}</span>
            </div>
          ))}
        </div>

        {pinned.length > 0 && (
          <>
            <div className="side-header sec-quick">
              <span>Быстрый доступ</span>
            </div>
            <div className="side-group">{pinned.map((f) => folderRow(f, 0, true))}</div>
          </>
        )}

        <div
          className={`side-header sec-folders${dropTarget === 'root' ? ' drop' : ''}`}
          {...dropProps('root', (e) => {
            const moved = e.dataTransfer.getData(FOLDER_MIME)
            if (moved) api.moveFolder(moved, null)
          })}
        >
          <span>Папки</span>
          <button className="icon-btn small" title="Новая папка (Ctrl+Shift+N)" onClick={() => newFolder(null)}>
            +
          </button>
        </div>
        <div className="side-group">
          {(children.get(null) ?? []).map((f) => renderFolder(f, 0))}
          {!folders.length && <div className="side-hint">Создайте папку или перетащите сюда папку с диска</div>}
        </div>

        <div className="side-header sec-boards">
          <span>Мудборды</span>
          <button
            className="icon-btn small"
            title="Новый мудборд"
            onClick={async () => {
              const b = await api.createBoard('Новый мудборд')
              setEditingBoard(b.id)
              onScope({ type: 'board', id: b.id })
            }}
          >
            +
          </button>
        </div>
        <div className="side-group">
          {boards.map((b) => {
            const s: Scope = { type: 'board', id: b.id }
            return (
              <div
                key={b.id}
                className={`side-row${isActive(s) ? ' active' : ''}${dropTarget === `board:${b.id}` ? ' drop' : ''}`}
                onClick={() => onScope(s)}
                onDoubleClick={() => setEditingBoard(b.id)}
                onContextMenu={async (e) => {
                  e.preventDefault()
                  const r = await api.menu([
                    { id: 'rename', label: 'Переименовать', icon: 'rename' },
                    { id: 'export', label: 'Экспорт PNG…', icon: 'export' },
                    { type: 'separator' },
                    { id: 'delete', label: 'Удалить мудборд', icon: 'trash', danger: true }
                  ])
                  if (r === 'rename') setEditingBoard(b.id)
                  else if (r === 'export') api.exportBoard(b.id, 'file')
                  else if (r === 'delete' && (await api.confirm(`Удалить мудборд «${b.name}»?`, 'Файлы в библиотеке останутся.'))) {
                    await api.deleteBoard(b.id)
                    if (isActive(s)) onScope({ type: 'all' })
                  }
                }}
                {...dropProps(`board:${b.id}`, (e) => {
                  const p = droppedPaths(e.dataTransfer)
                  if (p.length) api.boardAddPaths(b.id, p)
                })}
              >
                <span className="side-icon">
                  <Icon name="board" size={15} />
                </span>
                {editingBoard === b.id ? (
                  <input
                    className="side-edit"
                    autoFocus
                    defaultValue={b.name}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      api.renameBoard(b.id, e.target.value)
                      setEditingBoard(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditingBoard(null)
                    }}
                  />
                ) : (
                  <span className="side-name">{b.name}</span>
                )}
                <span className="side-count">{b.count || ''}</span>
              </div>
            )
          })}
          {!boards.length && <div className="side-hint">Соберите мудборд для проекта из своих ассетов</div>}
        </div>

      </div>
      {notice && <div className="side-notice">{notice}</div>}
      <AiStatusBar />

      {autoTagFor && <AutoTagDialog folder={autoTagFor} allTags={tags.map((t) => t.name)} onClose={() => setAutoTagFor(null)} />}
      {password && <PasswordDialog folder={password.folder} mode={password.mode} onClose={() => setPassword(null)} />}
    </nav>
  )
}
