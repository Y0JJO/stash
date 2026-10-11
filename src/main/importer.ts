import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Library } from './library'
import { kindOf, probe, type MediaInfo } from './media'
import type { ImportProgress } from '../shared/types'

/** Extra data attached to an import (e.g. from the browser extension). */
export interface ImportMeta {
  name?: string
  url?: string
  tags?: string[]
}

export interface ImportResult {
  id: string
  duplicate: boolean
}

interface Job {
  path: string
  size: number
  folderId: string | null
  meta?: ImportMeta
  onResult?(r: ImportResult | null): void
}

const IGNORED = new Set(['thumbs.db', 'desktop.ini', '.ds_store'])
const CONCURRENCY = 4
const SAMPLE = 256 * 1024

/** Fast content fingerprint: size + first and last 256 KB. Good enough for duplicate detection. */
async function quickHash(file: string, size: number): Promise<string> {
  const h = createHash('sha1').update(String(size))
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(SAMPLE, size))
    await fh.read(buf, 0, buf.length, 0)
    h.update(buf)
    if (size > SAMPLE * 2) {
      await fh.read(buf, 0, buf.length, size - SAMPLE)
      h.update(buf)
    }
  } finally {
    await fh.close()
  }
  return h.digest('hex')
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file'
}

export interface ImporterEvents {
  onProgress(p: ImportProgress): void
  onAdded(ids: string[]): void
}

export class Importer {
  private queue: Job[] = []
  private active = 0
  private inflight = new Set<string>()
  private waiters: (() => void)[] = []
  private added: string[] = []
  private addedTimer: NodeJS.Timeout | null = null
  private progressTimer: NodeJS.Timeout | null = null
  private cancelled = false
  private progress: ImportProgress = { total: 0, done: 0, skipped: 0, failed: 0, running: false }

  constructor(
    private lib: Library,
    private ev: ImporterEvents
  ) {}

  cancel(): void {
    this.cancelled = true
    this.queue = []
  }

  /** Imports files and directories. A directory becomes a folder (recursively) inside `folderId`. */
  async addPaths(paths: string[], folderId: string | null): Promise<void> {
    const jobs: Job[] = []
    for (const p of paths) await this.collect(p, folderId, jobs, 0)
    if (!jobs.length || this.cancelled) return
    const done = new Promise<void>((r) => this.waiters.push(r))
    this.enqueue(jobs)
    await done
  }

  private enqueue(jobs: Job[]): void {
    if (this.cancelled) {
      jobs.forEach((j) => j.onResult?.(null))
      return
    }
    if (!this.progress.running) this.progress = { total: 0, done: 0, skipped: 0, failed: 0, running: true }
    this.progress.total += jobs.length
    this.queue.push(...jobs)
    this.ev.onProgress({ ...this.progress })
    this.pump()
  }

  /** Imports a single file and resolves with its item id (the existing one for a duplicate). */
  async importFile(file: string, folderId: string | null, meta: ImportMeta): Promise<ImportResult> {
    const size = (await fs.promises.stat(file)).size
    return new Promise((resolve, reject) => {
      this.enqueue([
        {
          path: file,
          size,
          folderId,
          meta,
          onResult: (r) => (r ? resolve(r) : reject(new Error('Не удалось импортировать файл')))
        }
      ])
    })
  }

  async importBuffer(data: Buffer, fileName: string, folderId: string | null): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-'))
    const file = path.join(dir, safeFileName(fileName))
    await fs.promises.writeFile(file, data)
    try {
      await this.addPaths([file], folderId)
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }

  private async collect(p: string, folderId: string | null, out: Job[], depth: number): Promise<void> {
    if (this.lib.contains(p)) return
    let st: fs.Stats
    try {
      st = await fs.promises.stat(p)
    } catch {
      return
    }
    const base = path.basename(p)
    if (st.isDirectory()) {
      if (depth > 32) return
      const folder = this.lib.createFolder(base, folderId)
      const entries = await fs.promises.readdir(p, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        await this.collect(path.join(p, e.name), folder.id, out, depth + 1)
      }
    } else if (st.isFile() && st.size > 0 && !base.startsWith('.') && !IGNORED.has(base.toLowerCase())) {
      out.push({ path: p, size: st.size, folderId })
    }
  }

  private pump(): void {
    while (!this.cancelled && this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!
      this.active++
      this.process(job)
        .then((r) => {
          if (r && !r.duplicate) this.queueAdded(r.id)
          else this.progress.skipped++
          job.onResult?.(r)
        })
        .catch((err) => {
          console.warn('[import] failed', job.path, err)
          this.progress.failed++
          job.onResult?.(null)
        })
        .finally(() => {
          this.active--
          this.progress.done++
          if (!this.queue.length && !this.active) this.finish()
          else {
            this.emitProgressSoon()
            this.pump()
          }
        })
    }
  }

  private finish(): void {
    this.progress.running = false
    this.flushAdded()
    this.ev.onProgress({ ...this.progress })
    this.waiters.splice(0).forEach((w) => w())
  }

  /** Returns the item id (existing one for duplicates), or null for a duplicate still being imported. */
  private async process(job: Job): Promise<ImportResult | null> {
    const hash = await quickHash(job.path, job.size)
    if (this.inflight.has(hash)) return null
    const existing = this.lib.findByHash(hash)
    if (existing) {
      if (existing.deleted) this.lib.restore([existing.id])
      if (job.folderId) this.lib.addToFolder([existing.id], job.folderId)
      if (job.meta?.tags?.length) this.lib.addTags([existing.id], job.meta.tags)
      return { id: existing.id, duplicate: true }
    }

    this.inflight.add(hash)
    const id = randomUUID()
    const dir = path.join(this.lib.root, 'files', id)
    try {
      const ext = path.extname(job.path).slice(1).toLowerCase()
      const kind = kindOf(ext)
      const fileName = safeFileName(path.basename(job.path))
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.copyFile(job.path, path.join(dir, fileName))

      let info: MediaInfo = { width: null, height: null, duration: null }
      try {
        info = await probe(path.join(dir, fileName), kind)
      } catch (err) {
        console.warn('[import] probe failed', job.path, (err as Error).message)
      }

      this.lib.insertItem({
        id,
        name: job.meta?.name || path.basename(job.path, path.extname(job.path)),
        ext,
        kind,
        file: `${id}/${fileName}`,
        size: job.size,
        hash,
        ...info
      })
      if (job.folderId) this.lib.addToFolder([id], job.folderId)
      if (job.meta?.url) this.lib.updateItems([id], { url: job.meta.url })
      if (job.meta?.tags?.length) this.lib.addTags([id], job.meta.tags)
      return { id, duplicate: false }
    } catch (err) {
      await fs.promises.rm(dir, { recursive: true, force: true })
      throw err
    } finally {
      this.inflight.delete(hash)
    }
  }

  private queueAdded(id: string): void {
    this.added.push(id)
    this.addedTimer ??= setTimeout(() => this.flushAdded(), 300)
  }

  private flushAdded(): void {
    if (this.addedTimer) clearTimeout(this.addedTimer)
    this.addedTimer = null
    if (!this.added.length) return
    this.ev.onAdded(this.added.splice(0))
  }

  private emitProgressSoon(): void {
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = null
      this.ev.onProgress({ ...this.progress })
    }, 150)
  }
}
