// End-to-end: the real Stash app (isolated profile + throwaway library) against `wrangler dev` and a fake Bot API.
// Run `npm run build` in the repo root and `npx wrangler dev --port 8799` here first.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'package.json'))
const sharp = require('sharp')

const RELAY = 'http://127.0.0.1:8799'
const secret = createHash('sha256').update('stash-webhook:123:TEST').digest('hex')
const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#c0392b' } }).png().toBuffer()
const sent = []

http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.url === '/file/bot123:TEST/photos/file_7.png') return res.writeHead(200, { 'Content-Length': png.length }).end(png)
    const m = /^\/bot123:TEST\/(\w+)$/.exec(req.url)
    if (!m) return res.writeHead(404).end('{}')
    let result = true
    if (m[1] === 'getMe') result = { username: 'test_bot' }
    if (m[1] === 'sendMessage') sent.push(JSON.parse(body))
    if (m[1] === 'getFile') result = { file_path: 'photos/file_7.png' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
  })
  .listen(8798)

const push = (extra) =>
  fetch(`${RELAY}/webhook`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 77, from: { id: 1, username: 'user1' }, chat: { id: 1, type: 'private' }, ...extra } })
  })
const until = async (what, fn, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return console.log(`PASS  ${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timed out: ${what}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-e2e-'))
const userData = path.join(tmp, 'profile')
const library = path.join(tmp, 'Test.stash')
fs.mkdirSync(userData)
const K = randomBytes(32).toString('base64url')
const P = createHash('sha256').update(K).digest('base64url')
// A plain (unencrypted) key is accepted, which lets the test skip the pairing button and its browser hop.
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ telegram: { cloudKey: K } }))
const config = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).telegram ?? {}

const electron = require('electron')
const app = spawn(electron, ['.'], {
  cwd: root,
  env: { ...process.env, STASH_USER_DATA: userData, STASH_LIBRARY: library, STASH_RELAY_URL: RELAY },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))

let failed = false
try {
  await until('Stash connects to the relay and learns the bot name', () => config().botName === 'test_bot')
  await push({ text: `/start ${P}` })
  await until('pressing Start pairs this Stash', () => config().ownerName === '@user1' && sent.some((s) => s.text.includes('привязан')))
  await push({ photo: [{ file_id: 'thumb' }, { file_id: 'PHOTO_7', file_size: png.length }], caption: 'Красный референс #цвет #тест' })
  await until('photo is imported and the bot confirms', () => sent.some((s) => s.chat_id === 1 && s.text.includes('Добавлено: 1') && s.reply_parameters?.message_id === 77))
  const files = fs.readdirSync(library, { recursive: true }).filter((f) => String(f).endsWith('.png') && !String(f).includes('thumb'))
  console.log(files.length ? `PASS  file is in the library: ${files[0]}` : 'FAIL  no png in the library')
  failed ||= !files.length
  await push({ photo: [{ file_id: 'PHOTO_7', file_size: png.length }] })
  await until('same photo again is reported as a duplicate', () => sent.some((s) => s.text.includes('Уже было')))
  await push({ text: 'просто текст' })
  await until('plain text gets a hint', () => sent.some((s) => s.text.includes('ни файла, ни ссылки')))
} catch (err) {
  failed = true
  console.error('FAIL ', err.message, '\n--- app log ---\n' + log.slice(-2000), '\n--- sent ---\n', sent)
}
app.kill()
await new Promise((r) => setTimeout(r, 1500))
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
console.log(failed ? '\nFAILED' : '\nALL PASSED')
process.exit(failed ? 1 : 0)
