import { useEffect, useState } from 'react'
import type { ItemLite } from '../../../shared/types'
import { api, thumbUrl, type StoryboardOptions } from '../api'
import { fmtDuration, loadPref, savePref } from '../util'

interface Props {
  item: ItemLite
  folderId: string | null
  onClose(): void
  onDone(folderId: string | null): void
}

const DEFAULTS: StoryboardOptions = { mode: 'count', interval: 2, count: 12, threshold: 0.3, frames: true, sheet: true, parentFolderId: null }

/** Options + progress for turning a video into frames / a contact sheet. */
export function StoryboardDialog({ item, folderId, onClose, onDone }: Props) {
  const [opts, setOpts] = useState<StoryboardOptions>(() => ({ ...DEFAULTS, ...loadPref('storyboard', {}), parentFolderId: folderId }))
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (p: Partial<StoryboardOptions>) => setOpts((o) => ({ ...o, ...p }))
  const duration = item.duration ?? 0

  useEffect(() => api.onStoryboardProgress(setProgress), [])

  const estimate =
    opts.mode === 'count' ? Math.round(opts.count) : opts.mode === 'interval' ? Math.min(300, Math.ceil(duration / Math.max(0.2, opts.interval))) : null

  const start = async () => {
    const { parentFolderId: _p, ...rest } = opts
    savePref('storyboard', rest)
    setError(null)
    setProgress({ done: 0, total: estimate ?? 0 })
    try {
      const r = await api.makeStoryboard(item.id, opts)
      onDone(r.folderId)
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setProgress(null)
    }
  }

  const busy = progress !== null && !error

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          {item.thumb === 1 && <img src={thumbUrl(item.id, item.thumbV)} alt="" />}
          <div>
            <div className="insp-title">Раскадровка</div>
            <div className="muted">
              {item.name} · {fmtDuration(item.duration)}
            </div>
          </div>
        </div>

        <div className="insp-label">Какие кадры взять</div>
        <label className="radio-row">
          <input type="radio" checked={opts.mode === 'count'} onChange={() => set({ mode: 'count' })} />
          Равномерно
          <input type="number" min={1} max={300} value={opts.count} onChange={(e) => set({ count: Number(e.target.value) || 1, mode: 'count' })} />
          кадров
        </label>
        <label className="radio-row">
          <input type="radio" checked={opts.mode === 'interval'} onChange={() => set({ mode: 'interval' })} />
          Каждые
          <input type="number" min={0.2} step={0.5} value={opts.interval} onChange={(e) => set({ interval: Number(e.target.value) || 1, mode: 'interval' })} />
          сек
        </label>
        <label className="radio-row">
          <input type="radio" checked={opts.mode === 'scenes'} onChange={() => set({ mode: 'scenes' })} />
          По смене сцен
        </label>
        {opts.mode === 'scenes' && (
          <div className="slider-row">
            <span className="muted">больше кадров</span>
            <input type="range" min={0.1} max={0.6} step={0.05} value={opts.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })} />
            <span className="muted">только резкие склейки</span>
          </div>
        )}

        <div className="insp-label">Что сохранить</div>
        <label className="check-row">
          <input type="checkbox" checked={opts.sheet} onChange={(e) => set({ sheet: e.target.checked })} />
          Лист-раскадровку (все кадры на одной картинке)
        </label>
        <label className="check-row">
          <input type="checkbox" checked={opts.frames} onChange={(e) => set({ frames: e.target.checked })} />
          Каждый кадр отдельным файлом
        </label>
        <div className="muted dialog-note">
          Всё попадёт в новую папку «Раскадровка — {item.name}»{estimate !== null ? ` · около ${estimate} кадров` : ''}.
        </div>

        {error && <div className="warn dialog-note">{error}</div>}
        {busy && (
          <div className="dialog-progress">
            {progress.total ? `Извлекаю кадры: ${progress.done} / ${progress.total}` : 'Ищу смены сцен…'}
            <div className="progress-bar">
              <div style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '15%' }} />
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="primary" onClick={start} disabled={busy || (!opts.frames && !opts.sheet)}>
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
