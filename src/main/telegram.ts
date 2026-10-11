import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net, safeStorage } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { IMAGE_EXT, VIDEO_EXT } from './media'
import type { ClipperDeps } from './clipper'
import type { ImportResult } from './importer'
import type { TelegramStatus } from '../shared/types'

/**
 * Telegram bot: whatever the owner sends it (photos, videos, files, albums, links to posts) lands in the
 * open library. Two ways to receive messages:
 *  - "cloud": the shared Stash bot. Its token lives on the relay (see /relay); Stash holds only its own key,
 *    pairs with one click and gets messages over a WebSocket. Nothing to type.
 *  - "token": the user's own bot from @BotFather, polled directly from this computer. No server involved.
 * Either way undelivered messages wait (24 h at Telegram, 48 h on the relay) while Stash is closed.
 */

/** Address of the deployed relay; empty means the one-click mode is not offered. */
const RELAY_URL = (process.env.STASH_RELAY_URL ?? '').replace(/\/+$/, '')
/** How the relay knows this install: a hash, so the pairing link never exposes the key itself. */
const cloudId = (key: string) => createHash('sha256').update(key).digest('base64url')

export interface TelegramConfig {
  /** Bot token, encrypted with safeStorage when available (prefixed "enc:"). */
  token?: string
  /** This install's secret key for the relay (cloud mode), stored like the token. */
  cloudKey?: string
  ownerId?: number
  ownerName?: string
  botName?: string
  folderId?: string | null
  /** Browser whose login gallery-dl / yt-dlp borrow for sites that need one (Instagram). */
  cookiesFrom?: 'none' | 'firefox' | 'chrome' | 'edge'
}

export interface TelegramDeps extends ClipperDeps {
  config(): TelegramConfig
  save(c: TelegramConfig): void
  onStatus(s: TelegramStatus): void
}

const API = 'https://api.telegram.org'
const FFMPEG = (ffmpegStatic ?? 'ffmpeg').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Telegram's Bot API refuses to hand out files larger than this. */
const BOT_FILE_LIMIT = 20 * 1024 * 1024
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|twitch\.tv|vk\.com|vkvideo\.ru|rutube\.ru|dailymotion\.com)$/i
/** Links that are a video even on mostly-image sites (Instagram reels, YouTube shorts…). */
const isVideoLink = (u: URL) => VIDEO_HOSTS.test(u.hostname) || /\/(reels?|tv|shorts|videos?)\//i.test(u.pathname)

type Browser = 'firefox' | 'edge' | 'chrome'
/** Firefox first: recent Chrome/Edge encrypt cookies in a way the tools often can't read. */
const BROWSERS: Browser[] = ['firefox', 'edge', 'chrome']
const needsLogin = (errors: string[]) => /login|log in|cookies|private|rate.?limit|401|403/i.test(errors.join(' '))

const MAC = process.platform === 'darwin'

/** Where each tool's official build lives. gallery-dl publishes executables on Codeberg, not GitHub. */
const TOOLS = {
  'yt-dlp': async () => `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${MAC ? 'yt-dlp_macos' : 'yt-dlp.exe'}`,
  'gallery-dl': async () => {
    if (MAC) throw new Error('для macOS нет готовой сборки')
    const res = await net.fetch('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest')
    const rel = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] }
    const exe = rel.assets?.find((a) => a.name === 'gallery-dl.exe')
    if (!exe) throw new Error('не найден файл в релизе')
    return exe.browser_download_url
  }
} satisfies Record<string, () => Promise<string>>
type Tool = keyof typeof TOOLS

const toolsDir = () => path.join(app.getPath('userData'), 'tools')
const toolPath = (t: Tool) => path.join(toolsDir(), MAC ? t : `${t}.exe`)
const hasTool = (t: Tool) => fs.existsSync(toolPath(t))
export const toolsInstalled = () => (Object.keys(TOOLS) as Tool[]).every(hasTool)

export function encodeToken(token: string): string {
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(token).toString('base64') : token
}

function decodeToken(stored: string | undefined): string | null {
  if (!stored) return null
  if (!stored.startsWith('enc:')) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  } catch {
    return null
  }
}

// ---------- Bot API types (only the fields we use) ----------

interface TgFile {
  file_id: string
  file_size?: number
  file_name?: string
  mime_type?: string
}
interface TgEntity {
  type: string
  offset: number
  length: number
  url?: string
}
interface TgMessage {
  message_id: number
  from?: { id: number; first_name?: string; username?: string }
  chat: { id: number }
  text?: string
  caption?: string
  entities?: TgEntity[]
  caption_entities?: TgEntity[]
  media_group_id?: string
  photo?: (TgFile & { width: number; height: number })[]
  video?: TgFile
  animation?: TgFile
  document?: TgFile
  video_note?: TgFile
  forward_origin?: { type: string; chat?: { username?: string }; message_id?: number }
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
}

/** Tally of one reply ("✓ Добавлено: 3"), shared by all messages of an album. */
interface Report {
  chatId: number
  replyTo: number
  added: number
  dup: number
  errors: string[]
  pending: number
  timer?: NodeJS.Timeout
}

export class TelegramBot {
  private token: string | null = null
  private abort: AbortController | null = null
  private running = false
  private offset = 0
  private pairCode: string | null = null
  private status: TelegramStatus = { state: 'off' }
  private albums = new Map<string, Report>()
  private cloudKey: string | null = null
  private ws: WebSocket | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = 1000

  constructor(private deps: TelegramDeps) {}

  // ---------- lifecycle ----------

  /** (Re)starts with whatever is stored: the relay key or an own-bot token. Safe to call repeatedly. */
  start(): void {
    this.stop()
    this.cloudKey = RELAY_URL ? decodeToken(this.deps.config().cloudKey) : null
    if (this.cloudKey) {
      this.running = true
      return this.connectCloud()
    }
    this.token = decodeToken(this.deps.config().token)
    if (!this.token) return this.setStatus({ state: 'off' })
    if (!this.deps.config().ownerId) this.pairCode ??= String(randomInt(100000, 1000000))
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
    this.abort = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  getStatus(): TelegramStatus {
    const c = this.deps.config()
    const cloud = !!this.cloudKey
    return {
      ...this.status,
      mode: cloud ? 'cloud' : c.token ? 'token' : undefined,
      cloudAvailable: !!RELAY_URL,
      botName: c.botName,
      ownerName: c.ownerName,
      folderId: c.folderId ?? null,
      cookiesFrom: c.cookiesFrom ?? 'none',
      toolsInstalled: toolsInstalled(),
      pairCode: cloud || c.ownerId ? undefined : this.pairCode ?? undefined,
      pairUrl: cloud && c.botName && !c.ownerName ? `https://t.me/${c.botName}?start=${cloudId(this.cloudKey!)}` : undefined
    }
  }

  private setStatus(s: TelegramStatus): void {
    this.status = s
    this.deps.onStatus(this.getStatus())
  }

  /** Checks a token with getMe and starts the bot with it. Returns the bot's @username. */
  async connect(token: string): Promise<string> {
    token = token.trim()
    if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error('Это не похоже на токен бота. Он выглядит так: 123456789:AA…')
    const me = await this.call<{ username: string }>('getMe', {}, token)
    this.pairCode = String(randomInt(100000, 1000000))
    await this.unlinkCloud()
    this.deps.save({ ...this.deps.config(), token: encodeToken(token), cloudKey: undefined, botName: me.username, ownerId: undefined, ownerName: undefined })
    this.start()
    return me.username
  }

  /**
   * One-click pairing with the shared bot: makes this install's key if needed, connects to the relay and
   * returns the t.me link that, once the user presses Start there, binds their account to this Stash.
   */
  async cloudPair(): Promise<string> {
    if (!RELAY_URL) throw new Error('Общий бот Stash ещё не настроен.')
    const { cookiesFrom, folderId, cloudKey } = this.deps.config()
    if (!this.cloudKey) {
      this.deps.save({ cookiesFrom, folderId, cloudKey: decodeToken(cloudKey) ? cloudKey : encodeToken(randomBytes(32).toString('base64url')) })
      this.start()
    }
    // The link needs the bot's name, which arrives with the relay's first message.
    for (let i = 0; i < 60; i++) {
      const s = this.getStatus()
      if (s.pairUrl) return s.pairUrl
      if (s.state === 'online' && s.ownerName) throw new Error(`Уже привязано к ${s.ownerName}.`)
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('Сервер Stash не отвечает. Проверьте интернет и попробуйте ещё раз.')
  }

  /** Tells the relay to forget this install, so the bot stops forwarding to it. */
  private async unlinkCloud(): Promise<void> {
    if (!this.cloudKey) return
    await net.fetch(`${RELAY_URL}/api/unlink`, { method: 'POST', headers: { Authorization: `Bearer ${this.cloudKey}` } }).catch(() => {})
  }

  async disconnect(): Promise<void> {
    await this.unlinkCloud()
    this.stop()
    this.pairCode = null
    this.cloudKey = null
    const { cookiesFrom, folderId } = this.deps.config()
    this.deps.save({ cookiesFrom, folderId })
    this.setStatus({ state: 'off' })
  }

  /** Forgets the owner, so the bot can be paired with another account. */
  async repair(): Promise<void> {
    if (this.cloudKey) {
      // A fresh key: the old pairing link must not work any more.
      await this.unlinkCloud()
      const { cookiesFrom, folderId } = this.deps.config()
      this.deps.save({ cookiesFrom, folderId, cloudKey: encodeToken(randomBytes(32).toString('base64url')) })
      return this.start()
    }
    this.pairCode = String(randomInt(100000, 1000000))
    this.deps.save({ ...this.deps.config(), ownerId: undefined, ownerName: undefined })
    this.setStatus(this.status)
  }

  update(patch: Pick<TelegramConfig, 'folderId' | 'cookiesFrom'>): void {
    this.deps.save({ ...this.deps.config(), ...patch })
    this.setStatus(this.status)
  }

  // ---------- Bot API ----------

  private async call<T>(method: string, body: object, token = this.token, signal?: AbortSignal): Promise<T> {
    const res = await net.fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
    if (!json.ok) {
      if (res.status === 401 || res.status === 404) throw new Error('Telegram не принял токен. Проверьте, что скопировали его целиком.')
      throw new Error(json.description ?? `Telegram ответил ${res.status}`)
    }
    return json.result as T
  }

  private reply(chatId: number, text: string, replyTo?: number): void {
    if (this.cloudKey) {
      // The relay only ever writes to the paired owner, so no chat id is sent.
      void net
        .fetch(`${RELAY_URL}/api/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cloudKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, replyTo })
        })
        .catch((err) => console.warn('[telegram] reply failed', err))
      return
    }
    void this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
    }).catch((err) => console.warn('[telegram] reply failed', err))
  }

  private async loop(): Promise<void> {
    let delay = 1000
    while (this.running) {
      this.abort = new AbortController()
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 50, allowed_updates: ['message'] },
          this.token,
          this.abort.signal
        )
        if (this.status.state !== 'online') this.setStatus({ state: 'online' })
        delay = 1000
        for (const u of updates) {
          this.offset = u.update_id + 1
          if (u.message) void this.onMessage(u.message).catch((err) => console.warn('[telegram]', err))
        }
      } catch (err) {
        if (!this.running) return
        const message = (err as Error).message
        this.setStatus({ state: 'error', message })
        // A rejected token won't fix itself; anything else (no internet, proxy hiccup) is retried with backoff.
        if (/токен/.test(message)) return this.stop()
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  // ---------- relay (cloud mode) ----------

  private connectCloud(): void {
    const ws = (this.ws = new WebSocket(`${RELAY_URL.replace(/^http/, 'ws')}/api/ws`, ['stash', this.cloudKey!]))
    let alive = true
    let ping: NodeJS.Timeout | null = null
    ws.onopen = () => {
      this.retryDelay = 1000
      // A dead connection (sleep, Wi-Fi change) is only noticed by missing pongs.
      ping = setInterval(() => {
        if (!alive) return ws.close()
        alive = false
        ws.send('ping')
      }, 30_000)
    }
    ws.onmessage = (e) => {
      alive = true
      if (e.data === 'pong' || this.ws !== ws) return
      try {
        this.onCloud(JSON.parse(String(e.data)), ws)
      } catch (err) {
        console.warn('[telegram] bad relay message', err)
      }
    }
    ws.onerror = () => {} // 'close' always follows and does the work
    ws.onclose = () => {
      if (ping) clearInterval(ping)
      if (this.ws !== ws) return
      this.ws = null
      if (!this.running) return
      this.setStatus({ state: 'error', message: 'нет связи с сервером, переподключение…' })
      this.retryTimer = setTimeout(() => this.connectCloud(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
    }
  }

  private onCloud(msg: { type: string; bot?: string; owner?: { name: string } | null; seq?: number; message?: TgMessage }, ws: WebSocket): void {
    const cfg = this.deps.config()
    if (msg.type === 'hello') {
      this.deps.save({ ...cfg, botName: msg.bot, ownerName: msg.owner?.name })
      this.setStatus({ state: 'online' })
    } else if (msg.type === 'paired' || msg.type === 'unlinked') {
      this.deps.save({ ...cfg, ownerName: msg.type === 'paired' ? msg.owner?.name : undefined })
      this.setStatus(this.status)
    } else if (msg.type === 'msg' && msg.message) {
      // Acked on receipt, like getUpdates' offset: a message is handled at most once.
      ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }))
      void this.handleOwner(msg.message).catch((err) => console.warn('[telegram]', err))
    }
  }

  // ---------- messages ----------

  /** Own-bot mode: pairing by code and the owner check happen here (the relay does both in cloud mode). */
  private async onMessage(m: TgMessage): Promise<void> {
    const cfg = this.deps.config()
    const from = m.from
    if (!from) return
    const text = (m.text ?? m.caption ?? '').trim()

    if (!cfg.ownerId) {
      // Pairing: the owner proves they're at this computer by sending the code shown in Stash.
      const code = /(\d{6})/.exec(text)?.[1]
      if (this.pairCode && code === this.pairCode) {
        const name = from.username ? `@${from.username}` : from.first_name ?? String(from.id)
        this.pairCode = null
        this.deps.save({ ...cfg, ownerId: from.id, ownerName: name })
        this.setStatus(this.status)
        this.reply(m.chat.id, '✓ Готово, бот привязан к Stash.\n\nПрисылайте фото, видео, файлы, альбомы или ссылки на посты — всё попадёт в библиотеку.\nХэштеги в подписи станут тегами: <code>#свет #референс</code>')
      } else {
        this.reply(m.chat.id, 'Чтобы привязать бота, отправьте код из окна «Telegram-бот» в Stash.')
      }
      return
    }
    // Strangers who found the bot's name get silence.
    if (from.id !== cfg.ownerId) return
    return this.handleOwner(m)
  }

  private async handleOwner(m: TgMessage): Promise<void> {
    const text = (m.text ?? m.caption ?? '').trim()
    if (/^\/(start|help)\b/.test(text)) {
      this.reply(m.chat.id, 'Присылайте фото, видео, файлы, альбомы или ссылки на посты — всё попадёт в Stash.\nХэштеги в подписи станут тегами.\n\nФайлы, отправленные напрямую, — до 20 МБ (ограничение Telegram). Для большого видео пришлите ссылку.')
      return
    }

    if (!this.deps.libraryName()) {
      this.reply(m.chat.id, '⚠ В Stash не открыта библиотека.', m.message_id)
      return
    }

    const tags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((x) => x[1].replace(/_/g, ' ').toLowerCase())
    const plain = text.replace(/#[\p{L}\p{N}_-]+/gu, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
    const source = sourceUrl(m)
    const file = pickFile(m)
    const links = file ? [] : extractUrls(m)

    if (!file && !links.length) {
      if (text) this.reply(m.chat.id, 'Не нашёл здесь ни файла, ни ссылки.', m.message_id)
      return
    }

    // Album parts arrive as separate messages; they share one report, answered once the album is complete.
    const key = m.media_group_id ?? `m${m.message_id}`
    let report = this.albums.get(key)
    if (!report) {
      report = { chatId: m.chat.id, replyTo: m.message_id, added: 0, dup: 0, errors: [], pending: 0 }
      this.albums.set(key, report)
    }
    if (report.timer) clearTimeout(report.timer)
    report.pending++

    try {
      if (file) {
        const r = await this.importTelegramFile(file, m, { name: plain || undefined, url: source, tags })
        r.duplicate ? report.dup++ : report.added++
      } else {
        for (const link of links) {
          const rs = await this.importLink(link, { tags, name: plain || undefined }, (t) => this.reply(m.chat.id, t, m.message_id))
          for (const r of rs) r.duplicate ? report.dup++ : report.added++
        }
      }
    } catch (err) {
      report.errors.push((err as Error).message)
    } finally {
      report.pending--
      if (!report.pending) report.timer = setTimeout(() => this.finish(key), 1500)
    }
  }

  private finish(key: string): void {
    const r = this.albums.get(key)
    if (!r || r.pending) return
    this.albums.delete(key)
    const lines: string[] = []
    if (r.added) lines.push(`✓ Добавлено: ${r.added}`)
    if (r.dup) lines.push(`↺ Уже было в библиотеке: ${r.dup}`)
    for (const e of [...new Set(r.errors)]) lines.push(`✗ ${escapeHtml(e)}`)
    if (!lines.length) lines.push('✗ Ничего не нашлось для сохранения')
    this.reply(r.chatId, lines.join('\n'), r.replyTo)
  }

  private folder(): string | null {
    const id = this.deps.config().folderId
    return id && this.deps.folders().some((f) => f.id === id) ? id : null
  }

  private async importTelegramFile(f: PickedFile, m: TgMessage, meta: { name?: string; url?: string; tags: string[] }): Promise<ImportResult> {
    if ((f.file_size ?? 0) > BOT_FILE_LIMIT) throw new Error('Файл больше 20 МБ — Telegram не отдаёт такие ботам. Пришлите ссылку на пост.')
    const { res, filePath } = await this.fetchFile(f.file_id)
    if (!res.ok || !res.body) throw new Error(`Не удалось скачать файл (${res.status})`)
    const info = { file_path: filePath }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-tg-'))
    try {
      const ext = path.extname(f.file_name ?? info.file_path) || f.defaultExt
      const base = f.file_name ? path.basename(f.file_name, path.extname(f.file_name)) : meta.name ?? `Telegram ${stamp()}`
      const file = path.join(dir, safeName(base) + ext)
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file))
      const name = f.file_name ? base : meta.name ?? `Telegram ${stamp()}`
      return await this.deps.importFile(file, this.folder(), { name: m.media_group_id ? undefined : name, url: meta.url, tags: meta.tags })
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }

  /** The file's bytes plus its path at Telegram (which carries the extension). */
  private async fetchFile(fileId: string): Promise<{ res: Response; filePath: string }> {
    if (this.cloudKey) {
      const res = await net.fetch(`${RELAY_URL}/api/file/${fileId}`, { headers: { Authorization: `Bearer ${this.cloudKey}` } })
      return { res, filePath: decodeURIComponent(res.headers.get('X-File-Path') ?? '') }
    }
    const info = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!info.file_path) throw new Error('Telegram не отдал файл')
    return { res: await net.fetch(`${API}/file/bot${this.token}/${info.file_path}`), filePath: info.file_path }
  }

  // ---------- links ----------

  private async importLink(url: string, meta: { name?: string; tags: string[] }, notify: (text: string) => void): Promise<ImportResult[]> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stash-tg-'))
    try {
      const files = await this.fetchLink(url, dir, notify)
      if (!files.length) throw new Error(`Не нашёл фото или видео по ссылке ${shortUrl(url)}`)
      const out: ImportResult[] = []
      for (const f of files) {
        const name = files.length === 1 && meta.name ? meta.name : undefined
        out.push(await this.deps.importFile(f, this.folder(), { name, url, tags: meta.tags }))
      }
      return out
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * gallery-dl handles carousels, pins and galleries; yt-dlp handles video sites. Both are fetched on the first
   * link. If a site wants a login, the browsers are tried in turn and the one that works is remembered.
   * Without the tools, og:video / og:image is the fallback.
   */
  private async fetchLink(url: string, dir: string, notify: (text: string) => void): Promise<string[]> {
    const video = isVideoLink(new URL(url))
    const errors: string[] = []

    if (!toolsInstalled()) {
      if (!installing) notify('⏳ Скачиваю утилиты для загрузки по ссылкам (~40 МБ, только один раз)…')
      await ensureTools().catch((err) => errors.push(`утилиты не скачались: ${(err as Error).message}`))
    }

    const order = (video ? (['yt-dlp', 'gallery-dl'] as Tool[]) : (['gallery-dl', 'yt-dlp'] as Tool[])).filter(hasTool)
    if (order.length) {
      const attempt = async (browser?: Browser): Promise<string[]> => {
        for (const t of order) {
          try {
            await this.runTool(t, url, dir, browser)
            const files = mediaFiles(dir)
            if (files.length) return files
          } catch (err) {
            errors.push((err as Error).message)
          }
        }
        return []
      }
      const saved = this.deps.config().cookiesFrom
      const first = await attempt(saved && saved !== 'none' ? saved : undefined)
      if (first.length) return first
      if (needsLogin(errors)) {
        for (const b of BROWSERS.filter((b) => b !== saved)) {
          const files = await attempt(b)
          if (files.length) {
            this.update({ cookiesFrom: b })
            return files
          }
        }
      }
    }

    const direct = await fetchDirect(url, dir, video).catch((err) => (errors.push((err as Error).message), []))
    if (direct.length) return direct
    if (needsLogin(errors)) throw new Error(`${shortUrl(url)}: сайт требует входа. Залогиньтесь на нём в Firefox, Edge или Chrome и пришлите ссылку ещё раз.`)
    throw new Error(`${shortUrl(url)}: ${errors[0] ?? 'не удалось скачать'}`)
  }

  private runTool(tool: Tool, url: string, dir: string, browser?: Browser): Promise<void> {
    const cookies = browser ? ['--cookies-from-browser', browser] : []
    const args =
      tool === 'yt-dlp'
        ? ['--no-progress', '--ffmpeg-location', FFMPEG, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--max-filesize', '4G', '-o', path.join(dir, '%(title).80B [%(id)s].%(ext)s'), ...cookies, url]
        : ['-D', dir, '--no-part', ...cookies, url]
    return new Promise((resolve, reject) => {
      execFile(toolPath(tool), args, { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve()
        const line = stderr.toString().split('\n').map((s) => s.trim()).filter(Boolean).pop()
        reject(new Error((line ?? err.message).replace(/^ERROR:\s*/, '').slice(0, 200)))
      })
    })
  }
}

// ---------- tool install ----------

let installing: Promise<void> | null = null

/** One shared download, however many links arrive while it runs. */
function ensureTools(onProgress: (done: number, total: number) => void = () => {}): Promise<void> {
  installing ??= installTools(onProgress).finally(() => (installing = null))
  return installing
}
export { ensureTools as installTools }

/** Downloads gallery-dl and yt-dlp from their official GitHub releases into userData/tools. */
async function installTools(onProgress: (done: number, total: number) => void): Promise<void> {
  await fs.promises.mkdir(toolsDir(), { recursive: true })
  const list = Object.entries(TOOLS) as [Tool, () => Promise<string>][]
  const errors: string[] = []
  // Each tool on its own: one failing still leaves the other usable.
  for (let i = 0; i < list.length; i++) {
    const [tool, resolve] = list[i]
    onProgress(i, list.length)
    if (hasTool(tool)) continue
    try {
      const res = await net.fetch(await resolve())
      if (!res.ok || !res.body) throw new Error(String(res.status))
      const tmp = toolPath(tool) + '.part'
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp))
      await fs.promises.rename(tmp, toolPath(tool))
      if (MAC) await fs.promises.chmod(toolPath(tool), 0o755)
    } catch (err) {
      errors.push(`${tool}: ${(err as Error).message}`)
    }
  }
  onProgress(list.length, list.length)
  if (errors.length) throw new Error(errors.join('; '))
}

// ---------- helpers ----------

interface PickedFile extends TgFile {
  defaultExt: string
}

function pickFile(m: TgMessage): PickedFile | null {
  // Telegram sends several sizes of a photo; the last is the largest.
  if (m.photo?.length) return { ...m.photo[m.photo.length - 1], defaultExt: '.jpg' }
  if (m.video) return { ...m.video, defaultExt: '.mp4' }
  if (m.animation) return { ...m.animation, defaultExt: '.mp4' }
  if (m.video_note) return { ...m.video_note, defaultExt: '.mp4' }
  if (m.document) return { ...m.document, defaultExt: '' }
  return null
}

function extractUrls(m: TgMessage): string[] {
  const text = m.text ?? m.caption ?? ''
  const entities = m.entities ?? m.caption_entities ?? []
  // Entity offsets are in UTF-16 code units, which is exactly how JS strings index.
  const urls = entities.flatMap((e) => (e.type === 'url' ? [text.substr(e.offset, e.length)] : e.type === 'text_link' && e.url ? [e.url] : []))
  if (!urls.length) urls.push(...(text.match(/https?:\/\/\S+/g) ?? []))
  return [...new Set(urls.map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)))]
}

/** A forwarded channel post links back to the original. */
function sourceUrl(m: TgMessage): string | undefined {
  const o = m.forward_origin
  if (o?.type === 'channel' && o.chat?.username && o.message_id) return `https://t.me/${o.chat.username}/${o.message_id}`
  return undefined
}

function mediaFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const ext = path.extname(e.name).slice(1).toLowerCase()
        if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) out.push(p)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** Fallback without the tools: the URL itself is media, or the page names it in og:video / og:image. */
async function fetchDirect(url: string, dir: string, videoLink: boolean): Promise<string[]> {
  const get = (u: string) => net.fetch(u, { headers: { 'User-Agent': UA } })
  const save = async (res: Response, u: string): Promise<string[]> => {
    const type = (res.headers.get('content-type') ?? '').split(';')[0]
    const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? ''
    if (!/^(image|video)\//.test(type) || !res.body) return []
    const file = path.join(dir, safeName(path.basename(new URL(u).pathname, path.extname(new URL(u).pathname)) || 'media') + '.' + ext)
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file))
    return [file]
  }
  const res = await get(url)
  if (!res.ok) throw new Error(`сайт ответил ${res.status}`)
  if (!/text\/html/.test(res.headers.get('content-type') ?? '')) return save(res, url)
  const html = (await res.text()).slice(0, 2_000_000)
  const meta = (prop: string) =>
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)`, 'i').exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i').exec(html)?.[1]
  // For a video post the og:image is just its cover — saving that instead of the video would be misleading.
  const video = videoLink || /^video/i.test(meta('og:type') ?? '')
  const props = ['og:video:secure_url', 'og:video:url', 'og:video', ...(video ? [] : ['og:image:secure_url', 'og:image', 'twitter:image'])]
  for (const prop of props) {
    const found = meta(prop)?.replace(/&amp;/g, '&')
    if (!found) continue
    const abs = new URL(found, url).toString()
    const r = await get(abs).catch(() => null)
    if (r?.ok) {
      const files = await save(r, abs)
      if (files.length) return files
    }
  }
  if (video) throw new Error('не удалось скачать видео')
  return []
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80).trim() || 'file'
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
