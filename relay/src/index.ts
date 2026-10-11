import { DurableObject } from 'cloudflare:workers'

/**
 * Relay for the shared Stash Telegram bot.
 *
 * The bot token lives only here. Each Stash install makes up its own secret key K and is known to the relay
 * by P = sha256(K). Pairing: Stash opens t.me/<bot>?start=<P>, the user presses Start, and from then on that
 * user's messages are queued in the device's mailbox and pushed to Stash over a WebSocket.
 * Stash can only ever reply to, and fetch files from, its own paired user.
 */

interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>
  BOT_TOKEN: string
  /** Overrides the Bot API host (tests). */
  TG_API?: string
}

interface Owner {
  id: number
  chatId: number
  name: string
}

/** Undelivered messages are dropped after this long, like Telegram's own 24 h. */
const KEEP_MS = 48 * 3600_000
const MAX_PENDING = 500
const KEY_RE = /^[A-Za-z0-9_-]{43}$/

const json = (body: unknown, status = 200) => Response.json(body, { status })

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The secret Telegram echoes back on every webhook call; derived so there is only one secret to configure. */
const webhookSecret = async (env: Env) => hex(await sha256(`stash-webhook:${env.BOT_TOKEN}`))

const tgBase = (env: Env) => env.TG_API ?? 'https://api.telegram.org'

async function tg<T>(env: Env, method: string, body: object): Promise<T> {
  const res = await fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!data.ok) throw new Error(data.description ?? `Telegram ${res.status}`)
  return data.result
}

const say = (env: Env, chatId: number, text: string, replyTo?: number) =>
  tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
  })

let botName: string | null = null
async function getBotName(env: Env): Promise<string> {
  botName ??= (await tg<{ username: string }>(env, 'getMe', {})).username
  return botName
}

const device = (env: Env, p: string) => env.MAILBOX.get(env.MAILBOX.idFromName(`d:${p}`))
const user = (env: Env, id: number) => env.MAILBOX.get(env.MAILBOX.idFromName(`u:${id}`))

/** Resolves the caller's device from its secret key (Authorization: Bearer K). */
async function auth(req: Request, env: Env, key = req.headers.get('Authorization')?.replace(/^Bearer /, '')): Promise<string | null> {
  return key && KEY_RE.test(key) ? b64url(await sha256(key)) : null
}

/** File ids a message carries (largest photo size only — that's the one Stash asks for). */
function fileIds(m: any): string[] {
  return [m.photo?.[m.photo.length - 1], m.video, m.animation, m.video_note, m.document].filter(Boolean).map((f) => f.file_id)
}

async function onWebhook(env: Env, update: any): Promise<void> {
  const m = update.message
  if (!m?.from || m.chat?.type !== 'private') return
  const text: string = (m.text ?? '').trim()
  const start = /^\/start\s+([A-Za-z0-9_-]{43})$/.exec(text)

  if (start) {
    const p = start[1]
    const name = m.from.username ? `@${m.from.username}` : m.from.first_name ?? String(m.from.id)
    const r = await device(env, p).pair({ id: m.from.id, chatId: m.chat.id, name })
    if (r === 'ok') {
      // One Stash per Telegram account: pairing a new one unlinks the previous.
      const old = await user(env, m.from.id).setDevice(p)
      if (old && old !== p) await device(env, old).unlink()
      await say(env, m.chat.id, '✓ Готово, Telegram привязан к Stash.\n\nПрисылайте фото, видео, файлы, альбомы или ссылки на посты — всё попадёт в библиотеку.\nХэштеги в подписи станут тегами: <code>#свет #референс</code>')
    } else if (r === 'taken') {
      await say(env, m.chat.id, 'Этот Stash уже привязан к другому аккаунту Telegram.')
    } else {
      await say(env, m.chat.id, 'Ссылка устарела. Нажмите «Привязать Telegram» в Stash ещё раз.')
    }
    return
  }

  const p = await user(env, m.from.id).getDevice()
  if (!p) {
    await say(env, m.chat.id, 'Этот бот сохраняет всё, что вы ему пришлёте, в программу Stash.\n\nЧтобы начать, откройте Stash и нажмите «Привязать Telegram».')
    return
  }
  if (/^\/(stop|unlink)\b/.test(text)) {
    await device(env, p).unlink()
    await user(env, m.from.id).setDevice(null)
    await say(env, m.chat.id, 'Отвязано. Чтобы привязать снова, нажмите «Привязать Telegram» в Stash.')
    return
  }
  await device(env, p).deliver(m, fileIds(m))
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    try {
      if (path === '/') return new Response('Stash relay is running.')

      // One-time: point the bot's webhook at this worker. Idempotent, so it needs no protection.
      if (path === '/setup') {
        const hook = { url: `${url.origin}/webhook`, secret_token: await webhookSecret(env), allowed_updates: ['message'] }
        try {
          await tg(env, 'setWebhook', hook)
        } catch (err) {
          // Telegram's own resolver sometimes can't find a fresh workers.dev name; hand it the address instead.
          if (!/resolve host/i.test((err as Error).message)) throw err
          const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=${url.hostname}&type=A`, { headers: { Accept: 'application/dns-json' } })
          const ip = ((await dns.json()) as { Answer?: { type: number; data: string }[] }).Answer?.find((a) => a.type === 1)?.data
          if (!ip) throw err
          // setWebhook is rate-limited to about one call a second.
          await new Promise((r) => setTimeout(r, 1500))
          await tg(env, 'setWebhook', { ...hook, ip_address: ip })
        }
        return new Response(`Готово: бот @${await getBotName(env)} подключён к ${url.origin}`)
      }

      if (path === '/webhook' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) return json({ error: 'forbidden' }, 403)
        // Always 200: an error here would make Telegram redeliver the same update over and over.
        await onWebhook(env, await req.json()).catch((err) => console.error('webhook', err))
        return json({ ok: true })
      }

      if (path === '/api/ws') {
        // Browsers can't set headers on a WebSocket, so the key travels as a subprotocol: "stash, <K>".
        const [proto, key] = (req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((s) => s.trim())
        const p = proto === 'stash' ? await auth(req, env, key) : null
        if (!p || req.headers.get('Upgrade') !== 'websocket') return json({ error: 'unauthorized' }, 401)
        const headers = new Headers(req.headers)
        headers.set('X-Bot-Name', await getBotName(env))
        return device(env, p).fetch(new Request(req, { headers }))
      }

      if (path.startsWith('/api/')) {
        const p = await auth(req, env)
        if (!p) return json({ error: 'unauthorized' }, 401)
        const dev = device(env, p)

        if (path === '/api/reply' && req.method === 'POST') {
          const owner = await dev.owner()
          if (!owner) return json({ error: 'not paired' }, 409)
          const { text, replyTo } = (await req.json()) as { text: string; replyTo?: number }
          await say(env, owner.chatId, String(text).slice(0, 4000), replyTo)
          return json({ ok: true })
        }

        if (path === '/api/unlink' && req.method === 'POST') {
          const owner = await dev.owner()
          await dev.unlink()
          if (owner && (await user(env, owner.id).getDevice()) === p) await user(env, owner.id).setDevice(null)
          return json({ ok: true })
        }

        const file = /^\/api\/file\/([\w-]+)$/.exec(path)
        if (file && req.method === 'GET') {
          // Only files this device's own user sent can be fetched.
          if (!(await dev.hasFile(file[1]))) return json({ error: 'unknown file' }, 404)
          const info = await tg<{ file_path?: string }>(env, 'getFile', { file_id: file[1] })
          if (!info.file_path) return json({ error: 'no file' }, 404)
          const res = await fetch(`${tgBase(env)}/file/bot${env.BOT_TOKEN}/${info.file_path}`)
          if (!res.ok) return json({ error: `telegram ${res.status}` }, 502)
          const headers = new Headers({ 'X-File-Path': encodeURIComponent(info.file_path) })
          const len = res.headers.get('Content-Length')
          if (len) headers.set('Content-Length', len)
          return new Response(res.body, { headers })
        }
      }
      return json({ error: 'not found' }, 404)
    } catch (err) {
      console.error(err)
      return json({ error: (err as Error).message }, 500)
    }
  }
}

/**
 * One class, two roles by name:
 *  - "u:<telegram user id>" remembers which device the user is paired with;
 *  - "d:<P>" is a device mailbox: owner, pending messages, and the WebSocket to Stash.
 * Sockets hibernate, so an idle connection costs nothing.
 */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // ----- user role -----

  async getDevice(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('device')) ?? null
  }

  async setDevice(p: string | null): Promise<string | null> {
    const old = await this.getDevice()
    if (p) await this.ctx.storage.put('device', p)
    else await this.ctx.storage.deleteAll()
    return old
  }

  // ----- device role -----

  async fetch(req: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    // Pairing is only accepted for keys a real Stash has connected with.
    await this.ctx.storage.put('armed', true)
    const owner = await this.owner()
    server.send(JSON.stringify({ type: 'hello', bot: req.headers.get('X-Bot-Name'), owner: owner ? { name: owner.name } : null }))
    for (const [k, v] of await this.ctx.storage.list<{ message: unknown }>({ prefix: 'm:' })) {
      server.send(JSON.stringify({ type: 'msg', seq: Number(k.slice(2)), message: v.message }))
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'stash' } })
  }

  async webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return
    const msg = JSON.parse(data) as { type?: string; seq?: number }
    if (msg.type === 'ack' && Number.isInteger(msg.seq)) await this.ctx.storage.delete(mkey(msg.seq!))
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code)
    } catch {
      /* already closed */
    }
  }

  private broadcast(msg: unknown): void {
    const text = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text)
      } catch {
        /* socket is going away; the message stays queued */
      }
    }
  }

  async owner(): Promise<Owner | null> {
    return (await this.ctx.storage.get<Owner>('owner')) ?? null
  }

  async pair(owner: Owner): Promise<'ok' | 'taken' | 'unknown'> {
    if (!(await this.ctx.storage.get('armed'))) return 'unknown'
    const cur = await this.owner()
    if (cur && cur.id !== owner.id) return 'taken'
    await this.ctx.storage.put('owner', owner)
    this.broadcast({ type: 'paired', owner: { name: owner.name } })
    return 'ok'
  }

  async unlink(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.broadcast({ type: 'unlinked' })
  }

  async hasFile(fileId: string): Promise<boolean> {
    return (await this.ctx.storage.get(`f:${fileId}`)) !== undefined
  }

  async deliver(message: unknown, files: string[]): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>('seq')) ?? 0) + 1
    const at = Date.now()
    await this.ctx.storage.put({ seq, [mkey(seq)]: { message, at }, ...Object.fromEntries(files.map((f) => [`f:${f}`, at])) })
    if (seq > MAX_PENDING) await this.ctx.storage.delete(mkey(seq - MAX_PENDING))
    this.broadcast({ type: 'msg', seq, message })
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(at + KEEP_MS)
  }

  /** Drops messages and file permissions older than KEEP_MS. */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - KEEP_MS
    let oldest = Infinity
    for (const prefix of ['m:', 'f:']) {
      for (const [k, v] of await this.ctx.storage.list<{ at: number } | number>({ prefix })) {
        const at = typeof v === 'number' ? v : v.at
        if (at <= cutoff) await this.ctx.storage.delete(k)
        else oldest = Math.min(oldest, at)
      }
    }
    if (oldest !== Infinity) await this.ctx.storage.setAlarm(oldest + KEEP_MS)
  }
}

/** Zero-padded so storage.list() returns messages in order. */
const mkey = (seq: number) => `m:${String(seq).padStart(12, '0')}`
