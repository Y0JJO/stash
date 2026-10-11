import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { session, type Session } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { Folder } from '../shared/types'
import type { ImportMeta, ImportResult } from './importer'

/** Port the browser extension talks to. */
export const CLIPPER_PORT = 41597

const FFMPEG = (ffmpegStatic ?? 'ffmpeg').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAX_BYTES = 4 * 1024 ** 3
const MAX_BODY = 64 * 1024 * 1024

/** What the extension sends for one "save" action. */
export interface ClipRequest {
  kind: 'image' | 'video' | 'page'
  /** Direct media URLs, best candidate first (e.g. Pinterest "originals" before the thumbnail). */
  urls?: string[]
  /** Media requests the extension observed on the tab (HLS playlists, DASH segments…), newest first. */
  streams?: string[]
  /** Base64 data URL (screenshots, blob: images). */
  data?: string
  pageUrl?: string
  title?: string
  tags?: string[]
  folderId?: string | null
}

export interface ClipperDeps {
  libraryName(): string | null
  folders(): Folder[]
  importFile(file: string, folderId: string | null, meta: ImportMeta): Promise<ImportResult>
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv'
}

function extFor(contentType: string | null, url: string): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type]
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(new URL(url).pathname)
  return m ? m[1].toLowerCase() : null
}

const isPlaylist = (url: string) => /\.m3u8(?:$|[?#])/i.test(url)

let clipSession: Session | null = null

/**
 * Downloads go through a dedicated session: Electron refuses a hand-set Referer header,
 * so it is passed as X-Stash-Referer and swapped in just before the request leaves.
 */
function get(url: string, referer?: string): Promise<Response> {
  if (!clipSession) {
    clipSession = session.fromPartition('stash-clipper')
    clipSession.setUserAgent(UA)
    clipSession.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders
      // Chromium lower-cases custom header names.
      const ref = headers['x-stash-referer'] ?? headers['X-Stash-Referer']
      if (ref) {
        delete headers['x-stash-referer']
        delete headers['X-Stash-Referer']
        headers['Referer'] = ref
      }
      cb({ requestHeaders: headers })
    })
  }
  return clipSession.fetch(url, { headers: referer ? { 'X-Stash-Referer': referer } : {} })
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-y', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.toString().trim().split('\n').slice(-2).join(' ') || err.message)) : resolve()
    )
  })
}

function ffmpegHeaders(referer?: string): string[] {
  const h = `User-Agent: ${UA}\r\n` + (referer ? `Referer: ${referer}\r\n` : '')
  return ['-headers', h]
}

/** Downloads `url` into `dir`; returns the file path, or null if it isn't usable media. */
async function download(url: string, dir: string, referer: string | undefined, want: 'image' | 'video'): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const res = await get(url, referer)
  if (!res.ok || !res.body) return null
  const type = res.headers.get('content-type') ?? ''
  if (/mpegurl/i.test(type)) return null // playlist served without .m3u8 extension — handled by the stream path
  const ext = extFor(type, url)
  const okType = type.startsWith(`${want}/`) || (type.startsWith('application/octet-stream') && ext && ext !== 'html')
  if (!okType || !ext) return null
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error('Файл слишком большой')
  const file = path.join(dir, `media.${ext}`)
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file))
  const size = (await fs.promises.stat(file)).size
  return size > 512 ? file : null
}

/** HLS playlist → mp4 (no re-encode). */
async function downloadHls(url: string, dir: string, referer?: string): Promise<string> {
  const out = path.join(dir, 'media.mp4')
  await ffmpeg([...ffmpegHeaders(referer), '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out])
  return out
}

/**
 * Instagram/Facebook-style DASH: the player fetches separate video and audio tracks in byte ranges.
 * Dropping the range parameters returns whole tracks, which ffmpeg then muxes together.
 */
async function downloadDash(streams: string[], dir: string, referer?: string): Promise<string | null> {
  const clean = (u: string) => {
    const url = new URL(u)
    url.searchParams.delete('bytestart')
    url.searchParams.delete('byteend')
    return url.toString()
  }
  const isAudio = (u: string) => {
    const efg = new URL(u).searchParams.get('efg')
    try {
      return !!efg && /audio/i.test(Buffer.from(efg, 'base64').toString())
    } catch {
      return false
    }
  }
  const tracks = [...new Set(streams.filter((s) => /bytestart=/.test(s)).map(clean))]
  if (!tracks.length) return null
  const video = tracks.find((t) => !isAudio(t))
  const audio = tracks.find((t) => isAudio(t))
  if (!video) return null

  const vFile = path.join(dir, 'video.mp4')
  const res = await get(video, referer)
  if (!res.ok || !res.body) return null
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(vFile))
  if (!audio) return vFile

  const aFile = path.join(dir, 'audio.mp4')
  const ares = await get(audio, referer)
  if (!ares.ok || !ares.body) return vFile
  await pipeline(Readable.fromWeb(ares.body as never), fs.createWriteStream(aFile))
  const out = path.join(dir, 'media.mp4')
  await ffmpeg(['-i', vFile, '-i', aFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', out])
  return out
}

/** Fetches the media described by a clip request into a temp dir. */
async function fetchClip(req: ClipRequest, dir: string): Promise<string> {
  const referer = req.pageUrl
  if (req.data) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(req.data)
    if (!m) throw new Error('Некорректные данные')
    const ext = EXT_BY_TYPE[m[1]] ?? 'png'
    const file = path.join(dir, `media.${ext}`)
    await fs.promises.writeFile(file, m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])))
    return file
  }

  const want = req.kind === 'video' ? 'video' : 'image'
  const errors: string[] = []
  for (const url of req.urls ?? []) {
    try {
      const file = isPlaylist(url) ? await downloadHls(url, dir, referer) : await download(url, dir, referer, want)
      if (file) return file
    } catch (err) {
      errors.push((err as Error).message)
    }
  }

  if (req.kind === 'video' && req.streams?.length) {
    const hls = req.streams.find(isPlaylist)
    if (hls) {
      try {
        return await downloadHls(hls, dir, referer)
      } catch (err) {
        errors.push((err as Error).message)
      }
    }
    try {
      const dash = await downloadDash(req.streams, dir, referer)
      if (dash) return dash
    } catch (err) {
      errors.push((err as Error).message)
    }
    for (const s of req.streams.filter((s) => !/bytestart=/.test(s))) {
      try {
        const file = await download(s, dir, referer, 'video')
        if (file) return file
      } catch (err) {
        errors.push((err as Error).message)
      }
    }
  }
  throw new Error(errors[0] ?? 'Не удалось найти файл для скачивания')
}

function cleanTitle(title: string | undefined): string | undefined {
  const t = title?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : undefined
}

export async function handleClip(req: ClipRequest, deps: ClipperDeps): Promise<ImportResult> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-clip-'))
  try {
    const raw = await fetchClip(req, dir)
    // Give the file a readable name so it shows up nicely when dragged out of Stash later.
    const name = cleanTitle(req.title) ?? new URL(req.pageUrl ?? 'https://web').hostname
    const nice = path.join(dir, `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}${path.extname(raw)}`)
    await fs.promises.rename(raw, nice)
    return await deps.importFile(nice, req.folderId ?? null, { name, url: req.pageUrl, tags: req.tags })
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

// ---------- HTTP server ----------

/**
 * Only the extension (chrome-extension:// / moz-extension:// origins) and local tools without an Origin
 * may talk to the server. Ordinary web pages always send their own Origin, so they are rejected — and the
 * Host check stops DNS-rebinding tricks.
 */
function allowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const origin = req.headers.origin
  return !origin || /^(chrome|moz|safari-web)-extension:\/\//.test(origin)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Слишком большой запрос'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startClipperServer(deps: ClipperDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(origin && allowed(req) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type' } : {})
      })
      res.end(JSON.stringify(body))
    }

    if (!allowed(req)) return reply(403, { error: 'forbidden' })
    if (req.method === 'OPTIONS') return reply(204, {})

    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return reply(200, { app: 'stash', library: deps.libraryName() })
      }
      if (req.method === 'GET' && url.pathname === '/api/folders') {
        return reply(200, { folders: deps.libraryName() ? deps.folders() : [] })
      }
      if (req.method === 'POST' && url.pathname === '/api/add') {
        if (!deps.libraryName()) return reply(409, { error: 'В Stash не открыта библиотека' })
        const body = JSON.parse(await readBody(req)) as ClipRequest
        const r = await handleClip(body, deps)
        return reply(200, { ok: true, ...r })
      }
      reply(404, { error: 'not found' })
    } catch (err) {
      console.warn('[clipper]', err)
      reply(500, { error: (err as Error).message })
    }
  })
  server.on('error', (err) => console.error('[clipper] server error', err))
  server.listen(CLIPPER_PORT, '127.0.0.1')
  return server
}
