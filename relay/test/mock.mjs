// Local end-to-end check: a fake Bot API + a fake Stash client against `wrangler dev`.
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const RELAY = 'http://127.0.0.1:8799'
const TOKEN = '123:TEST'
const secret = createHash('sha256').update(`stash-webhook:${TOKEN}`).digest('hex')
const sent = []
let hook = null

// ---- fake Telegram ----
http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const m = /^\/bot123:TEST\/(\w+)$/.exec(req.url)
    if (req.url === '/file/bot123:TEST/photos/file_1.jpg') return res.writeHead(200, { 'Content-Length': 5 }).end('IMAGE')
    if (!m) return res.writeHead(404).end('{}')
    const data = body ? JSON.parse(body) : {}
    let result = true
    if (m[1] === 'getMe') result = { username: 'test_bot' }
    if (m[1] === 'setWebhook') hook = data
    if (m[1] === 'sendMessage') sent.push(data)
    if (m[1] === 'getFile') result = { file_path: 'photos/file_1.jpg' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
  })
  .listen(8798)

const push = (message, s = secret) =>
  fetch(`${RELAY}/webhook`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': s, 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message })
  })
const msg = (userId, extra) => ({
  message_id: Math.floor(Math.random() * 1e6),
  from: { id: userId, username: `user${userId}` },
  chat: { id: userId, type: 'private' },
  ...extra
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`)
  if (!ok) failed++
}

function client(key) {
  const got = []
  const ws = new WebSocket(`${RELAY.replace('http', 'ws')}/api/ws`, ['stash', key])
  ws.onmessage = (e) => got.push(e.data === 'pong' ? 'pong' : JSON.parse(e.data))
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('ws failed'))
  })
  return { ws, got, open }
}

const K = randomBytes(32).toString('base64url')
const P = createHash('sha256').update(K).digest('base64url')
const K2 = randomBytes(32).toString('base64url')
const P2 = createHash('sha256').update(K2).digest('base64url')
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }
const msgs = (c) => c.got.filter((g) => g.type === 'msg')

try {
  const setup = await (await fetch(`${RELAY}/setup`)).text()
  check('setup registers webhook', setup.includes('test_bot') && hook?.url === `${RELAY}/webhook` && hook.secret_token === secret, setup)
  check('webhook rejects wrong secret', (await push(msg(1, { text: 'hi' }), 'nope')).status === 403)
  const badKey = await new Promise((r) => {
    const w = new WebSocket(`${RELAY.replace('http', 'ws')}/api/ws`, ['stash', 'short'])
    w.onerror = () => r(true)
    w.onopen = () => r(false)
  })
  check('ws rejects bad key', badKey)

  await push(msg(1, { text: 'hello' }))
  check('unpaired user gets instructions', sent.at(-1)?.text.includes('Привязать Telegram'))

  await push(msg(1, { text: `/start ${P}` }))
  check('pairing before Stash connected is refused', sent.at(-1)?.text.includes('устарела'))

  const a = client(K)
  await a.open
  await wait(300)
  check('hello carries bot name, no owner', a.got[0]?.type === 'hello' && a.got[0].bot === 'test_bot' && a.got[0].owner === null, JSON.stringify(a.got))

  await push(msg(1, { text: `/start ${P}` }))
  await wait(300)
  check('pairing notifies Stash and user', a.got.some((g) => g.type === 'paired' && g.owner.name === '@user1') && sent.at(-1)?.text.includes('привязан'))

  await push(msg(2, { text: `/start ${P}` }))
  check('second account cannot take a paired Stash', sent.at(-1)?.chat_id === 2 && sent.at(-1).text.includes('другому аккаунту'))

  await push(msg(1, { photo: [{ file_id: 'small' }, { file_id: 'BIG_1' }], caption: '#тег' }))
  await wait(300)
  check('message delivered live', msgs(a)[0]?.seq === 1 && msgs(a)[0].message.caption === '#тег', JSON.stringify(a.got))

  await push(msg(2, { text: 'spam' }))
  await wait(200)
  check('message from another user is not delivered', msgs(a).length === 1)

  let r = await fetch(`${RELAY}/api/file/BIG_1`, { headers: H })
  check('file proxied with path header', r.status === 200 && (await r.text()) === 'IMAGE' && decodeURIComponent(r.headers.get('X-File-Path')) === 'photos/file_1.jpg')
  check('unknown file id refused', (await fetch(`${RELAY}/api/file/OTHER`, { headers: H })).status === 404)
  check('file needs the key', (await fetch(`${RELAY}/api/file/BIG_1`)).status === 401)
  check('another device cannot fetch it', (await fetch(`${RELAY}/api/file/BIG_1`, { headers: { Authorization: `Bearer ${K2}` } })).status === 404)

  r = await fetch(`${RELAY}/api/reply`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'added 1', replyTo: 5 }) })
  check('reply goes to the owner only', r.status === 200 && sent.at(-1).chat_id === 1 && sent.at(-1).reply_parameters.message_id === 5)
  r = await fetch(`${RELAY}/api/reply`, { method: 'POST', headers: { ...H, Authorization: `Bearer ${K2}` }, body: JSON.stringify({ text: 'x' }) })
  check('unpaired device cannot send', r.status === 409)

  a.ws.send('ping')
  await wait(200)
  check('ping answered', a.got.includes('pong'))

  // Offline queue: message 1 was never acked, message 2 arrives while disconnected.
  a.ws.close()
  await wait(300)
  await push(msg(1, { text: 'https://example.com/post' }))
  const b = client(K)
  await b.open
  await wait(400)
  check('backlog redelivered after reconnect', msgs(b).map((g) => g.seq).join() === '1,2' && b.got[0].owner?.name === '@user1', JSON.stringify(b.got))
  b.ws.send(JSON.stringify({ type: 'ack', seq: 1 }))
  b.ws.send(JSON.stringify({ type: 'ack', seq: 2 }))
  await wait(300)
  b.ws.close()
  await wait(200)
  const c = client(K)
  await c.open
  await wait(400)
  check('acked messages are gone', msgs(c).length === 0, JSON.stringify(c.got))

  // Pairing a second Stash with the same account moves the link.
  const d = client(K2)
  await d.open
  await push(msg(1, { text: `/start ${P2}` }))
  await wait(400)
  check('new Stash paired, old one unlinked', d.got.some((g) => g.type === 'paired') && c.got.some((g) => g.type === 'unlinked'), JSON.stringify(c.got))
  await push(msg(1, { text: 'after move' }))
  await wait(300)
  check('messages now go to the new Stash', msgs(d).length === 1 && msgs(c).length === 0)

  r = await fetch(`${RELAY}/api/unlink`, { method: 'POST', headers: { Authorization: `Bearer ${K2}` } })
  await push(msg(1, { text: 'after unlink' }))
  await wait(300)
  check('unlink from Stash stops delivery', r.status === 200 && sent.at(-1).text.includes('Привязать Telegram') && msgs(d).length === 1)
} catch (err) {
  console.error(err)
  failed++
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
