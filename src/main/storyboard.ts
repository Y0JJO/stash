import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import type { Library } from './library'
import type { Importer } from './importer'
import { probe } from './media'

const FFMPEG = (ffmpegStatic ?? 'ffmpeg').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const MAX_FRAMES = 300

export interface StoryboardOptions {
  mode: 'interval' | 'count' | 'scenes'
  /** Seconds between frames ("interval"). */
  interval: number
  /** Number of evenly spaced frames ("count"). */
  count: number
  /** Scene-change sensitivity 0.1 (many cuts) … 0.6 (only hard cuts) ("scenes"). */
  threshold: number
  /** Add every frame to the library. */
  frames: boolean
  /** Also build one contact-sheet image. */
  sheet: boolean
  /** Where the new "Раскадровка" folder goes. */
  parentFolderId: string | null
}

export interface StoryboardResult {
  frames: number
  folderId: string | null
}

function run(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.toString().trim().split('\n').slice(-2).join(' ') || err.message))
      else resolve({ stdout, stderr: stderr.toString() })
    })
  })
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

/** Timestamps of hard cuts, found with ffmpeg's scene score. */
async function sceneTimes(file: string, threshold: number): Promise<number[]> {
  const { stderr } = await run(['-hide_banner', '-i', file, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'])
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]))
  return [0, ...times]
}

export async function grabFrame(file: string, at: number, dest: string): Promise<void> {
  await run(['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '2', '-y', dest])
  if (!fs.existsSync(dest)) throw new Error('ffmpeg не смог извлечь кадр')
}

/** Grid of frames with timestamps — a classic storyboard sheet. */
async function contactSheet(frames: { file: string; t: number }[], dest: string): Promise<void> {
  const cols = frames.length <= 4 ? frames.length : frames.length <= 9 ? 3 : frames.length <= 20 ? 4 : 5
  const cellW = 480
  const meta = await sharp(frames[0].file).metadata()
  const cellH = Math.round(cellW * ((meta.height ?? 9) / (meta.width ?? 16)))
  const gap = 12
  const label = 28
  const rows = Math.ceil(frames.length / cols)
  const width = cols * cellW + (cols + 1) * gap
  const height = rows * (cellH + label) + (rows + 1) * gap

  const tiles = await Promise.all(
    frames.map(async (f, i) => {
      const x = gap + (i % cols) * (cellW + gap)
      const y = gap + Math.floor(i / cols) * (cellH + label + gap)
      const img = await sharp(f.file).resize(cellW, cellH, { fit: 'cover' }).toBuffer()
      const text = Buffer.from(
        `<svg width="${cellW}" height="${label}" xmlns="http://www.w3.org/2000/svg">
           <text x="2" y="20" font-family="Segoe UI, Arial" font-size="16" fill="#c8cad2">${i + 1}  ·  ${fmtTime(f.t)}</text>
         </svg>`
      )
      return [
        { input: img, left: x, top: y },
        { input: text, left: x, top: y + cellH }
      ]
    })
  )
  await sharp({ create: { width, height, channels: 3, background: '#16171b' } })
    .composite(tiles.flat())
    .jpeg({ quality: 90 })
    .toFile(dest)
}

/** Extracts frames from a video item and adds them (and/or a contact sheet) to the library. */
export async function makeStoryboard(
  lib: Library,
  importer: Importer,
  itemId: string,
  opts: StoryboardOptions,
  onProgress: (done: number, total: number) => void
): Promise<StoryboardResult> {
  const item = lib.getItem(itemId)
  if (!item || item.kind !== 'video') throw new Error('Это не видео')
  const duration = item.duration ?? (await probe(item.path, 'video')).duration ?? 0
  if (!duration) throw new Error('Не удалось узнать длительность видео')

  let times: number[]
  if (opts.mode === 'interval') {
    const step = Math.max(0.2, opts.interval)
    times = []
    for (let t = Math.min(0.1, duration / 2); t < duration && times.length < MAX_FRAMES; t += step) times.push(t)
  } else if (opts.mode === 'count') {
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(opts.count)))
    times = Array.from({ length: n }, (_, k) => (duration * (k + 0.5)) / n)
  } else {
    onProgress(0, 0)
    times = (await sceneTimes(item.path, opts.threshold)).slice(0, MAX_FRAMES)
  }
  // Nudge the very last timestamp off the end, where some files have no decodable frame.
  times = times.map((t) => Math.min(t, Math.max(0, duration - 0.05)))

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-storyboard-'))
  try {
    const frames: { file: string; t: number }[] = []
    let done = 0
    const queue = times.map((t, i) => ({ t, i }))
    const worker = async () => {
      while (queue.length) {
        const { t, i } = queue.shift()!
        const file = path.join(dir, `frame-${String(i).padStart(4, '0')}.jpg`)
        try {
          await grabFrame(item.path, t, file)
          frames.push({ file, t })
        } catch {
          /* skip undecodable positions */
        }
        onProgress(++done, times.length)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    frames.sort((a, b) => a.t - b.t)
    if (!frames.length) throw new Error('Не удалось извлечь ни одного кадра')

    const folder = lib.createFolder(`Раскадровка — ${item.name}`, opts.parentFolderId)
    if (opts.sheet) {
      const sheet = path.join(dir, `${item.name.replace(/[<>:"/\\|?*]/g, '_')} — раскадровка.jpg`)
      await contactSheet(frames, sheet)
      await importer.importFile(sheet, folder.id, { name: `${item.name} — раскадровка`, url: item.url, tags: ['раскадровка'] })
    }
    if (opts.frames) {
      for (const f of frames) {
        await importer
          .importFile(f.file, folder.id, { name: `${item.name} — ${fmtTime(f.t)}`, url: item.url, tags: ['кадр'] })
          .catch(() => null) // identical frames (static shots) are de-duplicated
      }
    }
    return { frames: frames.length, folderId: folder.id }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
