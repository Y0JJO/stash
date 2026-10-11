import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { Kind, PaletteColor } from '../shared/types'

// Binaries must live outside the asar archive in packaged builds.
const unpacked = (p: string) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const FFMPEG = unpacked(ffmpegStatic ?? 'ffmpeg')
const FFPROBE = unpacked(ffprobeStatic.path)

sharp.cache(false)

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'heif'])
export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts'])

export function kindOf(ext: string): Kind {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return 'other'
}

const THUMB_SIZE = 640

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.toString().trim().split('\n').slice(-3).join('\n') || err.message))
      else resolve(stdout)
    })
  })
}

export interface MediaInfo {
  width: number | null
  height: number | null
  duration: number | null
}

export async function probe(file: string, kind: Kind): Promise<MediaInfo> {
  if (kind === 'image') {
    const m = await sharp(file, { limitInputPixels: false }).metadata()
    let width = m.width ?? null
    let height = m.pageHeight ?? m.height ?? null
    // EXIF orientations 5–8 are rotated by 90°.
    if (m.orientation && m.orientation >= 5) [width, height] = [height, width]
    return { width, height, duration: null }
  }
  if (kind === 'video') {
    const out = JSON.parse((await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])).toString())
    const v = (out.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video')
    let width: number | null = v?.width ?? null
    let height: number | null = v?.height ?? null
    const rotation = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0)
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]
    const duration = parseFloat(out.format?.duration ?? v?.duration) || null
    return { width, height, duration }
  }
  return { width: null, height: null, duration: null }
}

/** Frame rate of the first video stream (e.g. 29.97), used for frame-accurate stepping in the player. */
export async function videoFps(file: string): Promise<number> {
  const out = JSON.parse(
    (await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-print_format', 'json', file])).toString()
  )
  const s = out.streams?.[0] ?? {}
  const parse = (v?: string) => {
    const [n, d] = String(v ?? '').split('/').map(Number)
    return n > 0 && d > 0 ? n / d : n > 0 && !d ? n : 0
  }
  const fps = parse(s.avg_frame_rate) || parse(s.r_frame_rate)
  return fps > 0 && fps < 1000 ? fps : 30
}

async function videoFrame(file: string, at: number): Promise<Buffer> {
  const grab = (t: number) =>
    run(FFMPEG, ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'])
  let buf = await grab(at).catch(() => Buffer.alloc(0))
  if (!buf.length && at > 0) buf = await grab(0)
  if (!buf.length) throw new Error('ffmpeg produced no frame')
  return buf
}

/** Renders a WebP thumbnail to `dest` and returns the dominant colours of the image. */
export async function makeThumb(src: string, dest: string, kind: Kind, duration: number | null): Promise<PaletteColor[]> {
  const input =
    kind === 'video'
      ? sharp(await videoFrame(src, duration ? Math.min(duration * 0.1, 30) : 0))
      : sharp(src, { limitInputPixels: false, animated: false }).rotate()
  const thumb = await input
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer()
  await fs.promises.writeFile(dest, thumb)
  return palette(thumb)
}

/** Small k-means over a downscaled copy of the image. */
async function palette(img: Buffer, k = 6): Promise<PaletteColor[]> {
  const { data, info } = await sharp(img)
    .resize(48, 48, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const px: number[][] = []
  for (let i = 0; i < data.length; i += info.channels) px.push([data[i], data[i + 1], data[i + 2]])
  if (!px.length) return []

  // Deterministic seeds: pixels spread evenly across the luminance range.
  const byLum = [...px].sort((a, b) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11 - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11))
  let centers = Array.from({ length: k }, (_, j) => [...byLum[Math.floor(((j + 0.5) * byLum.length) / k)]])
  let counts = new Array(k).fill(0)

  for (let iter = 0; iter < 10; iter++) {
    const sums = centers.map(() => [0, 0, 0])
    counts = new Array(k).fill(0)
    for (const p of px) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      counts[best]++
      sums[best][0] += p[0]
      sums[best][1] += p[1]
      sums[best][2] += p[2]
    }
    centers = centers.map((c, i) => (counts[i] ? sums[i].map((s) => s / counts[i]) : c))
  }

  const merged: { rgb: number[]; n: number }[] = []
  centers
    .map((rgb, i) => ({ rgb, n: counts[i] }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n)
    .forEach((c) => {
      const near = merged.find((m) => Math.hypot(m.rgb[0] - c.rgb[0], m.rgb[1] - c.rgb[1], m.rgb[2] - c.rgb[2]) < 24)
      if (near) near.n += c.n
      else merged.push(c)
    })

  const hex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  return merged.slice(0, 5).map((c) => ({ hex: hex(c.rgb), ratio: Math.round((c.n / px.length) * 1000) / 1000 }))
}
