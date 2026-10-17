/**
 * Plays an animated image (GIF) on a canvas through the browser's ImageDecoder, with the parts of the
 * <video> API that VideoPlayer uses — so the same player (frame stepping, scrubbing, speed, loop,
 * trimming) works for GIFs, which an <img> can only play from start to end.
 */

/** Frames with a delay under 20 ms play at 100 ms — what browsers and ffmpeg both do. */
const MIN_DELAY = 0.02
const DEFAULT_DELAY = 0.1

type FrameCallback = () => void

export class GifMedia extends EventTarget {
  /** Start time of every frame (seconds); one extra entry at the end holds the total duration. */
  private starts: number[] = [0]
  private decoder: ImageDecoder | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private time = 0
  private shown = -1
  private drawing: Promise<void> | null = null
  private wanted = -1
  private raf = 0
  private clock = { at: 0, from: 0 }
  private callbacks = new Map<number, FrameCallback>()
  private nextId = 1
  private closed = false

  paused = true
  loop = true
  private rate = 1
  // Accepted and ignored: GIFs have no sound.
  muted = false
  volume = 1

  constructor(
    private load: () => Promise<Uint8Array>,
    private canvas: HTMLCanvasElement
  ) {
    super()
    this.ctx = canvas.getContext('2d')
    void this.open()
  }

  private async open(): Promise<void> {
    try {
      const decoder = new ImageDecoder({ data: await this.load(), type: 'image/gif' })
      this.decoder = decoder
      await decoder.tracks.ready
      await decoder.completed
      const count = decoder.tracks.selectedTrack?.frameCount ?? 1
      // The timeline needs every frame's delay, so walk the frames once up front.
      const starts = [0]
      for (let i = 0; i < count && !this.closed; i++) {
        const { image } = await decoder.decode({ frameIndex: i })
        if (i === 0) {
          this.canvas.width = image.displayWidth
          this.canvas.height = image.displayHeight
          this.ctx?.drawImage(image, 0, 0)
          this.shown = 0
        }
        const d = (image.duration ?? 0) / 1e6
        starts.push(starts[i] + (d < MIN_DELAY ? DEFAULT_DELAY : d))
        image.close()
      }
      if (this.closed) return
      this.starts = starts
      this.dispatchEvent(new Event('loadedmetadata'))
    } catch (err) {
      console.warn('[gif] decode failed', err)
      this.dispatchEvent(new Event('error'))
    }
  }

  get frameCount(): number {
    return Math.max(1, this.starts.length - 1)
  }

  get duration(): number {
    return this.starts[this.starts.length - 1]
  }

  /** Index of the frame on screen at time `t`. */
  frameAt(t: number): number {
    const s = this.starts
    let lo = 0
    let hi = s.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid] <= t + 1e-6) lo = mid
      else hi = mid - 1
    }
    return Math.max(0, lo)
  }

  frameStart(i: number): number {
    return this.starts[Math.max(0, Math.min(i, this.frameCount - 1))]
  }

  frameEnd(i: number): number {
    return this.starts[Math.max(0, Math.min(i, this.frameCount - 1)) + 1]
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration))
    if (!this.paused) this.clock = { at: performance.now(), from: this.time }
    this.show(this.frameAt(this.time))
    this.dispatchEvent(new Event('seeked'))
    this.dispatchEvent(new Event('timeupdate'))
  }

  get playbackRate(): number {
    return this.rate
  }

  set playbackRate(r: number) {
    this.rate = r
    this.clock = { at: performance.now(), from: this.time }
  }

  async play(): Promise<void> {
    if (!this.paused) return
    if (this.time >= this.duration - 1e-6) this.time = 0
    this.paused = false
    this.clock = { at: performance.now(), from: this.time }
    this.dispatchEvent(new Event('play'))
    this.tick()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    cancelAnimationFrame(this.raf)
    this.dispatchEvent(new Event('pause'))
  }

  requestVideoFrameCallback(cb: FrameCallback): number {
    const id = this.nextId++
    this.callbacks.set(id, cb)
    return id
  }

  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id)
  }

  close(): void {
    this.closed = true
    cancelAnimationFrame(this.raf)
    this.callbacks.clear()
    this.decoder?.close()
  }

  private tick = () => {
    if (this.paused || this.closed) return
    const end = this.duration
    let t = this.clock.from + ((performance.now() - this.clock.at) / 1000) * this.rate
    if (t >= end) {
      if (this.loop && end > 0) {
        t %= end
        this.clock = { at: performance.now(), from: t }
      } else {
        this.time = end
        this.show(this.frameCount - 1)
        this.pause()
        this.dispatchEvent(new Event('ended'))
        return
      }
    }
    this.time = t
    this.show(this.frameAt(t))
    this.dispatchEvent(new Event('timeupdate'))
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Draws frame `i`; while a decode is running only the latest request is kept. */
  private show(i: number): void {
    this.wanted = i
    if (this.drawing || i === this.shown || !this.decoder) return
    this.drawing = (async () => {
      while (this.wanted !== this.shown && !this.closed) {
        const target = this.wanted
        try {
          const { image } = await this.decoder!.decode({ frameIndex: target })
          if (this.closed) return image.close()
          this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
          this.ctx?.drawImage(image, 0, 0)
          image.close()
        } catch {
          // Decoder closed or a broken frame — keep the previous picture.
        }
        this.shown = target
        const cbs = [...this.callbacks.values()]
        this.callbacks.clear()
        for (const cb of cbs) cb()
      }
    })().finally(() => (this.drawing = null))
  }
}
