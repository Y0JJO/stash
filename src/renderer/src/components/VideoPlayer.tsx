import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemLite } from '../../../shared/types'
import { api, fileUrl } from '../api'
import { clamp, keyOf, loadPref, savePref } from '../util'
import { Icon } from './Icon'
import { getSettings, useSettings } from '../settings'
import { GifMedia } from '../gifMedia'
import { useFit, useZoomPan } from '../zoom'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8]

type GrabTarget = 'library' | 'clipboard' | 'file'

/** What the player drives: a <video>, or a GIF drawn on a canvas with the same API. */
type Media = HTMLVideoElement | GifMedia

interface Props {
  item: ItemLite
  /** Play an animated GIF (on a canvas) instead of a video. */
  gif?: boolean
  /** Saves the frame at `time` (seconds). */
  onGrab(time: number, target: GrabTarget): Promise<unknown>
}

/** m:ss.mmm (h:mm:ss.mmm for long videos). */
function fmtMs(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rest = `${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

/**
 * Video (and GIF) player for the viewer: wheel scrubbing (Ctrl = one frame), frame stepping, millisecond /
 * frame counter, speed, loop, frame screenshots, and cutting a fragment out (I / O marks).
 */
export function VideoPlayer({ item, gif, onGrab }: Props) {
  const prefs = useSettings()
  const video = useRef<Media | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  // Fitted into the window whatever its size; Alt+wheel / + − zoom into a point, drag pans.
  const [natural, setNatural] = useState(item.width && item.height ? { w: item.width, h: item.height } : null)
  const fit = useFit(area, natural)
  const z = useZoomPan(area)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(item.duration ?? 0)
  const [fps, setFps] = useState(30)
  const [speed, setSpeed] = useState<number>(() => loadPref('player.speed', 1))
  const [loop, setLoop] = useState<boolean>(() => loadPref('player.loop', true))
  const [muted, setMuted] = useState<boolean>(() => loadPref('player.muted', false))
  const [volume, setVolume] = useState<number>(() => loadPref('player.volume', 1))
  const [frames, setFrames] = useState<boolean>(() => loadPref('player.frames', false))
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  // Preference: loop only short clips; otherwise the player's own loop button decides.
  const effectiveLoop = prefs.videoLoopShort ? duration > 0 && duration < 30 : loop
  const noteTimer = useRef<number | undefined>(undefined)
  // Fragment to cut out (seconds); null while the trim panel is closed.
  const [trim, setTrim] = useState<{ a: number; b: number } | null>(null)
  const [cutting, setCutting] = useState(false)
  const trimRef = useRef(trim)
  trimRef.current = trim

  const flash = (text: string, sticky = false) => {
    setNote(text)
    window.clearTimeout(noteTimer.current)
    if (!sticky) noteTimer.current = window.setTimeout(() => setNote(null), 1400)
  }

  useEffect(() => {
    if (!gif) api.videoInfo(item.id).then((i) => setFps(i.fps)).catch(() => {})
  }, [item.id, gif])

  /** Duration, saved position and the player's settings, once the media knows its length. */
  const onReady = (v: Media) => {
    setDuration(v.duration || item.duration || 0)
    const w = v instanceof GifMedia ? (area.current?.querySelector('canvas')?.width ?? 0) : v.videoWidth
    const h = v instanceof GifMedia ? (area.current?.querySelector('canvas')?.height ?? 0) : v.videoHeight
    if (w && h && (natural?.w !== w || natural?.h !== h)) setNatural({ w, h })
    if (v instanceof GifMedia) setFps(v.duration ? v.frameCount / v.duration : 10)
    if (prefs.videoRememberPosition) {
      const saved = Number(localStorage.getItem(`stash.pos.${item.id}`))
      if (saved > 1 && saved < v.duration - 1) v.currentTime = saved
    }
    v.playbackRate = speed
    v.loop = effectiveLoop
    v.muted = muted
    v.volume = volume
  }

  // GIF: the canvas gets its GifMedia as soon as it mounts, before the effects below run.
  const gifCanvas = useCallback(
    (c: HTMLCanvasElement | null) => {
      if (!c || video.current) return
      const m = new GifMedia(() => api.bytes(item.id), c)
      video.current = m
      m.addEventListener('play', () => setPlaying(true))
      m.addEventListener('pause', () => setPlaying(false))
      m.addEventListener('seeked', () => setTime(m.currentTime))
      m.addEventListener('timeupdate', () => setTime(m.currentTime))
      m.addEventListener('loadedmetadata', () => {
        onReady(m)
        if (getSettings().videoAutoplay) void m.play()
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id]
  )
  useEffect(() => () => (video.current instanceof GifMedia ? video.current.close() : undefined), [])

  useEffect(() => {
    savePref('player.speed', speed)
    savePref('player.loop', loop)
    savePref('player.muted', muted)
    savePref('player.volume', volume)
    savePref('player.frames', frames)
    const v = video.current
    if (v) {
      v.playbackRate = speed
      v.loop = effectiveLoop
      v.muted = muted
      v.volume = volume
    }
  }, [speed, loop, muted, volume, frames, effectiveLoop])

  // "Запоминать место": keep the position per file between openings.
  useEffect(() => {
    const v = video.current
    const key = `stash.pos.${item.id}`
    return () => {
      if (!v || !getSettings().videoRememberPosition) return
      try {
        if (v.currentTime > 1 && v.currentTime < (v.duration || 0) - 1) localStorage.setItem(key, String(v.currentTime))
        else localStorage.removeItem(key)
      } catch {
        /* storage unavailable */
      }
    }
  }, [item.id])

  // Follow the video frame by frame so the millisecond / frame counter is exact.
  useEffect(() => {
    const v = video.current
    if (!v) return
    let handle = 0
    let alive = true
    const tick = () => {
      if (!alive) return
      // While a fragment is marked, playback loops inside it — a live preview of the cut.
      const t = trimRef.current
      if (t && !v.paused && (v.currentTime >= t.b || v.currentTime < t.a - 0.05)) v.currentTime = t.a
      setTime(v.currentTime)
      handle = v.requestVideoFrameCallback(tick)
    }
    handle = v.requestVideoFrameCallback(tick)
    return () => {
      alive = false
      v.cancelVideoFrameCallback(handle)
    }
  }, [item.id])

  const gm = () => (video.current instanceof GifMedia ? video.current : null)
  // GIF frames have their own delays, so frame maths goes through the GIF's timeline.
  const frameOf = (t: number) => gm()?.frameAt(t) ?? Math.floor(t * fps + 1e-3)
  const totalFrames = gm()?.frameCount ?? Math.max(1, Math.round(duration * fps))
  /** Start of frame `i`, and its middle (a safe time to ask ffmpeg for exactly that frame). */
  const startOf = (i: number) => gm()?.frameStart(i) ?? i / fps
  const middleOf = (i: number) => {
    const g = gm()
    return g ? (g.frameStart(i) + g.frameEnd(i)) / 2 : (i + 0.5) / fps
  }

  const seek = useCallback(
    (t: number) => {
      const v = video.current
      if (!v) return
      const end = Math.max(0, (v.duration || duration) - 0.001)
      v.currentTime = clamp(t, 0, end)
      setTime(v.currentTime)
    },
    [duration]
  )

  const toggle = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }, [])

  /** Moves by whole frames and lands in the middle of the target frame (avoids rounding onto a neighbour). */
  const stepFrames = useCallback(
    (n: number) => {
      const v = video.current
      if (!v) return
      v.pause()
      const target = clamp(frameOf(v.currentTime) + n, 0, totalFrames - 1)
      seek(middleOf(target))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fps, totalFrames, seek]
  )

  const grab = async (target: GrabTarget) => {
    const v = video.current
    if (!v) return
    v.pause()
    // Ask for the middle of the frame on screen so ffmpeg returns exactly that frame.
    const t = middleOf(frameOf(v.currentTime))
    flash('Сохраняю кадр…')
    try {
      await onGrab(t, target)
      flash(target === 'clipboard' ? 'Кадр скопирован' : target === 'file' ? 'Кадр сохранён' : 'Кадр добавлен в библиотеку')
    } catch {
      flash('Не удалось сохранить кадр')
    }
  }

  // ----- trimming -----
  const frameStart = (t: number) => startOf(frameOf(t))
  /** Moves one edge of the fragment; opens the panel (whole video selected) on first use. */
  const mark = (edge: 'a' | 'b', t: number) => {
    const min = 1 / fps
    setTrim((cur) => {
      const base = cur ?? { a: 0, b: duration }
      return edge === 'a'
        ? { a: clamp(frameStart(t), 0, Math.max(0, base.b - min)), b: base.b }
        : { a: base.a, b: clamp(frameStart(t), base.a + min, duration) }
    })
  }
  const toggleTrim = () => setTrim((cur) => (cur ? null : { a: 0, b: duration }))

  const cut = async (mode: 'exact' | 'fast' | 'gif', target: 'library' | 'file' = 'library') => {
    if (!trim || cutting) return
    video.current?.pause()
    setCutting(true)
    flash(mode === 'fast' ? 'Вырезаю фрагмент…' : 'Вырезаю фрагмент — перекодирование может занять время…', true)
    try {
      const r = await api.trimVideo(item.id, trim.a, trim.b, mode, target)
      flash(target === 'file' ? (r === null ? 'Готово' : 'Фрагмент сохранён') : 'Фрагмент добавлен в библиотеку')
    } catch (err) {
      console.error('trim', err)
      flash('Не удалось вырезать фрагмент')
    } finally {
      setCutting(false)
    }
  }

  const cutMenu = async () => {
    if (gif) {
      const r = await api.menu(
        [
          { id: 'gif', label: 'В библиотеку как GIF', icon: 'image' },
          { id: 'exact', label: 'В библиотеку как видео (MP4)', icon: 'scissors' },
          { id: 'file', label: 'Сохранить GIF как файл…', icon: 'export' }
        ],
        { search: false }
      )
      if (r === 'file') cut('gif', 'file')
      else if (r) cut(r as 'exact' | 'gif')
      return
    }
    const r = await api.menu(
      [
        { id: 'exact', label: 'В библиотеку — точно по кадрам (MP4)', icon: 'scissors' },
        { id: 'fast', label: 'В библиотеку — быстро, без перекодирования', icon: 'zap' },
        { id: 'gif', label: 'В библиотеку как GIF', icon: 'image' },
        { id: 'file', label: 'Сохранить как файл…', icon: 'export' }
      ],
      { search: false }
    )
    if (r === 'file') cut('exact', 'file')
    else if (r) cut(r as 'exact' | 'fast' | 'gif')
  }

  const onHandleDown = (edge: 'a' | 'b') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    video.current?.pause()
  }
  const onHandleMove = (edge: 'a' | 'b') => (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.stopPropagation()
    const t = timeAt(e.clientX)
    mark(edge, t)
    seek(t)
  }

  const grabMenu = async () => {
    const r = await api.menu([
      { id: 'library', label: 'Кадр в библиотеку', icon: 'save', shortcut: 'S' },
      { id: 'clipboard', label: 'Скопировать кадр', icon: 'copy', shortcut: 'Ctrl+C' },
      { id: 'file', label: 'Сохранить кадр как…', icon: 'export' }
    ])
    if (r) grab(r as GrabTarget)
  }

  const speedMenu = async () => {
    const r = await api.menu(
      [...SPEEDS].reverse().map((s) => ({ id: String(s), label: `${s}x`, checked: s === speed })),
      { search: false }
    )
    if (r) setSpeed(Number(r))
  }

  const changeSpeed = (dir: number) => {
    const i = SPEEDS.indexOf(speed)
    const next = SPEEDS[clamp((i < 0 ? 3 : i) + dir, 0, SPEEDS.length - 1)]
    setSpeed(next)
    flash(`Скорость ${next}x`)
  }

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage.current?.requestFullscreen()
  }
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  // Wheel: scrub by a second (Shift = 5 s); Ctrl = exactly one frame.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dir = e.deltaY > 0 || e.deltaX > 0 ? 1 : -1
      const p = getSettings()
      if (e.altKey) z.zoomBy(dir < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY)
      else if (e.ctrlKey) stepFrames(dir)
      else if (p.videoWheel === 'volume') {
        const next = clamp(Math.round((volume - dir * 0.05) * 100) / 100, 0, 1)
        setVolume(next)
        setMuted(false)
        flash(`Громкость ${Math.round(next * 100)}%`)
      } else seek((video.current?.currentTime ?? 0) + dir * p.videoWheelStep * (e.shiftKey ? 5 : 1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [seek, stepFrames, volume])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.cm-backdrop')) return
      const k = keyOf(e)
      if (e.key === ' ' || k === 'k') toggle()
      else if (e.key === ',' || (e.ctrlKey && e.key === 'ArrowLeft')) stepFrames(-1)
      else if (e.key === '.' || (e.ctrlKey && e.key === 'ArrowRight')) stepFrames(1)
      else if (e.shiftKey && e.key === 'ArrowLeft') seek((video.current?.currentTime ?? 0) - 1)
      else if (e.shiftKey && e.key === 'ArrowRight') seek((video.current?.currentTime ?? 0) + 1)
      else if (k === 'j') seek((video.current?.currentTime ?? 0) - 5)
      else if (k === 'l') seek((video.current?.currentTime ?? 0) + 5)
      else if (e.key === 'Home') seek(0)
      else if (e.key === 'End') seek(duration)
      else if (k === 'm') setMuted((m) => !m)
      else if (e.ctrlKey && k === 'c') grab('clipboard')
      else if (k === 's' && !e.ctrlKey) grab('library')
      else if (k === 'f') toggleFull()
      else if (k === 't') setFrames((f) => !f)
      else if (k === 'i' && !e.ctrlKey) mark('a', video.current?.currentTime ?? 0)
      else if (k === 'o' && !e.ctrlKey) mark('b', video.current?.currentTime ?? 0)
      else if (k === 'x' && !e.ctrlKey && trim) setTrim(null)
      else if ((e.key === '+' || e.key === '=') && !e.ctrlKey) z.zoomBy(1.25)
      else if (e.key === '-' && !e.ctrlKey) z.zoomBy(1 / 1.25)
      else if (e.key === '0' && !e.ctrlKey) z.reset()
      else if (e.key === '[') changeSpeed(-1)
      else if (e.key === ']') changeSpeed(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ----- seek bar -----
  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }
  const onBarDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    seek(timeAt(e.clientX))
  }
  const onBarMove = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    setHover({ x: clamp(e.clientX - r.left, 0, r.width), t: timeAt(e.clientX) })
    if (e.buttons & 1) seek(timeAt(e.clientX))
  }

  // Times are shown snapped to the start of their frame, so stepping reads 2.000 → 2.033 → 2.067.
  const label = (t: number) => (frames ? String(frameOf(t)) : fmtMs(startOf(frameOf(t))))
  const progress = duration ? (time / duration) * 100 : 0

  const mediaStyle: React.CSSProperties = {
    ...(fit ? { width: fit.width, height: fit.height } : { maxWidth: '100%', maxHeight: '100%' }),
    ...z.style
  }

  return (
    <div className={`player${full ? ' full' : ''}`} ref={stage}>
      <div className="player-stage" ref={area} onClick={() => !z.dragged() && toggle()} onDoubleClick={toggleFull} {...z.handlers}>
        {gif ? (
          <canvas
            ref={gifCanvas}
            className={prefs.transparentGrid ? 'checker' : undefined}
            style={{ ...mediaStyle, imageRendering: prefs.imageSmoothing === 'pixelated' ? 'pixelated' : 'auto' }}
          />
        ) : (
        <video
          ref={(el) => {
            if (el) video.current = el
          }}
          style={mediaStyle}
          key={item.id}
          src={fileUrl(item.id)}
          autoPlay={prefs.videoAutoplay}
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => onReady(e.currentTarget)}
        />
        )}
        {note && <div className="player-note">{note}</div>}
        {z.t.s !== 1 && (
          <button className="zoom-badge" onClick={(e) => (e.stopPropagation(), z.reset())} title="Вписать в окно (0)">
            {Math.round(z.t.s * (fit?.scale ?? 1) * 100)}%
          </button>
        )}
      </div>

      {trim && (
        <div className="player-trim" onClick={(e) => e.stopPropagation()}>
          <Icon name="scissors" size={15} />
          <button className="pl-mark" onClick={() => mark('a', time)} title="Поставить начало на текущий кадр (I)">
            Начало <b>{label(trim.a)}</b>
          </button>
          <button className="pl-mark" onClick={() => mark('b', time)} title="Поставить конец на текущий кадр (O)">
            Конец <b>{label(trim.b)}</b>
          </button>
          <span className="pl-trim-len">
            Длина <b>{frames ? `${gif ? frameOf(trim.b) - frameOf(trim.a) : Math.round((trim.b - trim.a) * fps)} кадр.` : `${(trim.b - trim.a).toFixed(3)} с`}</b>
          </span>
          <button className="pl-btn" onClick={() => (seek(trim.a), void video.current?.play())} title="Проиграть фрагмент с начала">
            <Icon name="play" size={14} filled />
          </button>
          <span className="pl-trim-hint">Тяните края на шкале или жмите I / O</span>
          <button
            className="pl-cut"
            disabled={cutting}
            onClick={() => cut(gif ? 'gif' : 'exact')}
            title={gif ? 'Вырезать фрагмент в библиотеку (GIF)' : 'Вырезать фрагмент в библиотеку (точно по кадрам, MP4)'}
          >
            {cutting ? 'Вырезаю…' : 'Вырезать в библиотеку'}
          </button>
          <button className="pl-btn" disabled={cutting} onClick={cutMenu} title={gif ? 'Другие варианты: MP4, в файл' : 'Другие варианты: без перекодирования, GIF, в файл'}>
            <Icon name="chevron-down" size={13} />
          </button>
          <button className="pl-btn" onClick={() => setTrim(null)} title="Закрыть обрезку (X)">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="player-bar" onClick={(e) => e.stopPropagation()}>
        <button className="pl-btn" onClick={toggle} title={playing ? 'Пауза (Пробел)' : 'Играть (Пробел)'}>
          <Icon name={playing ? 'pause' : 'play'} size={17} filled />
        </button>
        <button className="pl-btn" onClick={() => stepFrames(-1)} title="Кадр назад ( , или Ctrl+колесо)">
          <Icon name="skip-back" size={16} />
        </button>
        <button className="pl-btn" onClick={() => stepFrames(1)} title="Кадр вперёд ( . или Ctrl+колесо)">
          <Icon name="skip-forward" size={16} />
        </button>
        {!gif && (
        <div className="pl-volume">
          <button className="pl-btn" onClick={() => setMuted((m) => !m)} title="Звук (M)">
            <Icon name={muted || volume === 0 ? 'mute' : 'sound'} size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value))
              setMuted(false)
            }}
          />
        </div>
        )}
        <button className="pl-time" onClick={() => setFrames((f) => !f)} title="Переключить: время с миллисекундами / кадры (T)">
          <b>{label(time)}</b>
          <span>/</span>
          <span>{frames ? totalFrames : fmtMs(duration)}</span>
          <em>{frames ? 'кадр' : 'мс'}</em>
        </button>

        <div className="pl-seek" ref={bar} onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerLeave={() => setHover(null)}>
          <div className="pl-track">
            <div className="pl-fill" style={{ width: `${progress}%` }} />
            {trim && duration > 0 && (
              <div className="pl-range" style={{ left: `${(trim.a / duration) * 100}%`, width: `${((trim.b - trim.a) / duration) * 100}%` }} />
            )}
            <div className="pl-knob" style={{ left: `${progress}%` }} />
          </div>
          {trim && duration > 0 && (
            <>
              <div className="pl-handle a" style={{ left: `${(trim.a / duration) * 100}%` }} onPointerDown={onHandleDown('a')} onPointerMove={onHandleMove('a')} title="Начало фрагмента" />
              <div className="pl-handle b" style={{ left: `${(trim.b / duration) * 100}%` }} onPointerDown={onHandleDown('b')} onPointerMove={onHandleMove('b')} title="Конец фрагмента" />
            </>
          )}
          {hover && (
            <div className="pl-tip" style={{ left: hover.x }}>
              {frames ? `кадр ${frameOf(hover.t)}` : fmtMs(startOf(frameOf(hover.t)))}
            </div>
          )}
        </div>

        <button className="pl-btn text" onClick={speedMenu} title="Скорость ( [ и ] )">
          {speed}x
        </button>
        <button
          className={`pl-btn${effectiveLoop ? ' on' : ''}`}
          onClick={() => setLoop((l) => !l)}
          disabled={prefs.videoLoopShort}
          title={prefs.videoLoopShort ? 'Повтор: только ролики короче 30 с (см. Настройки → Просмотр)' : 'Повтор'}
        >
          <Icon name="repeat" size={16} />
        </button>
        <button className="pl-btn" onClick={() => grab('library')} onContextMenu={(e) => (e.preventDefault(), grabMenu())} title="Скриншот кадра в библиотеку (S). Правый клик — другие варианты">
          <Icon name="camera" size={16} />
        </button>
        <button className="pl-btn" onClick={grabMenu} title="Куда сохранить кадр">
          <Icon name="chevron-down" size={13} />
        </button>
        <button className={`pl-btn${trim ? ' on' : ''}`} onClick={toggleTrim} title="Обрезать фрагмент (I — начало, O — конец)">
          <Icon name="scissors" size={16} />
        </button>
        <button className="pl-btn" onClick={toggleFull} title="Во весь экран (F)">
          <Icon name={full ? 'minimize' : 'fullscreen'} size={16} />
        </button>
        <span className="pl-fps" title="Частота кадров">
          {gif ? `${totalFrames} кадр.` : `${Math.round(fps * 100) / 100} fps`}
        </span>
      </div>
    </div>
  )
}
