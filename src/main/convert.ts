import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp, { type Sharp } from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import type { ConvertOptions, ConvertProgress, Item } from '../shared/types'
import type { Library } from './library'
import type { Importer } from './importer'
import { kindOf, probe } from './media'

const FFMPEG = (ffmpegStatic ?? 'ffmpeg').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'file'

export interface ConvertDeps {
  lib: Library
  importer: Importer
  enqueueThumbs(ids: string[]): void
  onProgress(p: ConvertProgress): void
  /** Destination directory for output === 'folder'. */
  outDir?: string
}

/** One running batch; `cancel()` stops ffmpeg and ends the loop after the current file. */
export class Conversion {
  private child: ChildProcess | null = null
  private cancelled = false

  cancel(): void {
    this.cancelled = true
    this.child?.kill()
  }

  async run(ids: string[], opts: ConvertOptions, deps: ConvertDeps): Promise<{ converted: number; failed: number; cancelled: boolean }> {
    const items = ids.map((id) => deps.lib.getItem(id)).filter((it): it is Item => !!it && ((it.kind === 'image' && !!opts.image) || (it.kind === 'video' && !!opts.video)))
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-convert-'))
    let converted = 0
    let failed = 0
    try {
      for (let i = 0; i < items.length && !this.cancelled; i++) {
        const it = items[i]
        const report = (percent: number) => deps.onProgress({ index: i, total: items.length, name: it.name, percent, failed, done: false })
        report(0)
        try {
          const ext = it.kind === 'image' ? opts.image!.format : videoExt(opts.video!.format)
          const out = path.join(tmp, `${i}-${safe(it.name)}.${ext}`)
          if (it.kind === 'image') await convertImage(it.path, out, opts.image!)
          else await this.convertVideo(it, out, opts.video!, report)
          if (this.cancelled) break
          await this.deliver(it, out, opts.output, deps)
          converted++
        } catch (err) {
          if (this.cancelled) break
          console.warn('[convert] failed', it.path, (err as Error).message)
          failed++
        }
      }
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true })
      deps.onProgress({ index: items.length, total: items.length, name: '', percent: 1, failed, done: true })
    }
    return { converted, failed, cancelled: this.cancelled }
  }

  private async deliver(it: Item, file: string, output: ConvertOptions['output'], deps: ConvertDeps): Promise<void> {
    const ext = path.extname(file).slice(1)
    if (output === 'folder') {
      let dest = path.join(deps.outDir!, `${safe(it.name)}.${ext}`)
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(deps.outDir!, `${safe(it.name)} (${n}).${ext}`)
      await fs.promises.copyFile(file, dest)
      return
    }
    if (output === 'replace') {
      const dir = path.join(deps.lib.root, 'files', it.id)
      const fileName = `${path.basename(it.path, path.extname(it.path))}.${ext}`
      const dest = path.join(dir, fileName)
      // Copy under a temporary name first, then swap, so a failed copy never loses the original.
      const staged = path.join(dir, `.convert-${Date.now()}.${ext}`)
      await fs.promises.copyFile(file, staged)
      if (dest !== it.path) await fs.promises.rm(it.path, { force: true })
      await fs.promises.rename(staged, dest)
      const kind = kindOf(ext)
      const info = await probe(dest, kind).catch(() => ({ width: null, height: null, duration: null }))
      deps.lib.replaceItemFile(it.id, { file: `${it.id}/${fileName}`, ext, kind, size: (await fs.promises.stat(dest)).size, hash: await quickHash(dest), ...info })
      deps.enqueueThumbs([it.id])
      return
    }
    // A new item that keeps the original's name, source link, tags and folders.
    const named = path.join(path.dirname(file), `${safe(it.name)}.${ext}`)
    await fs.promises.rename(file, named)
    const r = await deps.importer.importFile(named, it.folderIds[0] ?? null, { name: it.name, url: it.url, tags: it.tags })
    if (it.folderIds.length > 1) deps.lib.setItemFolders(r.id, it.folderIds)
  }

  private convertVideo(it: Item, out: string, o: NonNullable<ConvertOptions['video']>, report: (p: number) => void): Promise<void> {
    const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', it.path, ...videoArgs(it, o), out]
    return new Promise((resolve, reject) => {
      const child = (this.child = spawn(FFMPEG, args, { windowsHide: true }))
      let err = ''
      child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)))
      child.stdout?.on('data', (d: Buffer) => {
        // "-progress pipe:1" prints out_time_us=<microseconds> as it goes.
        const m = /out_time_(?:us|ms)=(\d+)/.exec(d.toString())
        if (m && it.duration) report(Math.min(0.99, Number(m[1]) / 1e6 / it.duration))
      })
      child.on('error', reject)
      child.on('close', (code) => {
        this.child = null
        if (code === 0) resolve()
        else reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `ffmpeg завершился с кодом ${code}`))
      })
    })
  }
}

async function quickHash(file: string): Promise<string> {
  const buf = await fs.promises.readFile(file)
  return createHash('sha1').update(String(buf.length)).update(buf.subarray(0, 256 * 1024)).update(buf.subarray(-256 * 1024)).digest('hex')
}

// ---------- images ----------

async function convertImage(src: string, out: string, o: NonNullable<ConvertOptions['image']>): Promise<void> {
  const animated = o.format === 'gif' || o.format === 'webp'
  let input: Sharp
  try {
    input = sharp(src, { animated, limitInputPixels: false })
    await input.metadata()
  } catch {
    // Formats sharp can't read (bmp, ico…): let ffmpeg decode them to PNG first.
    const png = `${out}.src.png`
    await new Promise<void>((resolve, reject) => {
      const c = spawn(FFMPEG, ['-y', '-v', 'error', '-i', src, '-frames:v', '1', png], { windowsHide: true })
      c.on('error', reject)
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Не удалось прочитать изображение'))))
    })
    input = sharp(png, { limitInputPixels: false })
  }
  let img = animated ? input : input.rotate()
  if (o.maxSide > 0) img = img.resize(o.maxSide, o.maxSide, { fit: 'inside', withoutEnlargement: true })
  const q = Math.max(1, Math.min(100, Math.round(o.quality)))
  switch (o.format) {
    case 'jpg':
      img = img.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true })
      break
    case 'png':
      img = img.png({ compressionLevel: 9 })
      break
    case 'webp':
      img = img.webp({ quality: q })
      break
    case 'avif':
      img = img.avif({ quality: q })
      break
    case 'tiff':
      img = img.tiff({ quality: q, compression: 'lzw' })
      break
    case 'gif':
      img = img.gif()
      break
  }
  await img.toFile(out)
  await fs.promises.rm(`${out}.src.png`, { force: true })
}

// ---------- video ----------

const videoExt = (f: NonNullable<ConvertOptions['video']>['format']) => (f === 'mp4-h265' ? 'mp4' : f)

function videoArgs(it: Item, o: NonNullable<ConvertOptions['video']>): string[] {
  const level = { high: 0, medium: 1, low: 2 }[o.quality]
  const shrink = o.height > 0 && (!it.height || o.height < it.height)
  const filters: string[] = []
  const audio = o.mute ? ['-an'] : null

  if (o.format === 'mp3') return ['-vn', '-c:a', 'libmp3lame', '-q:a', String([0, 2, 5][level])]
  if (o.format === 'wav') return ['-vn', '-c:a', 'pcm_s16le']

  if (o.format === 'gif') {
    // GIF needs a palette pass to look decent; default to 15 fps / 480px to keep files sane.
    const fps = o.fps || 15
    const h = o.height || Math.min(it.height ?? 480, 480)
    return ['-an', '-vf', `fps=${fps},scale=-2:${h}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${[256, 192, 128][level]}[p];[b][p]paletteuse=dither=bayer`]
  }

  if (o.fps > 0) filters.push(`fps=${o.fps}`)
  if (shrink) filters.push(`scale=-2:${o.height}`)
  const vf = filters.length ? ['-vf', filters.join(',')] : []

  switch (o.format) {
    case 'mp4':
      return [...vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', String([18, 23, 28][level]), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(audio ?? ['-c:a', 'aac', '-b:a', '160k'])]
    case 'mp4-h265':
      return [...vf, '-c:v', 'libx265', '-preset', 'medium', '-crf', String([22, 26, 30][level]), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart', ...(audio ?? ['-c:a', 'aac', '-b:a', '160k'])]
    case 'webm':
      return [...vf, '-c:v', 'libvpx-vp9', '-crf', String([28, 33, 38][level]), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', ...(audio ?? ['-c:a', 'libopus', '-b:a', '128k'])]
    case 'mov':
      // ProRes: HQ / standard / proxy — an editing format, files are large by design.
      return [...vf, '-c:v', 'prores_ks', '-profile:v', String([3, 2, 0][level]), '-pix_fmt', 'yuv422p10le', ...(audio ?? ['-c:a', 'pcm_s16le'])]
  }
  return []
}

// ---------- trimming ----------

export type TrimMode = 'exact' | 'fast' | 'gif'

/**
 * Cuts [start, start + duration] out of a video.
 * "exact" re-encodes to H.264 (frame accurate), "fast" copies the streams (instant, but starts on the
 * nearest keyframe), "gif" makes an animated GIF.
 */
export function trimVideo(src: string, out: string, start: number, duration: number, mode: TrimMode): Promise<void> {
  const range = ['-ss', start.toFixed(3), '-i', src, '-t', duration.toFixed(3)]
  const args =
    mode === 'fast'
      ? [...range, '-c', 'copy', '-avoid_negative_ts', 'make_zero']
      : mode === 'gif'
        ? // A GIF source keeps its own frames and size; video is thinned out to keep the file small.
          [...range, '-an', '-vf', `${/\.gif$/i.test(src) ? '' : "fps=15,scale=-2:'min(480,ih)':flags=lanczos,"}split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer`]
        : [...range, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k']
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-y', '-v', 'error', ...args, out], { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) resolve()
      else reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `ffmpeg завершился с кодом ${code}`))
    })
  })
}
