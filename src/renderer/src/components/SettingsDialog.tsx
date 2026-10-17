import { useEffect, useMemo, useState } from 'react'
import type { Folder } from '../../../shared/types'
import type { Settings, UpdateState } from '../../../shared/settings'
import { api } from '../api'
import { updateSettings, useSettings } from '../settings'
import { folderPaths } from '../util'
import { Icon } from './Icon'

type SectionId = 'general' | 'sidebar' | 'controls' | 'preview' | 'screenshot' | 'shortcuts' | 'notify' | 'password' | 'autoimport' | 'ai' | 'dev'

const SECTIONS: { id: SectionId; label: string; icon: string; group: number; keywords: string }[] = [
  { id: 'general', label: 'Основные', icon: 'settings', group: 0, keywords: 'тема масштаб счётчики автозапуск gpu импорт обновления версия' },
  { id: 'sidebar', label: 'Сайдбар', icon: 'panel-left', group: 0, keywords: 'двойной клик папки разделы теги мудборды' },
  { id: 'controls', label: 'Управление', icon: 'sliders-horizontal', group: 1, keywords: 'мышь колесо двойной клик средняя кнопка пробел' },
  { id: 'preview', label: 'Просмотр', icon: 'eye', group: 1, keywords: 'изображение видео зум сглаживание автоплей повтор прозрачность' },
  { id: 'screenshot', label: 'Скриншот', icon: 'capture', group: 1, keywords: 'формат png jpg webp клавиша буфер тег' },
  { id: 'shortcuts', label: 'Горячие клавиши', icon: 'keyboard', group: 1, keywords: 'клавиши сочетания' },
  { id: 'notify', label: 'Уведомления', icon: 'bell', group: 2, keywords: 'уведомления расширение дубликаты' },
  { id: 'password', label: 'Пароль', icon: 'lock', group: 2, keywords: 'пароль блокировка' },
  { id: 'autoimport', label: 'Авто-импорт', icon: 'download', group: 2, keywords: 'папка слежение импорт' },
  { id: 'ai', label: 'AI и интеграции', icon: 'sparkle', group: 3, keywords: 'автотеги telegram плагины расширение браузер chrome edge' },
  { id: 'dev', label: 'Разработчик', icon: 'code', group: 4, keywords: 'версия devtools данные' }
]

const THEMES: { key: Settings['theme']; label: string; color: string }[] = [
  { key: 'glass', label: 'Стекло', color: 'linear-gradient(135deg, rgba(255,255,255,.35), rgba(168,152,255,.35)), #3a3846' },
  { key: 'dark', label: 'Тёмная', color: '#1a1b1f' },
  { key: 'black', label: 'Чёрная', color: '#000000' },
  { key: 'gray', label: 'Серая', color: '#3a3b40' },
  { key: 'blue', label: 'Синяя', color: '#1b2540' },
  { key: 'purple', label: 'Фиолетовая', color: '#2a1f45' }
]

interface Props {
  folders: Folder[]
  onClose(): void
  onOpenTelegram(): void
  onLockNow(): void
}

export function SettingsDialog({ folders, onClose, onOpenTelegram, onLockNow }: Props) {
  const s = useSettings()
  const [section, setSection] = useState<SectionId>('general')
  const [q, setQ] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  const set = async (patch: Partial<Settings>) => setWarnings(await updateSettings(patch))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.key-rec.rec')) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const shown = SECTIONS.filter((x) => !q.trim() || `${x.label} ${x.keywords}`.toLowerCase().includes(q.trim().toLowerCase()))
  const active = shown.some((x) => x.id === section) ? section : (shown[0]?.id ?? section)
  const title = SECTIONS.find((x) => x.id === active)!.label

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="set-nav">
          <div className="set-nav-title">Настройки</div>
          <div className="set-search">
            <Icon name="search" size={15} />
            <input placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {shown.map((x, i) => (
            <div key={x.id}>
              {i > 0 && shown[i - 1].group !== x.group && <div className="set-nav-sep" />}
              <button className={`set-nav-item${active === x.id ? ' on' : ''}`} onClick={() => setSection(x.id)}>
                <Icon name={x.icon} size={16} />
                {x.label}
              </button>
            </div>
          ))}
        </aside>

        <section className="set-main">
          <header className="set-head">
            <span>{title}</span>
            <button className="icon-btn" onClick={onClose} title="Закрыть (Esc)">
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="set-body">
            {warnings.map((w) => (
              <div key={w} className="set-warn">
                <Icon name="warn" size={15} />
                {w}
              </div>
            ))}
            {active === 'general' && <General s={s} set={set} />}
            {active === 'sidebar' && <SidebarPane s={s} set={set} />}
            {active === 'controls' && <Controls s={s} set={set} />}
            {active === 'preview' && <Preview s={s} set={set} />}
            {active === 'screenshot' && <Screenshot s={s} set={set} />}
            {active === 'shortcuts' && <Shortcuts s={s} set={set} />}
            {active === 'notify' && <Notify s={s} set={set} />}
            {active === 'password' && <Password onLockNow={onLockNow} />}
            {active === 'autoimport' && <AutoImport s={s} set={set} folders={folders} />}
            {active === 'ai' && <Integrations onOpenTelegram={onOpenTelegram} />}
            {active === 'dev' && <Developer />}
          </div>
          <footer className="set-foot">Изменения сохраняются сразу</footer>
        </section>
      </div>
    </div>
  )
}

// ---------- building blocks ----------

interface PaneProps {
  s: Settings
  set(patch: Partial<Settings>): void
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="set-card">
      {title && <div className="set-card-title">{title}</div>}
      {children}
    </div>
  )
}

function Check({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="set-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  )
}

function Radio<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="set-row">
      <div className="set-row-label">{label}</div>
      <div className="set-radios">
        {options.map(([k, text]) => (
          <label key={String(k)} className="set-radio">
            <input type="radio" checked={value === k} onChange={() => onChange(k)} />
            {text}
          </label>
        ))}
      </div>
    </div>
  )
}

function Switch({ value, onChange }: { value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

/** Click, then press a key combination; Backspace clears it. */
function KeyRecorder({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [rec, setRec] = useState(false)
  return (
    <button
      className={`key-rec${rec ? ' rec' : ''}`}
      onClick={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') return setRec(false)
        if (e.key === 'Backspace' || e.key === 'Delete') {
          onChange('')
          return setRec(false)
        }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
        const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
        // Global shortcuts need a modifier (function keys are fine on their own).
        if (!mods.length && !/^F\d+$/.test(e.key)) return
        const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key
        onChange([...mods, key].join('+'))
        setRec(false)
      }}
    >
      {rec ? 'Нажмите сочетание…' : value ? value.split('+').join(' + ') : 'Записать сочетание'}
    </button>
  )
}

// ---------- panes ----------

function General({ s, set }: PaneProps) {
  return (
    <>
      <Card title="Оформление">
        <div className="set-row">
          <div className="set-row-label">Тема</div>
          <div className="set-themes">
            {THEMES.map((t) => (
              <button key={t.key} className={`set-theme${s.theme === t.key ? ' on' : ''}`} style={{ background: t.color }} title={t.label} onClick={() => set({ theme: t.key })} />
            ))}
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-label">Масштаб интерфейса</div>
          <select value={s.zoom} onChange={(e) => set({ zoom: Number(e.target.value) })}>
            {[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </div>
        <Check label="Показывать счётчики в сайдбаре" value={s.sidebarCounts} onChange={(v) => set({ sidebarCounts: v })} />
      </Card>
      <Card title="Запуск">
        <Check label="Запускать D3S3RT при входе в Windows" value={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
        <Check
          label="Аппаратное ускорение (GPU)"
          hint="Изменение вступит в силу после перезапуска D3S3RT"
          value={s.gpu}
          onChange={(v) => set({ gpu: v })}
        />
      </Card>
      <Card title="Импорт">
        <Check label="Выделять новые файлы после импорта" value={s.selectAfterImport} onChange={(v) => set({ selectAfterImport: v })} />
      </Card>
      <Updates s={s} set={set} />
    </>
  )
}

function Updates({ s, set }: PaneProps) {
  const [u, setU] = useState<UpdateState | null>(null)
  useEffect(() => {
    api.updateState().then(setU)
    return api.onUpdateState(setU)
  }, [])
  if (!u) return null

  const text: Record<UpdateState['status'], string> = {
    unsupported: 'Обновления работают в установленной версии программы',
    idle: 'Проверка ещё не выполнялась',
    checking: 'Проверяю…',
    none: 'У вас последняя версия',
    available: `Вышла версия ${u.version ?? ''} — скачайте и установите её вручную`,
    downloading: `Загружаю версию ${u.version ?? ''}… ${u.percent ?? 0}%`,
    ready: `Версия ${u.version ?? ''} загружена и установится при перезапуске`,
    error: `Не удалось проверить: ${u.message ?? 'неизвестная ошибка'}`
  }
  return (
    <Card title="Обновления">
      <div className="set-keyrow">
        <span>
          D3S3RT {u.current} · {text[u.status]}
        </span>
        {u.status === 'ready' ? (
          <button className="primary" onClick={() => api.installUpdate()}>
            Перезапустить и обновить
          </button>
        ) : u.status === 'available' && u.url ? (
          <button className="primary" onClick={() => api.openUrl(u.url!)}>
            Скачать
          </button>
        ) : (
          <button disabled={u.status === 'unsupported' || u.status === 'checking' || u.status === 'downloading'} onClick={() => api.checkUpdate()}>
            Проверить обновления
          </button>
        )}
      </div>
      <Check label="Проверять и загружать обновления автоматически" value={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
    </Card>
  )
}

function SidebarPane({ s, set }: PaneProps) {
  return (
    <>
      <Card title="Двойной клик по папке">
        <Radio
          label="Действие"
          value={s.folderDoubleClick}
          options={[
            ['rename', 'Переименовать'],
            ['toggle', 'Свернуть / развернуть']
          ]}
          onChange={(v) => set({ folderDoubleClick: v })}
        />
      </Card>
      <Card title="Показывать в сайдбаре">
        <div className="set-grid">
          <Check label="Без папки" value={s.showUncategorized} onChange={(v) => set({ showUncategorized: v })} />
          <Check label="Без тегов" value={s.showUntagged} onChange={(v) => set({ showUntagged: v })} />
          <Check label="Быстрый доступ" value={s.showQuickAccess} onChange={(v) => set({ showQuickAccess: v })} />
          <Check label="Папки" value={s.showFolders} onChange={(v) => set({ showFolders: v })} />
          <Check label="Мудборды" value={s.showBoards} onChange={(v) => set({ showBoards: v })} />
        </div>
        <div className="set-note">«Все» и «Корзина» показываются всегда.</div>
      </Card>
    </>
  )
}

function Controls({ s, set }: PaneProps) {
  return (
    <>
      <Card title="Мышь">
        <Radio
          label="Колесо над изображением в просмотре"
          value={s.imageWheel}
          options={[
            ['zoom', 'Приближать / отдалять'],
            ['navigate', 'Предыдущий / следующий файл']
          ]}
          onChange={(v) => set({ imageWheel: v })}
        />
        <Radio
          label="Двойной клик по файлу"
          value={s.itemDoubleClick}
          options={[
            ['view', 'Открыть в D3S3RT'],
            ['external', 'Открыть во внешней программе']
          ]}
          onChange={(v) => set({ itemDoubleClick: v })}
        />
        <Radio
          label="Средняя кнопка мыши по файлу"
          value={s.middleClick}
          options={[
            ['external', 'Открыть во внешней программе'],
            ['view', 'Открыть в D3S3RT'],
            ['none', 'Ничего']
          ]}
          onChange={(v) => set({ middleClick: v })}
        />
      </Card>
      <Card title="Клавиатура">
        <Radio
          label="Пробел"
          value={s.spacePreview ? 'on' : 'off'}
          options={[
            ['on', 'Быстрый просмотр'],
            ['off', 'Ничего']
          ]}
          onChange={(v) => set({ spacePreview: v === 'on' })}
        />
      </Card>
    </>
  )
}

function Preview({ s, set }: PaneProps) {
  return (
    <>
      <Card title="Изображение">
        <Radio
          label="Увеличение"
          value={s.imageSmoothing}
          options={[
            ['smooth', 'Сглаженное'],
            ['pixelated', 'Пиксельное (для пиксель-арта)']
          ]}
          onChange={(v) => set({ imageSmoothing: v })}
        />
        <Radio
          label="Размер при открытии"
          value={s.imageDefaultSize}
          options={[
            ['fit', 'Вписать в окно'],
            ['original', 'Исходный размер (100%)']
          ]}
          onChange={(v) => set({ imageDefaultSize: v })}
        />
        <Radio
          label="Прозрачные области"
          value={s.transparentGrid ? 'grid' : 'none'}
          options={[
            ['grid', 'Шахматная сетка'],
            ['none', 'Без сетки']
          ]}
          onChange={(v) => set({ transparentGrid: v === 'grid' })}
        />
      </Card>
      <Card title="Видео">
        <Radio
          label="Колесо мыши в плеере"
          value={s.videoWheel}
          options={[
            ['seek', 'Перемотка'],
            ['volume', 'Громкость']
          ]}
          onChange={(v) => set({ videoWheel: v })}
        />
        <Radio
          label="Шаг перемотки колесом"
          value={s.videoWheelStep}
          options={[
            [0.5, '0.5 с'],
            [1, '1 с'],
            [2, '2 с'],
            [5, '5 с']
          ]}
          onChange={(v) => set({ videoWheelStep: v })}
        />
        <div className="set-note">Ctrl + колесо всегда двигает ровно на один кадр.</div>
        <Check label="Превью видео при наведении в сетке" value={s.videoHoverPreview} onChange={(v) => set({ videoHoverPreview: v })} />
        <Check label="Автовоспроизведение при открытии" value={s.videoAutoplay} onChange={(v) => set({ videoAutoplay: v })} />
        <Check label="Запоминать место, на котором остановились" value={s.videoRememberPosition} onChange={(v) => set({ videoRememberPosition: v })} />
        <Check
          label="Зацикливать только ролики короче 30 секунд"
          hint="Иначе повтор определяется кнопкой в плеере"
          value={s.videoLoopShort}
          onChange={(v) => set({ videoLoopShort: v })}
        />
      </Card>
    </>
  )
}

function Screenshot({ s, set }: PaneProps) {
  return (
    <>
      <Card title="Формат">
        <Radio
          label="Сохранять как"
          value={s.shotFormat}
          options={[
            ['png', 'PNG'],
            ['jpg', 'JPG'],
            ['webp', 'WebP']
          ]}
          onChange={(v) => set({ shotFormat: v })}
        />
      </Card>
      <Card>
        <div className="set-row">
          <div className="set-card-title" style={{ margin: 0 }}>
            Глобальная клавиша скриншота
          </div>
          <Switch value={s.shotShortcutEnabled} onChange={(v) => set({ shotShortcutEnabled: v })} />
        </div>
        <div className="set-keyrow">
          <span>Снять выбранную область</span>
          <KeyRecorder value={s.shotShortcut} onChange={(v) => set({ shotShortcut: v })} />
        </div>
        <div className="set-note">Работает из любой программы, пока D3S3RT запущен.</div>
      </Card>
      <Card title="После скриншота">
        <Check label="Показывать уведомление" value={s.shotNotify} onChange={(v) => set({ shotNotify: v })} />
        <Check label="Добавлять тег «скриншот»" value={s.shotTag} onChange={(v) => set({ shotTag: v })} />
        <Check label="Также копировать в буфер обмена" value={s.shotCopy} onChange={(v) => set({ shotCopy: v })} />
      </Card>
    </>
  )
}

const SHORTCUT_GROUPS: [string, [string, string][]][] = [
  [
    'Библиотека',
    [
      ['Поиск', 'Ctrl + F'],
      ['Быстрый переход к папке или тегу', 'Ctrl + K'],
      ['Выделить всё', 'Ctrl + A'],
      ['Быстрый просмотр', 'Пробел / Enter'],
      ['В корзину', 'Delete'],
      ['Вставить из буфера', 'Ctrl + V'],
      ['Настройки', 'Ctrl + ,'],
      ['Новая папка', 'Ctrl + Shift + N'],
      ['Новая подпапка', 'Alt + N'],
      ['Переименовать папку', 'F2'],
      ['Автотег папки', 'Ctrl + Shift + R'],
      ['Свернуть / развернуть все папки', '/']
    ]
  ],
  [
    'Плеер',
    [
      ['Плей / пауза', 'Пробел / K'],
      ['Кадр назад / вперёд', ', и .  ·  Ctrl + ← →  ·  Ctrl + колесо'],
      ['Перемотка', 'Колесо  ·  Shift + ← →  ·  J / L'],
      ['В начало / в конец', 'Home / End'],
      ['Скриншот кадра', 'S'],
      ['Скопировать кадр', 'Ctrl + C'],
      ['Скорость', '[ и ]'],
      ['Время ↔ кадры', 'T'],
      ['Звук', 'M'],
      ['Во весь экран', 'F']
    ]
  ],
  [
    'Мудборд',
    [
      ['Инструменты', 'V H T P M R O L A F'],
      ['Двигать холст', 'Пробел + тянуть'],
      ['Отменить / повторить', 'Ctrl + Z / Ctrl + Y'],
      ['Дублировать', 'Ctrl + D'],
      ['Заблокировать', 'Ctrl + L'],
      ['Отразить', 'Shift + H / Shift + V'],
      ['Выше / ниже', 'Ctrl + ] / Ctrl + ['],
      ['Показать всё', 'Shift + 1']
    ]
  ]
]

function Shortcuts({ s, set }: PaneProps) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  return (
    <>
      <div className="set-search wide">
        <Icon name="search" size={15} />
        <input placeholder="Поиск по клавишам…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!needle && (
        <Card title="Глобальные (работают из любой программы)">
          <div className="set-keyrow">
            <span>Показать D3S3RT</span>
            <KeyRecorder value={s.showShortcut} onChange={(v) => set({ showShortcut: v })} />
          </div>
          <div className="set-keyrow">
            <span>Скриншот выбранной области</span>
            <KeyRecorder value={s.shotShortcut} onChange={(v) => set({ shotShortcut: v })} />
          </div>
          <div className="set-note">Нажмите на сочетание, чтобы записать своё. Backspace — убрать.</div>
        </Card>
      )}
      {SHORTCUT_GROUPS.map(([group, rows]) => {
        const list = rows.filter(([a, b]) => !needle || `${a} ${b}`.toLowerCase().includes(needle))
        if (!list.length) return null
        return (
          <Card key={group} title={`${group} (${list.length})`}>
            {list.map(([action, keys]) => (
              <div key={action} className="set-keyrow">
                <span>{action}</span>
                <span className="set-keys">{keys}</span>
              </div>
            ))}
          </Card>
        )
      })}
    </>
  )
}

function Notify({ s, set }: PaneProps) {
  return (
    <Card title="Уведомления Windows">
      <Check label="Когда сделан скриншот" value={s.shotNotify} onChange={(v) => set({ shotNotify: v })} />
      <Check label="Когда файл сохранён через расширение браузера" value={s.notifyExtension} onChange={(v) => set({ notifyExtension: v })} />
      <Check label="Сообщать о дубликатах при импорте" value={s.notifyDuplicates} onChange={(v) => set({ notifyDuplicates: v })} />
      <Check label="Когда сработал авто-импорт" value={s.notifyAutoImport} onChange={(v) => set({ notifyAutoImport: v })} />
    </Card>
  )
}

function Password({ onLockNow }: { onLockNow(): void }) {
  const [has, setHas] = useState(false)
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    api.hasLock().then(setHas)
  }, [])

  const apply = async (next: string | null) => {
    setMsg(null)
    if (next !== null) {
      if (!next) return setMsg('Введите пароль')
      if (next !== pw2) return setMsg('Пароли не совпадают')
    }
    if (!(await api.setLock(next, current))) return setMsg('Текущий пароль неверный')
    setHas(next !== null)
    setCurrent('')
    setPw('')
    setPw2('')
    setMsg(next === null ? 'Пароль снят' : 'Пароль установлен')
  }

  return (
    <Card title="Блокировка паролем">
      <div className="set-note" style={{ marginTop: 0 }}>
        D3S3RT будет спрашивать пароль при запуске и после «Заблокировать сейчас». Это защита от посторонних глаз: сами файлы на диске не шифруются.
      </div>
      {has && <input type="password" placeholder="Текущий пароль" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      <input type="password" placeholder={has ? 'Новый пароль' : 'Пароль'} value={pw} onChange={(e) => setPw(e.target.value)} />
      <input type="password" placeholder="Повторите пароль" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {msg && <div className="set-note">{msg}</div>}
      <div className="set-actions">
        <button className="primary" onClick={() => apply(pw)}>
          {has ? 'Сменить пароль' : 'Установить пароль'}
        </button>
        {has && <button onClick={() => apply(null)}>Снять пароль</button>}
        {has && (
          <button onClick={onLockNow}>
            <Icon name="lock" size={14} />
            Заблокировать сейчас
          </button>
        )}
      </div>
    </Card>
  )
}

function AutoImport({ s, set, folders }: PaneProps & { folders: Folder[] }) {
  const paths = useMemo(() => folderPaths(folders), [folders])
  return (
    <Card>
      <div className="set-row">
        <div className="set-card-title" style={{ margin: 0 }}>
          Авто-импорт
        </div>
        <Switch value={s.autoImportEnabled} onChange={(v) => set({ autoImportEnabled: v })} />
      </div>
      <div className="set-note" style={{ marginTop: 0 }}>
        D3S3RT следит за папкой на диске: всё, что в неё попадает (скачали, сохранили, перетащили), автоматически добавляется в библиотеку. Файлы, которые уже лежат
        в папке в момент включения, не импортируются.
      </div>
      <div className="set-row">
        <div className="set-row-label">Папка на диске</div>
        <div className="set-dir">
          <span title={s.autoImportDir}>{s.autoImportDir || 'не выбрана'}</span>
          <button
            onClick={async () => {
              const dir = await api.pickAutoImportDir()
              if (dir) set({ autoImportDir: dir })
            }}
          >
            Выбрать…
          </button>
        </div>
      </div>
      <div className="set-row">
        <div className="set-row-label">Добавлять в папку D3S3RT</div>
        <select value={s.autoImportFolderId ?? ''} onChange={(e) => set({ autoImportFolderId: e.target.value || null })}>
          <option value="">Без папки</option>
          {[...folders]
            .sort((a, b) => paths.get(a.id)!.localeCompare(paths.get(b.id)!))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {paths.get(f.id)}
              </option>
            ))}
        </select>
      </div>
    </Card>
  )
}

/** Guided install of the browser extension: browsers only take an unpacked extension from the user's own hands. */
function BrowserExtension() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.browserExt>> | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const load = () => api.browserExt().then(setInfo).catch(() => {})
    load()
    // Polled so "connected" lights up as soon as the freshly installed extension says hello.
    const t = window.setInterval(load, 3000)
    return () => window.clearInterval(t)
  }, [])
  if (!info) return null

  return (
    <Card title="Расширение для браузера">
      <div className="set-hint">
        Сохраняет картинки и видео с сайтов прямо в D3S3RT. Подходит для Chrome, Edge, Яндекс Браузера, Opera, Brave и других на Chromium.
        {info.version && ` Версия ${info.version}.`}
      </div>
      <div className={`ext-status${info.seenAt ? ' ok' : ''}`}>
        <span className="ext-dot" />
        {info.seenAt ? 'Расширение подключено' : 'Расширение пока не выходило на связь'}
      </div>
      <ol className="ext-steps">
        <li>
          <span>Откройте страницу расширений в браузере</span>
          <div className="set-actions">
            {info.browsers.map((b) => (
              <button key={b.id} onClick={() => api.openExtensionsPage(b.id)} title={b.page}>
                {b.name}
              </button>
            ))}
            {!info.browsers.length && <span className="muted">Браузер не найден — откройте вручную адрес chrome://extensions</span>}
          </div>
        </li>
        <li>
          <span>Включите там «Режим разработчика» (переключатель в углу страницы)</span>
        </li>
        <li>
          <span>Нажмите «Загрузить распакованное расширение» и выберите эту папку</span>
          <div className="ext-path">
            <code title={info.dir}>{info.dir}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(info.dir)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Скопировано' : 'Скопировать путь'}
            </button>
            <button onClick={() => api.revealBrowserExt()}>Показать папку</button>
          </div>
        </li>
      </ol>
      <div className="set-hint">После обновления D3S3RT нажмите на карточке расширения в браузере кнопку «Обновить» (круглая стрелка).</div>
    </Card>
  )
}

function Integrations({ onOpenTelegram }: { onOpenTelegram(): void }) {
  const [auto, setAuto] = useState(true)
  useEffect(() => {
    api.aiEnabled().then(setAuto)
  }, [])
  return (
    <>
      <Card title="AI">
        <Check
          label="Автоматические теги (локальная модель CLIP)"
          hint="Новые файлы получают теги сразу после импорта"
          value={auto}
          onChange={(v) => {
            setAuto(v)
            api.setAiEnabled(v)
          }}
        />
      </Card>
      <BrowserExtension />
      <Card title="Интеграции">
        <div className="set-keyrow">
          <span>Telegram-бот: присылайте ссылки и файлы в D3S3RT</span>
          <button onClick={onOpenTelegram}>Настроить…</button>
        </div>
        <div className="set-keyrow">
          <span>Плагины</span>
          <button onClick={() => api.revealPlugins()}>Папка плагинов</button>
        </div>
      </Card>
    </>
  )
}

function Developer() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.appInfo>> | null>(null)
  useEffect(() => {
    api.appInfo().then(setInfo)
  }, [])
  return (
    <>
      <Card title="О программе">
        {info && (
          <dl className="props">
            <dt>D3S3RT</dt>
            <dd>{info.version}</dd>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Chromium</dt>
            <dd>{info.chrome}</dd>
            <dt>Node.js</dt>
            <dd>{info.node}</dd>
            <dt>Библиотека</dt>
            <dd>{info.library ?? '—'}</dd>
            <dt>Данные программы</dt>
            <dd>{info.userData}</dd>
          </dl>
        )}
      </Card>
      <Card title="Инструменты">
        <div className="set-actions">
          <button onClick={() => api.openDevTools()}>Инструменты разработчика (F12)</button>
          <button onClick={() => api.openUserData()}>Открыть папку данных</button>
          <button onClick={() => api.relaunch()}>Перезапустить D3S3RT</button>
        </div>
      </Card>
    </>
  )
}
