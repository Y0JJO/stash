import { useEffect, useState } from 'react'
import type { Folder, TelegramStatus } from '../../../shared/types'
import { api } from '../api'

/** Folders as an indented flat list for a <select>. */
function folderOptions(folders: Folder[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent)) {
      out.push({ id: f.id, label: `${'  '.repeat(depth)}${f.name}` })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Setup for the personal Telegram bot: token, pairing, target folder, link downloads. */
export function TelegramDialog({ folders, onClose }: { folders: Folder[]; onClose(): void }) {
  const [status, setStatus] = useState<TelegramStatus>({ state: 'off' })
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tools, setTools] = useState<{ done: number; total: number } | null>(null)
  /** Own-bot token form instead of the one-click shared bot. */
  const [ownBot, setOwnBot] = useState(false)

  useEffect(() => {
    api.telegramStatus().then(setStatus)
    const offs = [api.onTelegramStatus(setStatus), api.onTelegramToolsProgress(setTools)]
    return () => offs.forEach((off) => off())
  }, [])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.telegramConnect(token)
      setToken('')
      setStatus(await api.telegramStatus())
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const cloudPair = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.telegramCloudPair()
      setStatus(await api.telegramStatus())
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const installTools = async () => {
    setError(null)
    setTools({ done: 0, total: 2 })
    try {
      await api.telegramInstallTools()
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setTools(null)
    }
  }

  const connected = !!status.mode
  const paired = !!status.ownerName
  const cloud = status.mode === 'cloud'
  const link = cloud ? status.pairUrl ?? null : status.botName && status.pairCode ? `https://t.me/${status.botName}?start=${status.pairCode}` : null
  const tokenForm = !connected && (ownBot || !status.cloudAvailable)

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog tg-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="insp-title">Telegram-бот</div>

        {!connected && !tokenForm ? (
          <>
            <div className="muted dialog-note">
              Присылайте боту фото, видео, файлы и ссылки на посты — они попадут в библиотеку. Нажмите кнопку, а в открывшемся Telegram — «Start».
            </div>
            <button className="primary tg-big" disabled={busy} onClick={cloudPair}>
              {busy ? 'Открываю Telegram…' : 'Привязать Telegram'}
            </button>
            <div className="muted dialog-note">
              <button className="link-btn" onClick={() => setOwnBot(true)}>
                У меня свой бот (токен от @BotFather)
              </button>
            </div>
          </>
        ) : !connected ? (
          <>
            <div className="muted dialog-note">
              Вставьте токен, который выдал @BotFather при создании бота. Он хранится только на этом компьютере в зашифрованном виде.
            </div>
            <div className="insp-label">Токен бота</div>
            <input
              className="tg-input"
              type="password"
              value={token}
              autoFocus
              placeholder="123456789:AA…"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && token && !busy && connect()}
            />
          </>
        ) : (
          <>
            <div className="tg-row">
              <span className={`ai-dot ${status.state === 'online' ? 'idle' : status.state === 'error' ? 'error' : 'off'}`} />
              <span>
                <b>{status.botName ? `@${status.botName}` : 'Бот Stash'}</b>{' '}
                <span className="muted">
                  {status.state === 'online' ? '— на связи' : status.state === 'error' ? `— ${status.message}` : '— подключение…'}
                </span>
              </span>
            </div>

            {!paired ? (
              <div className="tg-pair">
                <div>{cloud ? 'Осталось нажать «Start» в Telegram. Окно обновится само.' : 'Осталось привязать бота к вашему аккаунту. Откройте ссылку и нажмите «Start»:'}</div>
                {link && (
                  <button className="primary tg-link" onClick={() => api.openUrl(link)}>
                    {cloud ? 'Открыть Telegram ещё раз' : `Открыть @${status.botName} в Telegram`}
                  </button>
                )}
                {!cloud && (
                  <div className="muted">
                    Или отправьте боту код <code className="tg-code">{status.pairCode}</code>
                  </div>
                )}
              </div>
            ) : (
              <div className="muted dialog-note">
                Привязан к {status.ownerName}. {cloud ? 'Сюда попадает только то, что присылаете вы.' : 'Чужим бот не отвечает.'}{' '}
                <button className="link-btn" onClick={() => api.telegramRepair()}>
                  Привязать заново
                </button>
              </div>
            )}

            <div className="insp-label">Куда сохранять</div>
            <select value={status.folderId ?? ''} onChange={(e) => api.telegramUpdate({ folderId: e.target.value || null })}>
              <option value="">Без папки</option>
              {folderOptions(folders).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>

            <div className="insp-label">Ссылки на посты (Instagram, Pinterest, TikTok, YouTube…)</div>
            {status.toolsInstalled ? (
              <>
                <div className="muted dialog-note">Скачиваются через gallery-dl и yt-dlp, включая все фото карусели.</div>
                <div className="insp-label">Вход на сайты брать из браузера</div>
                <select value={status.cookiesFrom ?? 'none'} onChange={(e) => api.telegramUpdate({ cookiesFrom: e.target.value as TelegramStatus['cookiesFrom'] })}>
                  <option value="none">Не использовать</option>
                  <option value="firefox">Firefox</option>
                  <option value="chrome">Chrome</option>
                  <option value="edge">Edge</option>
                </select>
                <div className="muted dialog-note">Нужно для Instagram и закрытых постов. Если не выбрать, бот сам попробует Firefox, Edge и Chrome и запомнит подходящий.</div>
              </>
            ) : (
              <>
                <div className="muted dialog-note">
                  Для карусели и видео нужны бесплатные утилиты gallery-dl и yt-dlp (~40 МБ, с их официальных страниц на GitHub). Бот скачает их сам при
                  первой ссылке, или можно сделать это сейчас.
                </div>
                <button onClick={installTools} disabled={!!tools}>
                  {tools ? `Скачивание… ${tools.done} / ${tools.total}` : 'Скачать утилиты'}
                </button>
              </>
            )}
          </>
        )}

        {error && <div className="tg-error">{error}</div>}

        <div className="dialog-actions">
          {connected && (
            <button
              onClick={async () => {
                if (await api.confirm('Отключить бота?', 'Stash перестанет принимать сообщения. Токен будет удалён.', 'Отключить')) api.telegramDisconnect()
              }}
            >
              Отключить
            </button>
          )}
          <span style={{ flex: 1 }} />
          {connected ? (
            <button className="primary" onClick={onClose}>
              Готово
            </button>
          ) : (
            <>
              {tokenForm && status.cloudAvailable && <button onClick={() => setOwnBot(false)}>Назад</button>}
              <button onClick={onClose}>{tokenForm ? 'Отмена' : 'Закрыть'}</button>
              {tokenForm && (
                <button className="primary" disabled={!token || busy} onClick={connect}>
                  {busy ? 'Проверка…' : 'Подключить'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
