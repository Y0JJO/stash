import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type ExtensionInfo, type PluginInfo } from '../api'
import { fmtSize } from '../util'
import { Icon } from './Icon'

type Tab = 'all' | 'window' | 'service' | 'module'

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'window', label: 'Инструменты' },
  { id: 'service', label: 'Фоновые' },
  { id: 'module', label: 'Модули' }
]

const KIND_LABEL: Record<PluginInfo['kind'], string> = { window: 'Инструмент', service: 'Фоновый', module: 'Модуль' }

/**
 * Extensions (.stashplugin) and the plugins they provide: run, stop, switch off, inspect, remove,
 * install from a file.
 */
export function PluginManagerDialog({ onClose }: { onClose(): void }) {
  const [list, setList] = useState<PluginInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>('all')

  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const [formats, setFormats] = useState<string[]>([])

  const reload = useCallback(() => {
    api.plugins().then(setList).catch(() => setList([]))
    api.extensions().then(setExts).catch(() => setExts([]))
    api.pluginFormats().then(setFormats).catch(() => setFormats([]))
  }, [])

  const removeExt = async (x: ExtensionInfo) => {
    if (await api.confirm(`Удалить расширение «${x.name}»?`, 'Плагины, которые оно запускает, останутся на диске, но перестанут работать.', 'Удалить')) api.uninstallExtension(x.id)
  }
  // Extra file formats installed extensions can read (everything except Stash's own).
  const foreign = formats.filter((f) => f !== 'stashplugin')

  useEffect(() => {
    reload()
    return api.onPluginsChanged(reload)
  }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.cm-backdrop')) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (list ?? []).filter(
      (p) => (tab === 'all' || p.kind === tab) && (!s || `${p.name} ${p.description} ${p.keywords.join(' ')} ${p.id}`.toLowerCase().includes(s))
    )
  }, [list, q, tab])

  const more = async (p: PluginInfo) => {
    const r = await api.menu(
      [
        ...(p.kind !== 'module'
          ? [
              { id: 'restart', label: 'Перезапустить', icon: 'refresh-cw', enabled: p.enabled },
              { id: 'stop', label: 'Остановить', icon: 'square', enabled: p.running },
              { id: 'devtools', label: 'Инструменты разработчика', icon: 'code', enabled: p.running },
              { type: 'separator' as const }
            ]
          : []),
        { id: 'reveal', label: 'Открыть папку плагина', icon: 'folder' },
        { id: 'copy', label: 'Скопировать ID', icon: 'copy' },
        { type: 'separator' as const },
        { id: 'remove', label: 'Удалить плагин', icon: 'trash', danger: true }
      ],
      { search: false }
    )
    if (r === 'restart') api.restartPlugin(p.id)
    else if (r === 'stop') api.stopPlugin(p.id)
    else if (r === 'devtools') api.pluginDevtools(p.id)
    else if (r === 'reveal') api.revealPlugin(p.id)
    else if (r === 'copy') navigator.clipboard.writeText(p.id)
    else if (r === 'remove' && (await api.confirm(`Удалить плагин «${p.name}»?`, 'Файлы плагина будут удалены с диска.', 'Удалить'))) api.uninstallPlugin(p.id)
  }

  const total = (list ?? []).reduce((s, p) => s + p.size, 0)

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div className="plugman" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <Icon name="plugins" size={18} />
          <div className="pm-title">Плагины</div>
          <button className="primary" onClick={() => api.installPluginDialog()}>
            Установить из файла…
          </button>
          <button className="icon-btn" onClick={onClose} title="Закрыть (Esc)">
            <Icon name="close" size={16} />
          </button>
        </div>

        {foreign.length > 0 && (
          <div className="pm-tools">
            <div className="pm-search">
              <Icon name="search" size={15} />
              <input autoFocus value={q} placeholder="Поиск по плагинам…" onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="pm-tabs">
              {TABS.map((t) => (
                <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                  {t.label}
                  {list && t.id !== 'all' ? ` ${list.filter((p) => p.kind === t.id).length}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pm-list">
          <div className="pm-section">Расширения Stash</div>
          {!exts.length && (
            <div className="pm-note">
              Расширений пока нет. Чтобы добавить, нажмите «Установить из файла…» и выберите файл .stashplugin.
            </div>
          )}
          {exts.map((x) => (
            <div key={x.id} className={`pm-row${x.enabled ? '' : ' off'}`}>
              <div className="pm-logo">
                <Icon name="plugins" size={20} />
              </div>
              <div className="pm-info">
                <div className="pm-name">
                  {x.name}
                  {x.version && <span className="v">v{x.version}</span>}
                  {x.active && <span className="pm-badge run">Работает</span>}
                  {!x.enabled && <span className="pm-badge">Выключено</span>}
                  {x.error && <span className="pm-badge err">Ошибка</span>}
                </div>
                <div className="pm-desc" title={x.error ?? x.description}>
                  {x.error ?? x.description}
                  {x.formats.length > 0 && ` · читает: ${x.formats.map((f) => `.${f}`).join(', ')}`}
                </div>
              </div>
              <div className="pm-actions">
                <label className="switch" title={x.enabled ? 'Выключить расширение' : 'Включить расширение'}>
                  <input type="checkbox" checked={x.enabled} onChange={(e) => api.setExtensionEnabled(x.id, e.target.checked)} />
                  <span />
                </label>
                <button className="icon-btn" onClick={() => removeExt(x)} title="Удалить расширение">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          ))}

          {foreign.length > 0 && <div className="pm-section">Плагины ({foreign.map((f) => `.${f}`).join(', ')})</div>}
          {foreign.length > 0 && list && !shown.length && (
            <div className="pm-empty">
              {list.length ? 'Ничего не найдено' : 'Плагинов пока нет. Нажмите «Установить из файла…» или перетащите файл плагина в окно Stash.'}
            </div>
          )}
          {shown.map((p) => (
            <div key={p.id} className={`pm-row${p.enabled ? '' : ' off'}`}>
              <div className="pm-logo">{p.logo ? <img src={p.logo} alt="" draggable={false} /> : <Icon name="plugins" size={20} />}</div>
              <div className="pm-info">
                <div className="pm-name">
                  {p.name}
                  {p.version && <span className="v">v{p.version}</span>}
                  <span className="pm-badge">{KIND_LABEL[p.kind]}</span>
                  {p.running && <span className="pm-badge run">Запущен</span>}
                  {!p.enabled && <span className="pm-badge">Выключен</span>}
                </div>
                <div className="pm-desc" title={p.description || p.keywords.join(', ')}>
                  {p.description || p.keywords.slice(0, 6).join(' · ') || p.id} · {fmtSize(p.size)}
                </div>
              </div>
              <div className="pm-actions">
                {p.kind === 'window' && (
                  <button className="run" disabled={!p.enabled} onClick={() => api.runPlugin(p.id)}>
                    {p.running ? 'Показать' : 'Запустить'}
                  </button>
                )}
                {p.kind === 'service' && (
                  <button className="run" disabled={!p.enabled} onClick={() => api.runPlugin(p.id)}>
                    Открыть
                  </button>
                )}
                {p.kind !== 'module' && (
                  <label className="switch" title={p.enabled ? 'Выключить плагин' : 'Включить плагин'}>
                    <input type="checkbox" checked={p.enabled} onChange={(e) => api.setPluginEnabled(p.id, e.target.checked)} />
                    <span />
                  </label>
                )}
                <button className="icon-btn" onClick={() => more(p)} title="Ещё">
                  <Icon name="more-horizontal" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="pm-foot">
          <span>
            Установлено: {list?.length ?? 0} · {fmtSize(total)}
          </span>
          <button onClick={() => api.revealExtensions()}>Папка расширений</button>
          {foreign.length > 0 && <button onClick={() => api.revealPlugins()}>Папка плагинов</button>}
        </div>
      </div>
    </div>
  )
}
