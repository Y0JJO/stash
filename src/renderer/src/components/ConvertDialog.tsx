import { useEffect, useState } from 'react'
import type { ConvertOptions, ConvertProgress, ImageFormat, ItemLite, VideoFormat } from '../../../shared/types'
import { api } from '../api'
import { fmtSize, loadPref, plural, savePref } from '../util'
import { Icon } from './Icon'

interface Props {
  items: ItemLite[]
  onClose(): void
}

const IMAGE_FORMATS: { key: ImageFormat; label: string; hint: string; quality: boolean }[] = [
  { key: 'jpg', label: 'JPG', hint: 'Универсальный, без прозрачности', quality: true },
  { key: 'png', label: 'PNG', hint: 'Без потерь, с прозрачностью', quality: false },
  { key: 'webp', label: 'WEBP', hint: 'Лёгкий, для веба', quality: true },
  { key: 'avif', label: 'AVIF', hint: 'Самый компактный', quality: true },
  { key: 'tiff', label: 'TIFF', hint: 'Для печати и обработки', quality: false },
  { key: 'gif', label: 'GIF', hint: '256 цветов', quality: false }
]

const VIDEO_FORMATS: { key: VideoFormat; label: string; hint: string; video: boolean }[] = [
  { key: 'mp4', label: 'MP4', hint: 'H.264 — открывается везде', video: true },
  { key: 'mp4-h265', label: 'MP4 · H.265', hint: 'Вдвое легче, кодируется дольше', video: true },
  { key: 'webm', label: 'WEBM', hint: 'VP9 — для веба', video: true },
  { key: 'mov', label: 'MOV · ProRes', hint: 'Для монтажа, большие файлы', video: true },
  { key: 'gif', label: 'GIF', hint: 'Анимация без звука', video: true },
  { key: 'mp3', label: 'MP3', hint: 'Только звук', video: false },
  { key: 'wav', label: 'WAV', hint: 'Звук без сжатия', video: false }
]

const DEFAULTS = {
  image: { format: 'webp' as ImageFormat, quality: 85, maxSide: 0 },
  video: { format: 'mp4' as VideoFormat, quality: 'medium' as const, height: 0, fps: 0, mute: false },
  output: 'new' as ConvertOptions['output']
}

const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Batch converter for the selected images and videos. */
export function ConvertDialog({ items, onClose }: Props) {
  const images = items.filter((i) => i.kind === 'image')
  const videos = items.filter((i) => i.kind === 'video')
  const saved = loadPref<Partial<typeof DEFAULTS>>('convert', {})
  const [image, setImage] = useState({ ...DEFAULTS.image, ...saved.image })
  const [video, setVideo] = useState<NonNullable<ConvertOptions['video']>>({ ...DEFAULTS.video, ...saved.video })
  const [output, setOutput] = useState<ConvertOptions['output']>(saved.output ?? 'new')
  const [progress, setProgress] = useState<ConvertProgress | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = !!progress && !progress.done

  useEffect(() => api.onConvertProgress(setProgress), [])

  const imgFmt = IMAGE_FORMATS.find((f) => f.key === image.format)!
  const vidFmt = VIDEO_FORMATS.find((f) => f.key === video.format)!

  const start = async () => {
    savePref('convert', { image, video, output })
    setError(null)
    setResult(null)
    setProgress({ index: 0, total: items.length, name: '', percent: 0, failed: 0, done: false })
    try {
      const r = await api.convert(
        items.map((i) => i.id),
        { image: images.length ? image : null, video: videos.length ? video : null, output }
      )
      if (!r) return setProgress(null) // folder dialog was cancelled
      setResult(
        r.cancelled
          ? `Остановлено. Готово: ${r.converted}`
          : `Готово: ${r.converted} ${plural(r.converted, 'файл', 'файла', 'файлов')}${r.failed ? ` · не удалось: ${r.failed}` : ''}`
      )
    } catch (e) {
      setError(errText(e))
      setProgress(null)
    }
  }

  const total = items.reduce((s, i) => s + i.size, 0)
  const overall = progress && progress.total ? (progress.index + progress.percent) / progress.total : 0

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="dialog convert" onMouseDown={(e) => e.stopPropagation()}>
        <div className="insp-title dialog-title">
          <Icon name="repeat-2" size={17} />
          Конвертер
        </div>
        <div className="muted dialog-note">
          {images.length > 0 && `${images.length} ${plural(images.length, 'изображение', 'изображения', 'изображений')}`}
          {images.length > 0 && videos.length > 0 && ' · '}
          {videos.length > 0 && `${videos.length} видео`} · {fmtSize(total)}
        </div>

        {images.length > 0 && (
          <fieldset disabled={busy}>
            <div className="insp-label">Изображения → формат</div>
            <div className="fmt-grid">
              {IMAGE_FORMATS.map((f) => (
                <button key={f.key} className={`fmt${image.format === f.key ? ' on' : ''}`} onClick={() => setImage({ ...image, format: f.key })} title={f.hint}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="muted fmt-hint">{imgFmt.hint}</div>
            <div className="conv-row">
              <label className={imgFmt.quality ? '' : 'off'}>
                Качество
                <input type="range" min={30} max={100} value={image.quality} disabled={!imgFmt.quality} onChange={(e) => setImage({ ...image, quality: Number(e.target.value) })} />
                <b>{imgFmt.quality ? image.quality : '—'}</b>
              </label>
              <label>
                Размер
                <select value={image.maxSide} onChange={(e) => setImage({ ...image, maxSide: Number(e.target.value) })}>
                  <option value={0}>Как в оригинале</option>
                  {[4096, 2560, 1920, 1280, 1024, 512].map((s) => (
                    <option key={s} value={s}>
                      до {s} px
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
        )}

        {videos.length > 0 && (
          <fieldset disabled={busy}>
            <div className="insp-label">Видео → формат</div>
            <div className="fmt-grid">
              {VIDEO_FORMATS.map((f) => (
                <button key={f.key} className={`fmt${video.format === f.key ? ' on' : ''}`} onClick={() => setVideo({ ...video, format: f.key })} title={f.hint}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="muted fmt-hint">{vidFmt.hint}</div>
            <div className="conv-row">
              <label className={video.format === 'wav' ? 'off' : ''}>
                Качество
                <select value={video.quality} disabled={video.format === 'wav'} onChange={(e) => setVideo({ ...video, quality: e.target.value as typeof video.quality })}>
                  <option value="high">Высокое</option>
                  <option value="medium">Среднее</option>
                  <option value="low">Низкое (меньше файл)</option>
                </select>
              </label>
              {vidFmt.video && (
                <>
                  <label>
                    Разрешение
                    <select value={video.height} onChange={(e) => setVideo({ ...video, height: Number(e.target.value) })}>
                      <option value={0}>{video.format === 'gif' ? 'Авто (до 480p)' : 'Как в оригинале'}</option>
                      {[2160, 1440, 1080, 720, 480, 360].map((h) => (
                        <option key={h} value={h}>
                          {h}p
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Кадров/с
                    <select value={video.fps} onChange={(e) => setVideo({ ...video, fps: Number(e.target.value) })}>
                      <option value={0}>{video.format === 'gif' ? 'Авто (15)' : 'Как в оригинале'}</option>
                      {[60, 30, 25, 24, 15, 10].map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            {vidFmt.video && video.format !== 'gif' && (
              <label className="check-row">
                <input type="checkbox" checked={video.mute} onChange={(e) => setVideo({ ...video, mute: e.target.checked })} />
                Убрать звук
              </label>
            )}
          </fieldset>
        )}

        <fieldset disabled={busy}>
          <div className="insp-label">Что сделать с результатом</div>
          {(
            [
              ['new', 'Добавить рядом с оригиналом', 'Новый файл с теми же тегами и папками'],
              ['replace', 'Заменить оригинал', 'Исходный файл будет удалён'],
              ['folder', 'Сохранить в папку на диске…', 'Библиотека не меняется']
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="radio-row">
              <input type="radio" checked={output === key} onChange={() => setOutput(key)} />
              {label}
              <span className="muted conv-hint">{hint}</span>
            </label>
          ))}
        </fieldset>

        {error && <div className="warn dialog-note">{error}</div>}
        {progress && (
          <div className="dialog-progress">
            {result ?? `Конвертирую ${Math.min(progress.index + 1, progress.total)} из ${progress.total}: ${progress.name}`}
            <div className="progress-bar">
              <div style={{ width: `${(result ? 1 : overall) * 100}%` }} />
            </div>
          </div>
        )}

        <div className="dialog-actions">
          {busy ? (
            <button onClick={() => api.cancelConvert()}>Остановить</button>
          ) : (
            <>
              <button onClick={onClose}>{result ? 'Закрыть' : 'Отмена'}</button>
              {!result && (
                <button className="primary" onClick={start} disabled={!items.length}>
                  Конвертировать
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
