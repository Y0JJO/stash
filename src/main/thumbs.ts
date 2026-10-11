import type { Library } from './library'
import { makeThumb } from './media'
import type { ThumbReady } from '../shared/types'

const CONCURRENCY = 3

/** Background queue that renders thumbnails and extracts palettes. */
export class ThumbQueue {
  private queue: string[] = []
  private queued = new Set<string>()
  private active = 0
  private stopped = false
  private ready: ThumbReady[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private lib: Library,
    private onReady: (batch: ThumbReady[]) => void
  ) {}

  enqueueMissing(): void {
    this.enqueue(this.lib.pendingThumbIds())
  }

  enqueue(ids: string[]): void {
    for (const id of ids) {
      if (this.queued.has(id)) continue
      this.queued.add(id)
      this.queue.push(id)
    }
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.queue = []
  }

  private pump(): void {
    while (!this.stopped && this.active < CONCURRENCY && this.queue.length) {
      const id = this.queue.shift()!
      this.active++
      this.render(id).finally(() => {
        this.active--
        this.queued.delete(id)
        this.pump()
      })
    }
  }

  private async render(id: string): Promise<void> {
    const job = this.lib.thumbJob(id)
    const dest = this.lib.thumbPath(id)
    if (!job || !dest) return
    if (job.kind === 'other') {
      this.lib.setThumbFailed(id)
      return
    }
    try {
      const palette = await makeThumb(job.path, dest, job.kind, job.duration)
      if (this.stopped) return
      this.ready.push({ id, thumb: 1, thumbV: this.lib.setThumbDone(id, palette) })
      this.timer ??= setTimeout(() => this.flush(), 200)
    } catch (err) {
      if (this.stopped) return
      console.warn('[thumbs] failed', job.path, (err as Error).message)
      this.lib.setThumbFailed(id)
      this.ready.push({ id, thumb: 2, thumbV: 0 })
      this.timer ??= setTimeout(() => this.flush(), 200)
    }
  }

  private flush(): void {
    this.timer = null
    if (this.ready.length) this.onReady(this.ready.splice(0))
  }
}
