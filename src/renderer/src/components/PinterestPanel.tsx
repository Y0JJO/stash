import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ItemLite } from '../../../shared/types'
import { api, fileUrl, thumbUrl, type PinResult } from '../api'
import { BROWSER_IMAGE } from '../util'

interface Props {
  item: ItemLite
  folderId: string | null
  folderName: string | null
  onClose(): void
}

type SaveState = 'saving' | 'saved' | 'error'

/** "Find similar on Pinterest": results grid, save single pins or a selection into the library. */
export function PinterestPanel({ item, folderId, folderName, onClose }: Props) {
  const [results, setResults] = useState<PinResult[]>([])
  const [bookmark, setBookmark] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<Record<string, SaveState>>({})
  const [preview, setPreview] = useState<PinResult | null>(null)
  const seen = useRef(new Set<string>())

  const load = async (more: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const page = await api.pinterestSearch(item.id, more)
      const fresh = page.results.filter((r) => !seen.current.has(r.id))
      fresh.forEach((r) => seen.current.add(r.id))
      setResults((prev) => (more ? [...prev, ...fresh] : fresh))
      setBookmark(page.bookmark)
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(null)
  }, [item.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (preview) setPreview(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [preview, onClose])

  const save = async (pins: PinResult[]) => {
    for (const pin of pins) {
      if (saved[pin.id] === 'saved') continue
      setSaved((s) => ({ ...s, [pin.id]: 'saving' }))
      try {
        await api.pinterestSave(pin, folderId)
        setSaved((s) => ({ ...s, [pin.id]: 'saved' }))
      } catch {
        setSaved((s) => ({ ...s, [pin.id]: 'error' }))
      }
    }
    setSelected(new Set())
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const source = item.thumb === 1 ? thumbUrl(item.id, item.thumbV) : BROWSER_IMAGE.has(item.ext) ? fileUrl(item.id) : null
  const savedCount = Object.values(saved).filter((s) => s === 'saved').length

  return (
    <div className="pin-panel">
      <div className="viewer-bar">
        <div className="viewer-title">
          <span className="pin-logo">P</span> Похожее на Pinterest
        </div>
        {savedCount > 0 && <span className="muted">Сохранено: {savedCount}</span>}
        <button className="icon-btn" onClick={onClose} title="Закрыть (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="pin-body">
        <aside className="pin-source">
          {source && <img src={source} alt="" />}
          <div className="pin-source-name">{item.name}</div>
          <div className="muted">
            {item.width && item.height ? `${item.width} × ${item.height}` : item.ext.toUpperCase()}
          </div>
          <div className="pin-target muted">Сохранять в: {folderName ?? 'без папки'}</div>
          <button className="primary" disabled={!selected.size} onClick={() => save(results.filter((r) => selected.has(r.id)))}>
            Сохранить выбранные ({selected.size})
          </button>
          {selected.size > 0 && (
            <button className="pin-clear" onClick={() => setSelected(new Set())}>
              Снять выделение
            </button>
          )}
        </aside>
        <div className="pin-results">
          {error && (
            <div className="pin-msg">
              <div>Не удалось выполнить поиск: {error}</div>
              <button onClick={() => load(null)}>Повторить</button>
            </div>
          )}
          {!error && !loading && !results.length && <div className="pin-msg">Ничего похожего не нашлось</div>}
          <div className="pin-grid">
            {results.map((r) => {
              const st = saved[r.id]
              return (
                <div key={r.id} className={`pin-card${selected.has(r.id) ? ' selected' : ''}`} onClick={() => toggle(r.id)} onDoubleClick={() => setPreview(r)}>
                  <div className="pin-img" style={{ aspectRatio: r.width && r.height ? `${r.width} / ${r.height}` : undefined }}>
                    <img src={r.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    {r.isVideo && (
                      <span className="tile-badge">
                        <Icon name="play" size={11} filled />
                      </span>
                    )}
                    <div className="pin-actions" onClick={(e) => e.stopPropagation()}>
                      <button className={`pin-save ${st ?? ''}`} disabled={st === 'saving' || st === 'saved'} onClick={() => save([r])}>
                        <Icon name={st === 'saved' ? 'check' : st === 'error' ? 'retry' : st === 'saving' ? 'loader' : 'plus'} size={14} />
                        {st === 'saved' ? 'В Stash' : st === 'saving' ? 'Сохраняю' : st === 'error' ? 'Ошибка' : 'В Stash'}
                      </button>
                      <button className="pin-open" title="Открыть пин в браузере" onClick={() => api.openUrl(r.pinUrl)}>
                        <Icon name="external" size={14} />
                      </button>
                    </div>
                  </div>
                  {r.title && <div className="pin-title">{r.title}</div>}
                </div>
              )
            })}
          </div>
          {loading && <div className="pin-msg">Ищу похожие изображения…</div>}
          {!loading && bookmark && !error && (
            <div className="pin-more">
              <button onClick={() => load(bookmark)}>Показать ещё</button>
            </div>
          )}
        </div>
      </div>
      {preview && (
        <div className="pin-preview" onClick={() => setPreview(null)}>
          <img src={preview.large} alt="" referrerPolicy="no-referrer" />
          <div className="pin-preview-bar" onClick={(e) => e.stopPropagation()}>
            <span>{preview.title || 'Без названия'}</span>
            <span className="muted">
              {preview.width}×{preview.height}
            </span>
            <button className="primary" disabled={saved[preview.id] === 'saved'} onClick={() => save([preview])}>
              <Icon name={saved[preview.id] === 'saved' ? 'check' : 'plus'} size={14} />
              {saved[preview.id] === 'saved' ? 'Сохранено' : 'В Stash'}
            </button>
            <button onClick={() => api.openUrl(preview.pinUrl)}>
              Открыть пин
              <Icon name="external" size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
