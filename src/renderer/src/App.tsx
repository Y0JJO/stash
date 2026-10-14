import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardInfo, Counts, Filters, Folder, ImportProgress, ItemLite, LibraryInfo, MenuEntry, Query, Scope, SortKey, TagCount } from '../../shared/types'
import { NO_FILTERS } from '../../shared/types'
import { api, droppedPaths } from './api'
import { activeFilterCount, FilterBar } from './components/FilterBar'
import { Grid } from './components/Grid'
import { Peek, type PeekState } from './components/Peek'
import { QuickSwitch } from './components/QuickSwitch'
import { PinterestPanel } from './components/PinterestPanel'
import { TelegramDialog } from './components/TelegramDialog'
import { StoryboardDialog } from './components/StoryboardDialog'
import { ConvertDialog } from './components/ConvertDialog'
import { PluginManagerDialog } from './components/PluginManagerDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { LockScreen } from './components/LockScreen'
import { getSettings, useSettings } from './settings'
import { BoardView } from './components/BoardView'
import { ContextMenuHost } from './components/ContextMenu'
import { Icon } from './components/Icon'
import { PasswordDialog } from './components/FolderDialogs'
import { Inspector } from './components/Inspector'
import { Sidebar } from './components/Sidebar'
import { Viewer } from './components/Viewer'
import { Welcome } from './components/Welcome'
import { itemsLabel, loadPref, savePref } from './util'

export default function App() {
  const [lib, setLib] = useState<LibraryInfo | null | undefined>(undefined)

  // App lock: asked on start when a password is set, and after "Заблокировать сейчас".
  const [locked, setLocked] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    api.currentLibrary().then(setLib)
    api.hasLock().then(setLocked)
    return api.onSwitched(setLib)
  }, [])

  if (locked === undefined) return null
  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />

  return (
    <>
      {lib === undefined ? null : !lib ? <Welcome onOpened={setLib} /> : <Workspace key={lib.path} lib={lib} onLock={() => setLocked(true)} />}
      <ContextMenuHost />
    </>
  )
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'added', label: 'Дата добавления' },
  { key: 'name', label: 'Имя' },
  { key: 'size', label: 'Размер файла' },
  { key: 'rating', label: 'Рейтинг' },
  { key: 'duration', label: 'Длительность' },
  { key: 'random', label: 'Случайно' }
]

const SEARCH_ENGINES: [string, string][] = [
  ['google', 'Google Lens'],
  ['yandex', 'Яндекс Картинки'],
  ['bing', 'Bing'],
  ['tineye', 'TinEye'],
  ['saucenao', 'SauceNAO']
]

const EMPTY_COUNTS: Counts = { all: 0, uncategorized: 0, untagged: 0, trash: 0 }

function Workspace({ lib, onLock }: { lib: LibraryInfo; onLock(): void }) {
  const prefs = useSettings()
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  /** Items that just arrived from an import — selected once the grid shows them. */
  const pendingSelect = useRef<string[]>([])
  const [scope, setScopeState] = useState<Scope>({ type: 'all' })
  const [search, setSearch] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [kind, setKind] = useState<Query['kind']>(() => loadPref('kind', 'all'))
  const [sort, setSort] = useState<SortKey>(() => loadPref('sort', 'added'))
  const [desc, setDesc] = useState<boolean>(() => loadPref('desc', true))
  const [color, setColor] = useState<string | null>(null)
  const [tileSize, setTileSize] = useState<number>(() => loadPref('tileSize', 220))
  const [showLabels, setShowLabels] = useState<boolean>(() => loadPref('showLabels', true))
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [showFilters, setShowFilters] = useState<boolean>(() => loadPref('showFilters', false))
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))
  const [hoverPreview, setHoverPreview] = useState<boolean>(() => loadPref('hoverPreview', false))
  const [soundOn, setSoundOn] = useState<boolean>(() => loadPref('soundOn', false))
  const [peek, setPeek] = useState<PeekState | null>(null)
  const [quick, setQuick] = useState(false)
  const [pinItem, setPinItem] = useState<ItemLite | null>(null)
  const [boardItem, setBoardItem] = useState<ItemLite | null>(null)
  const [convertItems, setConvertItems] = useState<ItemLite[] | null>(null)
  const [boardFocus, setBoardFocus] = useState(false)
  /** "Показать в библиотеке" from a board: select + scroll to the item once the grid has it. */
  const pendingReveal = useRef<string | null>(null)

  // Test hook (used by automated screenshots): open panels for an item by name.
  useEffect(() => {
    ;(window as unknown as { __stashTest: object }).__stashTest = {
      pinterest: (name: string) => setPinItem(items.find((i) => i.name === name) ?? null),
      storyboard: (name: string) => setBoardItem(items.find((i) => i.name === name) ?? null),
      scope: (sc: Scope) => setScope(sc),
      plugins: () => setShowPlugins(true),
      view: (name: string, ext: string) => setViewer(items.findIndex((i) => i.name === name && i.ext === ext)),
      find: (name: string, ext: string) => items.find((i) => i.name === name && i.ext === ext)?.id,
      convert: (names: string[]) => setConvertItems(items.filter((i) => names.includes(i.name)))
    }
  })

  const [items, setItems] = useState<ItemLite[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [reveal, setReveal] = useState<{ index: number } | null>(null)
  const anchor = useRef(-1)
  const [viewer, setViewer] = useState<number | null>(null)

  const [folders, setFolders] = useState<Folder[]>([])
  const [showTelegram, setShowTelegram] = useState(false)
  const [tags, setTags] = useState<TagCount[]>([])
  const [boards, setBoards] = useState<BoardInfo[]>([])
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS)
  const [version, setVersion] = useState(0)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [dropping, setDropping] = useState(false)
  const draggingOut = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    savePref('kind', kind)
    savePref('sort', sort)
    savePref('desc', desc)
    savePref('tileSize', tileSize)
    savePref('showLabels', showLabels)
    savePref('showFilters', showFilters)
    savePref('hoverPreview', hoverPreview)
    savePref('soundOn', soundOn)
  }, [kind, sort, desc, tileSize, showLabels, showFilters, hoverPreview, soundOn])

  useEffect(() => {
    const t = setTimeout(() => setSearchQ(search), 150)
    return () => clearTimeout(t)
  }, [search])

  // Password-protected folders: unlocked ones are remembered for this session only.
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set())
  const [unlockFor, setUnlockFor] = useState<{ folder: Folder; then: Scope } | null>(null)
  const lockedAncestor = (id: string): Folder | null => {
    let cur = folders.find((f) => f.id === id)
    while (cur) {
      if (cur.locked && !unlocked.has(cur.id)) return cur
      cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined
    }
    return null
  }

  const setScope = (s: Scope) => {
    if (s.type === 'folder') {
      const lock = lockedAncestor(s.id)
      if (lock) return setUnlockFor({ folder: lock, then: s })
    }
    setScopeState(s)
    setSelected([])
    anchor.current = -1
  }

  // A folder may override the sort order ("Сортировка" in the folder menu).
  const sortFolder = scope.type === 'folder' ? folders.find((f) => f.id === scope.id && f.sortKey) ?? null : null
  const effSort: SortKey = sortFolder?.sortKey ?? sort
  const effDesc = sortFolder ? sortFolder.sortDesc : desc
  const changeSort = (k: SortKey) => (sortFolder ? api.updateFolder(sortFolder.id, { sortKey: k }) : setSort(k))
  const flipDesc = () => (sortFolder ? api.updateFolder(sortFolder.id, { sortDesc: !sortFolder.sortDesc }) : setDesc((d) => !d))

  const query = useMemo<Query>(
    () => ({ scope, search: searchQ, kind, sort: effSort, desc: effDesc, color, filters, seed }),
    [scope, searchQ, kind, effSort, effDesc, color, filters, seed]
  )

  // Ignore stale responses when queries overlap.
  const reqId = useRef(0)
  const loadItems = useCallback(async () => {
    const id = ++reqId.current
    const rows = await api.query(query)
    if (id !== reqId.current) return
    setItems(rows)
    const ids = new Set(rows.map((r) => r.id))
    setSelected((sel) => (sel.every((s) => ids.has(s)) ? sel : sel.filter((s) => ids.has(s))))
  }, [query])

  const loadSide = useCallback(async () => {
    const [f, t, c, b] = await Promise.all([api.folders(), api.tags(), api.counts(), api.boards()])
    setFolders(f)
    setTags(t)
    setCounts(c)
    setBoards(b)
  }, [])

  const loadItemsRef = useRef(loadItems)
  loadItemsRef.current = loadItems

  useEffect(() => {
    loadItems()
  }, [loadItems])

  useEffect(() => {
    loadSide()
    const offs = [
      api.onChanged(() => {
        loadItemsRef.current()
        loadSide()
        setVersion((v) => v + 1)
      }),
      api.onThumbs((batch) => {
        const m = new Map(batch.map((b) => [b.id, b]))
        setItems((prev) =>
          prev.map((it) => {
            const u = m.get(it.id)
            return u ? { ...it, thumb: u.thumb, thumbV: u.thumbV || it.thumbV } : it
          })
        )
        if (batch.some((b) => b.thumb === 1)) setVersion((v) => v + 1)
      }),
      api.onProgress(setProgress),
      api.onImportAdded((ids) => {
        if (getSettings().selectAfterImport) pendingSelect.current.push(...ids)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [loadSide])

  // Leave a finished import banner up for a moment.
  useEffect(() => {
    if (progress && !progress.running) {
      const t = setTimeout(() => setProgress(null), 4000)
      return () => clearTimeout(t)
    }
  }, [progress])

  // A scope pointing at a deleted folder falls back to "All".
  useEffect(() => {
    if (scope.type === 'folder' && folders.length && !folders.some((f) => f.id === scope.id)) setScope({ type: 'all' })
  }, [folders, scope])

  useEffect(() => {
    const id = pendingReveal.current
    if (!id) return
    const i = items.findIndex((x) => x.id === id)
    if (i >= 0) {
      pendingReveal.current = null
      setSelected([id])
      setReveal({ index: i })
    }
  }, [items])
  useEffect(() => {
    if (scope.type !== 'board') setBoardFocus(false)
  }, [scope])

  useEffect(() => {
    if (!pendingSelect.current.length || progress?.running) return
    const have = new Set(items.map((x) => x.id))
    const fresh = pendingSelect.current.filter((id) => have.has(id))
    if (!fresh.length) return
    pendingSelect.current = []
    setSelected(fresh)
    setReveal({ index: items.findIndex((x) => x.id === fresh[0]) })
  }, [items, progress])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const folderId = scope.type === 'folder' ? scope.id : null

  // Plugins ask Stash for "the selected items" and "the current folder".
  useEffect(() => api.reportSelection(selected, folderId), [selected, folderId])

  // Plugins can also select/open things in the main window.
  const itemsRef = useRef(items)
  itemsRef.current = items
  useEffect(() => {
    const offs = [
      api.onPluginSelect((ids) => setSelected(ids)),
      api.onPluginOpenFolder((id) => setScope({ type: 'folder', id })),
      api.onPluginOpenItem((id) => {
        const i = itemsRef.current.findIndex((x) => x.id === id)
        if (i >= 0) {
          setSelected([id])
          setViewer(i)
        }
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
  const inTrash = scope.type === 'trash'

  const scopeTitle = useMemo(() => {
    switch (scope.type) {
      case 'all':
        return 'Все'
      case 'uncategorized':
        return 'Без папки'
      case 'untagged':
        return 'Без тегов'
      case 'trash':
        return 'Корзина'
      case 'tag':
        return `#${scope.name}`
      case 'folder':
        return folders.find((f) => f.id === scope.id)?.name ?? 'Папка'
      case 'similar':
        return 'Похожие'
      case 'board':
        return boards.find((b) => b.id === scope.id)?.name ?? 'Мудборд'
    }
  }, [scope, folders, boards])

  const removeSelected = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return
      if (inTrash) {
        if (await api.confirm(`Удалить ${itemsLabel(ids.length)} навсегда?`, 'Файлы будут удалены с диска.')) api.deleteForever(ids)
      } else api.trash(ids)
    },
    [inTrash]
  )

  const selectIndex = (i: number) => {
    const it = items[i]
    if (!it) return
    setSelected([it.id])
    anchor.current = i
    setReveal({ index: i })
  }

  // ---------- grid handlers ----------

  const onDown = (i: number, e: React.MouseEvent) => {
    if (e.button === 1 && prefs.middleClick !== 'none') {
      e.preventDefault() // no autoscroll cursor
      if (prefs.middleClick === 'external') void api.openExternal(items[i].id)
      else setViewer(i)
      return
    }
    if (e.button !== 0) return
    const id = items[i].id
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
      anchor.current = i
    } else if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = anchor.current < i ? [anchor.current, i] : [i, anchor.current]
      setSelected(items.slice(a, b + 1).map((x) => x.id))
    } else if (!selectedSet.has(id)) {
      setSelected([id])
      anchor.current = i
    }
  }

  const onClick = (i: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    const id = items[i].id
    if (selected.length > 1 && selectedSet.has(id)) {
      setSelected([id])
      anchor.current = i
    }
  }

  const onMenu = async (i: number, e: React.MouseEvent) => {
    e.preventDefault()
    const id = items[i].id
    const ids = selectedSet.has(id) ? selected : [id]
    if (!selectedSet.has(id)) {
      setSelected([id])
      anchor.current = i
    }
    const single = ids.length === 1
    const isVisual = items[i].kind !== 'other'
    const hasVector = single && (await api.hasVector(id))
    const entries: MenuEntry[] = inTrash
      ? [
          { id: 'restore', label: 'Восстановить', icon: 'restore' },
          { type: 'separator' },
          { id: 'forever', label: 'Удалить навсегда', icon: 'trash', danger: true }
        ]
      : [
          { id: 'view', label: 'Просмотр', icon: 'eye', shortcut: 'Пробел', enabled: single },
          { id: 'external', label: 'Открыть во внешнем приложении', icon: 'external', enabled: single },
          { id: 'reveal', label: 'Показать в проводнике', icon: 'folder-open', enabled: single },
          { id: 'copyPath', label: 'Копировать путь', icon: 'path', enabled: single },
          { type: 'separator' },
          { id: 'similar', label: 'Найти похожие в библиотеке', icon: 'sparkle', enabled: hasVector },
          { id: 'pinterest', label: 'Найти похожее на Pinterest', icon: 'pinterest', enabled: single && isVisual },
          {
            label: 'Добавить на мудборд',
            icon: 'board',
            submenu: [
              ...boards.map((b) => ({ id: `board:${b.id}`, label: b.name })),
              ...(boards.length ? [{ type: 'separator' as const }] : []),
              { id: 'board:new', label: 'Новый мудборд из выбранного…' }
            ]
          },
          ...(items[i].kind === 'video' ? [{ id: 'storyboard', label: 'Раскадровка…', icon: 'film', enabled: single }] : []),
          {
            label: 'Искать в интернете',
            icon: 'globe',
            enabled: single && isVisual,
            submenu: SEARCH_ENGINES.map(([key, label]) => ({ id: `web:${key}`, label }))
          },
          { type: 'separator' },
          { id: 'convert', label: 'Конвертировать…', icon: 'repeat-2', enabled: items.some((x) => ids.includes(x.id) && x.kind !== 'other') },
          ...(folderId ? [{ id: 'unfolder', label: 'Убрать из этой папки', icon: 'minus' }] : []),
          { id: 'retag', label: 'Обновить автотеги', icon: 'tag' },
          { id: 'regen', label: 'Обновить миниатюры', icon: 'refresh' },
          { type: 'separator' },
          { id: 'trash', label: 'В корзину', icon: 'trash', shortcut: 'Del', danger: true }
        ]
    const choice = await api.menu(entries)
    if (choice?.startsWith('web:')) return void api.webSearch(id, choice.slice(4))
    if (choice === 'board:new') {
      const b = await api.createBoard(ids.length > 1 ? `Мудборд (${ids.length})` : items[i].name, ids)
      setScope({ type: 'board', id: b.id })
      return
    }
    if (choice?.startsWith('board:')) return void api.boardAddItems(choice.slice(6), ids)
    switch (choice) {
      case 'similar':
        setScope({ type: 'similar', id })
        break
      case 'pinterest':
        setPinItem(items[i])
        break
      case 'storyboard':
        setBoardItem(items[i])
        break
      case 'view':
        setViewer(i)
        break
      case 'external':
        api.openExternal(id)
        break
      case 'reveal':
        api.showInFolder(id)
        break
      case 'copyPath':
        api.copyPath(id)
        break
      case 'unfolder':
        if (folderId) api.removeFromFolder(ids, folderId)
        break
      case 'regen':
        api.regenThumbs(ids)
        break
      case 'retag':
        api.retag(ids)
        break
      case 'convert':
        setConvertItems(items.filter((x) => ids.includes(x.id) && x.kind !== 'other'))
        break
      case 'trash':
        api.trash(ids)
        break
      case 'restore':
        api.restore(ids)
        break
      case 'forever':
        removeSelected(ids)
        break
    }
  }

  const onDragOut = (i: number) => {
    const id = items[i].id
    const ids = selectedSet.has(id) ? selected : [id]
    draggingOut.current = true
    api.startDrag(ids)
  }

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewer !== null || quick || pinItem || boardItem || convertItems || showSettings || showPlugins || scope.type === 'board') return
      const t = e.target instanceof Element ? e.target : document.body
      const inField = !!t.closest('input, textarea, select')
      const key = e.key.toLowerCase()

      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      if (e.ctrlKey && key === 'k') {
        e.preventDefault()
        setQuick(true)
        return
      }

      if (e.ctrlKey && key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (inField) return

      if (e.ctrlKey && key === 'a') {
        e.preventDefault()
        setSelected(items.map((i) => i.id))
      } else if (e.ctrlKey && key === 'v') {
        e.preventDefault()
        if (!inTrash) api.paste(folderId)
      } else if (e.key === 'Delete') {
        removeSelected(selected)
      } else if ((e.key === ' ' && prefs.spacePreview) || e.key === 'Enter') {
        if (!selected.length) return
        e.preventDefault()
        const i = items.findIndex((x) => x.id === selected[selected.length - 1])
        if (i >= 0) setViewer(i)
      } else if (e.key === 'Escape') {
        setSelected([])
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const cur = items.findIndex((x) => x.id === selected[selected.length - 1])
        selectIndex(cur < 0 ? 0 : Math.max(0, Math.min(items.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- drop to import ----------

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    const reset = () => (draggingOut.current = false)
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    window.addEventListener('mousemove', reset)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('mousemove', reset)
    }
  }, [])

  const pluginsMenu = async () => {
    const list = (await api.plugins()).filter((p) => p.kind !== 'module' && p.enabled)
    const r = await api.menu([
      ...list.map((p) => ({ id: `run:${p.id}`, label: `${p.name}${p.kind === 'service' ? ' (фоновый)' : ''}` })),
      ...(list.length ? [{ type: 'separator' as const }] : [{ label: 'Плагинов пока нет', enabled: false }, { type: 'separator' as const }]),
      { id: 'manager', label: 'Менеджер плагинов…', icon: 'plugins' },
      { id: 'install', label: 'Установить плагин…', icon: 'plus' }
    ])
    if (r?.startsWith('run:')) api.runPlugin(r.slice(4))
    else if (r === 'manager') setShowPlugins(true)
    else if (r === 'install') api.installPluginDialog()
  }

  const libMenu = async () => {
    const recent = (await api.recentLibraries()).filter((p) => p !== lib.path)
    const r = await api.menu([
      ...recent.map((p) => ({ id: `open:${p}`, label: p })),
      ...(recent.length ? [{ type: 'separator' as const }] : []),
      { id: 'open', label: 'Открыть библиотеку…' },
      { id: 'create', label: 'Создать библиотеку…' },
      { type: 'separator' },
      { id: 'reveal', label: 'Открыть папку библиотеки', icon: 'folder-open' },
      { type: 'separator' },
      { id: 'settings', label: 'Настройки…', icon: 'settings', shortcut: 'Ctrl+,' },
      { id: 'lock', label: 'Заблокировать сейчас', icon: 'lock', enabled: await api.hasLock() }
    ])
    if (r?.startsWith('open:')) api.openLibrary(r.slice(5))
    else if (r === 'open') api.openLibraryDialog()
    else if (r === 'create') api.createLibrary()
    else if (r === 'reveal') api.revealLibrary()
    else if (r === 'settings') setShowSettings(true)
    else if (r === 'lock') onLock()
  }

  return (
    <div className={`app${boardFocus && scope.type === 'board' ? ' focus' : ''}`}>
      <header className="titlebar">
        <button className="lib-switch" onClick={libMenu} title="Сменить библиотеку">
          <span className="lib-dot" />
          {lib.name}
          <Icon name="chevron-down" size={14} className="muted" />
        </button>
        <div className="toolbar">
          <div className="scope-title">{scopeTitle}</div>
          <div className="search">
            <input ref={searchRef} value={search} placeholder="Поиск: имя, тег, заметка…  (Ctrl+F)" onChange={(e) => setSearch(e.target.value)} />
            {search && (
              <button className="icon-btn small" onClick={() => setSearch('')}>
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
          {scope.type !== 'board' && (
          <>
          <div className="segmented">
            {(['all', 'image', 'video'] as const).map((k) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'all' ? 'Все' : k === 'image' ? 'Фото' : 'Видео'}
              </button>
            ))}
          </div>
          {color && (
            <button className="color-chip" onClick={() => setColor(null)} title="Сбросить фильтр по цвету">
              <span style={{ background: color }} />
              <Icon name="close" size={12} />
            </button>
          )}
          <button
            className={`icon-btn${showFilters || activeFilterCount(filters, color) ? ' on' : ''}`}
            onClick={() => setShowFilters((v) => !v)}
            title="Фильтры"
          >
            <Icon name="filter" size={15} />
            Фильтры{activeFilterCount(filters, color) ? ` · ${activeFilterCount(filters, color)}` : ''}
          </button>
          <select value={effSort} onChange={(e) => changeSort(e.target.value as SortKey)} title={sortFolder ? 'Сортировка этой папки' : 'Сортировка'}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          {effSort === 'random' ? (
            <button className="icon-btn" onClick={() => setSeed(Math.floor(Math.random() * 1e9))} title="Перемешать">
              <Icon name="shuffle" size={15} />
            </button>
          ) : (
            <button className="icon-btn" onClick={flipDesc} title={effDesc ? 'По убыванию' : 'По возрастанию'}>
              <Icon name={effDesc ? 'sort-desc' : 'sort-asc'} size={15} />
            </button>
          )}
          <input
            type="range"
            className="size-slider"
            min={110}
            max={520}
            value={tileSize}
            onChange={(e) => setTileSize(Number(e.target.value))}
            title="Размер миниатюр"
          />
          <button className={`icon-btn${showLabels ? ' on' : ''}`} onClick={() => setShowLabels((v) => !v)} title="Подписи">
            <Icon name="type" size={15} />
          </button>
          <button
            className={`icon-btn${hoverPreview ? ' on' : ''}`}
            onClick={() => setHoverPreview((v) => !v)}
            title="Увеличенное превью при наведении"
          >
            <Icon name="peek" size={15} />
          </button>
          <button className="icon-btn" onClick={() => api.captureArea(folderId)} title="Скриншот области экрана (Alt+Shift+S)">
            <Icon name="capture" size={15} />
          </button>
          <button className="icon-btn" onClick={pluginsMenu} title="Плагины">
            <Icon name="plugins" size={15} />
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Настройки (Ctrl+,)">
            <Icon name="settings" size={15} />
          </button>
          <button className="icon-btn" onClick={() => setShowTelegram(true)} title="Telegram-бот: присылайте файлы и ссылки в D3S3RT">
            <Icon name="telegram" size={15} />
          </button>
          </>
          )}
          {inTrash ? (
            <button
              className="primary"
              disabled={!counts.trash}
              onClick={async () => {
                if (await api.confirm('Очистить корзину?', 'Файлы будут удалены с диска безвозвратно.')) api.emptyTrash()
              }}
            >
              Очистить
            </button>
          ) : (
            <button className="primary" onClick={() => api.importDialog(folderId)} title="Импорт файлов (или перетащите их в окно)">
              + Импорт
            </button>
          )}
        </div>
      </header>

      <Sidebar
        scope={scope}
        onScope={setScope}
        folders={folders}
        tags={tags}
        counts={counts}
        boards={boards}
        libPath={lib.path}
        unlocked={unlocked}
        onLock={(id) => {
          setUnlocked((u) => {
            const n = new Set(u)
            n.delete(id)
            return n
          })
          if (scope.type === 'folder') setScopeState({ type: 'all' })
        }}
      />
      {showSettings && (
        <SettingsDialog
          folders={folders}
          onClose={() => setShowSettings(false)}
          onOpenTelegram={() => {
            setShowSettings(false)
            setShowTelegram(true)
          }}
          onLockNow={() => {
            setShowSettings(false)
            onLock()
          }}
        />
      )}
      {showTelegram && <TelegramDialog folders={folders} onClose={() => setShowTelegram(false)} />}
      {unlockFor && (
        <PasswordDialog
          folder={unlockFor.folder}
          mode="unlock"
          onClose={() => setUnlockFor(null)}
          onUnlocked={() => {
            const next = new Set(unlocked).add(unlockFor.folder.id)
            setUnlocked(next)
            setScopeState(unlockFor.then)
            setSelected([])
          }}
        />
      )}

      <main
        className="main"
        onDragEnter={(e) => {
          if (!draggingOut.current && e.dataTransfer.types.includes('Files') && !inTrash) setDropping(true)
        }}
        onDragOver={(e) => {
          if (dropping) e.preventDefault()
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          draggingOut.current = false
          const paths = droppedPaths(e.dataTransfer)
          if (paths.length) api.importPaths(paths, folderId)
        }}
      >
        {scope.type === 'board' ? (
          <BoardView
            boardId={scope.id}
            version={version}
            focus={boardFocus}
            onFocus={setBoardFocus}
            onLocateItem={(id) => {
              setBoardFocus(false)
              setScope({ type: 'all' })
              pendingReveal.current = id
            }}
            onSelectItems={setSelected}
            onOpenItem={(id) => {
              const i = items.findIndex((x) => x.id === id)
              if (i >= 0) setViewer(i)
            }}
          />
        ) : (
        <>
        {(showFilters || activeFilterCount(filters, color) > 0) && (
          <FilterBar filters={filters} onFilters={setFilters} color={color} onColor={setColor} allTags={tags.map((t) => t.name)} version={version} />
        )}
        <div className="grid-wrap">
        <Grid
          items={items}
          selected={selectedSet}
          tileSize={tileSize}
          showLabels={showLabels}
          reveal={reveal}
          resetKey={JSON.stringify(scope)}
          down={onDown}
          click={onClick}
          open={(i) => (prefs.itemDoubleClick === 'external' ? void api.openExternal(items[i].id) : setViewer(i))}
          menu={onMenu}
          drag={onDragOut}
          hoverPreview={hoverPreview}
          soundOn={soundOn}
          peek={(i, rect) => setPeek(i === null || !rect ? null : { item: items[i], rect })}
          sound={() => setSoundOn((v) => !v)}
          onBackground={() => setSelected([])}
          empty={
            searchQ || color || kind !== 'all' ? (
              <>Ничего не найдено</>
            ) : inTrash ? (
              <>Корзина пуста</>
            ) : (
              <>
                <div className="grid-empty-title">Перетащите сюда картинки, видео или целые папки</div>
                <div className="muted">или нажмите «+ Импорт», или вставьте из буфера — Ctrl+V</div>
              </>
            )
          }
        />
        {dropping && (
          <div className="drop-overlay">
            <div>Отпустите, чтобы импортировать{folderId ? ` в «${scopeTitle}»` : ''}</div>
          </div>
        )}
        {progress && (
          <div className="progress">
            {progress.running ? `Импорт ${progress.done} / ${progress.total}` : `Импортировано: ${progress.done - progress.skipped - progress.failed}`}
            {progress.skipped > 0 && prefs.notifyDuplicates && <span className="muted"> · дубликатов {progress.skipped}</span>}
            {progress.failed > 0 && <span className="warn"> · ошибок {progress.failed}</span>}
            {progress.running && (
              <div className="progress-bar">
                <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
            )}
          </div>
        )}
        </div>
        </>
        )}
      </main>

      <Inspector
        selected={selected}
        items={items}
        version={version}
        tags={tags}
        folders={folders}
        scopeTitle={scopeTitle}
        onColor={setColor}
      />

      {peek && viewer === null && <Peek {...peek} />}
      {pinItem && (
        <PinterestPanel
          item={pinItem}
          folderId={folderId}
          folderName={folderId ? (folders.find((f) => f.id === folderId)?.name ?? null) : null}
          onClose={() => setPinItem(null)}
        />
      )}
      {showPlugins && <PluginManagerDialog onClose={() => setShowPlugins(false)} />}
      {convertItems && <ConvertDialog items={convertItems} onClose={() => setConvertItems(null)} />}
      {boardItem && (
        <StoryboardDialog
          item={boardItem}
          folderId={folderId}
          onClose={() => setBoardItem(null)}
          onDone={(id) => {
            setBoardItem(null)
            if (id) setScope({ type: 'folder', id })
          }}
        />
      )}
      {quick && <QuickSwitch folders={folders} tags={tags} onPick={setScope} onClose={() => setQuick(false)} />}

      {viewer !== null && (
        <Viewer
          items={items}
          index={viewer}
          onGrabFrame={(id, t, target) => api.grabFrame(id, t, folderId, target)}
          onIndex={(i) => {
            setViewer(i)
            selectIndex(i)
          }}
          onClose={() => {
            selectIndex(viewer)
            setViewer(null)
          }}
        />
      )}
    </div>
  )
}
