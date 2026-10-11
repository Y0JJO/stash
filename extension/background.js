// Stash Clipper — background service worker.
// Talks to the Stash desktop app at http://127.0.0.1:41597 and remembers which video
// streams each tab requested (needed for sites that play video through blob: URLs).

const API = 'http://127.0.0.1:41597'
const MAX_STREAMS = 40

// ---------- context menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'stash-save', title: 'Сохранить в Stash', contexts: ['image', 'video', 'page', 'link', 'frame'] })
    chrome.contextMenus.create({ id: 'stash-sep', type: 'separator', contexts: ['page', 'image', 'video', 'link', 'frame'] })
    chrome.contextMenus.create({ id: 'stash-batch', title: 'Сохранить картинки страницы…', contexts: ['page', 'image', 'link', 'frame'] })
    chrome.contextMenus.create({ id: 'stash-area', title: 'Захват области → Stash', contexts: ['page', 'image', 'video', 'link', 'frame'] })
    chrome.contextMenus.create({ id: 'stash-shot', title: 'Видимая область → Stash', contexts: ['page', 'image', 'video', 'link', 'frame'] })
    chrome.contextMenus.create({ id: 'stash-page', title: 'Вся страница → Stash', contexts: ['page', 'image', 'video', 'link', 'frame'] })
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return
  if (info.menuItemId === 'stash-shot') return saveScreenshot(tab)
  if (info.menuItemId === 'stash-area') return captureArea(tab)
  if (info.menuItemId === 'stash-page') return capturePage(tab)
  if (info.menuItemId === 'stash-batch') return runAction('batch', tab)

  let media = null
  try {
    media = await chrome.tabs.sendMessage(tab.id, { type: 'stash:last-target' }, { frameId: info.frameId ?? 0 })
  } catch {
    // No content script (e.g. the page was open before the extension was installed).
  }
  if (!media && info.srcUrl) {
    media = { kind: info.mediaType === 'video' ? 'video' : 'image', urls: [info.srcUrl], title: tab.title, pageUrl: tab.url }
  }
  if (!media) return saveScreenshot(tab, 'Медиа не найдено — сохранил скриншот')
  save(tab, media)
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'stash:save' && sender.tab) {
    save(sender.tab, msg.media)
    sendResponse(true)
  }
  if (msg?.type === 'stash:batch-save' && sender.tab) {
    saveBatch(sender.tab, msg.media)
    sendResponse(true)
  }
  if (msg?.type === 'stash:folders') {
    fetch(`${API}/api/folders`)
      .then((r) => r.json())
      .then(sendResponse, () => sendResponse(null))
    return true
  }
  if (msg?.type === 'stash:action' && msg.tabId) {
    chrome.tabs.get(msg.tabId).then((tab) => runAction(msg.action, tab))
    sendResponse(true)
  }
})

chrome.commands.onCommand.addListener((command, tab) => tab && runAction(command, tab))

function runAction(action, tab) {
  switch (action) {
    case 'batch':
      return chrome.tabs.sendMessage(tab.id, { type: 'stash:batch-open' }).catch(() => toast(tab.id, 'error', 'Обновите страницу'))
    case 'area':
      return captureArea(tab)
    case 'visible':
      return saveScreenshot(tab)
    case 'page':
      return capturePage(tab)
    case 'bookmark':
      return saveBookmark(tab)
  }
}

// ---------- network capture of video streams ----------

const isStream = (url) =>
  /^https?:/i.test(url) &&
  (/\.(mp4|webm|mov|m3u8)(?:[?#]|$)/i.test(url) || /[?&]bytestart=\d/.test(url)) &&
  !/\.(ts|m4s)(?:[?#]|$)/i.test(url)

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !isStream(d.url)) return
    rememberStream(d.tabId, d.url)
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
)

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`streams:${tabId}`))

// The service worker can be stopped at any time, so the list lives in session storage.
async function rememberStream(tabId, url) {
  const key = `streams:${tabId}`
  const norm = url.replace(/[?&](bytestart|byteend)=\d+/g, '')
  const list = (await chrome.storage.session.get(key))[key] ?? []
  const next = [{ url, norm }, ...list.filter((s) => s.norm !== norm)].slice(0, MAX_STREAMS)
  await chrome.storage.session.set({ [key]: next })
}

async function streamsFor(tabId) {
  const key = `streams:${tabId}`
  return ((await chrome.storage.session.get(key))[key] ?? []).map((s) => s.url)
}

// ---------- site rules: prefer the original / largest file ----------

function expandUrls(urls) {
  const out = []
  for (const url of urls) {
    if (!url) continue
    let m
    // Pinterest: /236x/, /474x/, /736x/ … → /originals/
    if ((m = /^(https:\/\/i\.pinimg\.com\/)[^/]+(\/.*)$/.exec(url))) {
      out.push(`${m[1]}originals${m[2]}`, `${m[1]}736x${m[2]}`)
    }
    // Pinterest video: HLS playlist → progressive 720p mp4
    if (/v\d?\.pinimg\.com\/videos\/.*\/hls\/.*\.m3u8/.test(url)) {
      out.push(url.replace('/hls/', '/720p/').replace(/\.m3u8.*$/, '.mp4'))
    }
    // Behance: project_modules/<size>/file → source / max sizes
    if ((m = /^(https:\/\/[^/]*behance\.net\/project_modules\/)[^/]+(\/.*)$/.exec(url))) {
      out.push(`${m[1]}source${m[2]}`, `${m[1]}max_3840${m[2]}`, `${m[1]}fs${m[2]}`, `${m[1]}1400${m[2]}`)
    }
    // Twitter / X images
    if (/^https:\/\/pbs\.twimg\.com\/media\//.test(url)) {
      const u = new URL(url)
      u.searchParams.set('name', 'orig')
      out.push(u.toString())
    }
    // Dribbble: drop resize params
    if (/^https:\/\/cdn\.dribbble\.com\//.test(url) && url.includes('?')) out.push(url.split('?')[0])
    out.push(url)
  }
  return [...new Set(out)]
}

// ---------- saving ----------

async function settings() {
  return chrome.storage.local.get({ folderId: null })
}

async function post(payload) {
  const res = await fetch(`${API}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Ошибка ${res.status}`)
  return body
}

function toast(tabId, state, text) {
  chrome.tabs.sendMessage(tabId, { type: 'stash:toast', state, text }).catch(() => {})
}

/** Builds the request for one media item; `media.folderId` (even null) overrides the popup's default folder. */
async function payload(tab, media) {
  const { folderId } = await settings()
  return {
    kind: media.kind,
    urls: expandUrls(media.urls ?? []),
    streams: media.kind === 'video' ? await streamsFor(tab.id) : undefined,
    data: media.data,
    pageUrl: media.pageUrl || tab.url,
    title: media.title || tab.title,
    tags: media.tags,
    folderId: media.folderId !== undefined ? media.folderId : folderId
  }
}

const errorText = (err) => (err instanceof TypeError ? 'Stash не запущен' : err.message)

async function save(tab, media) {
  toast(tab.id, 'busy', media.kind === 'video' ? 'Сохраняю видео…' : 'Сохраняю…')
  try {
    const r = await post(await payload(tab, media))
    toast(tab.id, 'ok', r.duplicate ? 'Уже есть в Stash' : 'Сохранено в Stash')
  } catch (err) {
    toast(tab.id, 'error', errorText(err))
  }
}

async function saveBatch(tab, list) {
  let done = 0
  let failed = 0
  let offline = false
  const queue = [...list]
  const worker = async () => {
    while (queue.length && !offline) {
      const media = queue.shift()
      try {
        await post(await payload(tab, media))
      } catch (err) {
        failed++
        if (err instanceof TypeError) offline = true
      }
      done++
      toast(tab.id, 'busy', `Сохраняю ${done} / ${list.length}`)
    }
  }
  toast(tab.id, 'busy', `Сохраняю 0 / ${list.length}`)
  await Promise.all([worker(), worker(), worker()])
  if (offline) return toast(tab.id, 'error', 'Stash не запущен')
  toast(tab.id, failed ? 'error' : 'ok', failed ? `Сохранено ${done - failed}, ошибок: ${failed}` : `Сохранено: ${done}`)
}

// ---------- captures ----------

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return `data:${blob.type};base64,${btoa(bin)}`
}

const capture = (tab) => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
const toBitmap = async (dataUrl) => createImageBitmap(await (await fetch(dataUrl)).blob())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function captureArea(tab) {
  let rect
  try {
    rect = await chrome.tabs.sendMessage(tab.id, { type: 'stash:select-area' })
  } catch {
    return toast(tab.id, 'error', 'На этой странице захват недоступен')
  }
  if (!rect) return
  try {
    const shot = await toBitmap(await capture(tab))
    const k = shot.width / rect.vw // device pixels per CSS pixel
    const canvas = new OffscreenCanvas(Math.round(rect.w * k), Math.round(rect.h * k))
    canvas.getContext('2d').drawImage(shot, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, canvas.width, canvas.height)
    const data = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
    await save(tab, { kind: 'image', data, title: `Фрагмент — ${tab.title}`, pageUrl: tab.url })
  } catch (err) {
    toast(tab.id, 'error', err.message)
  }
}

/** Scrolls through the page, captures each screen and stitches them into one tall image. */
async function capturePage(tab) {
  const MAX_CSS_HEIGHT = 20000
  let m
  try {
    m = await chrome.tabs.sendMessage(tab.id, { type: 'stash:page-metrics' })
  } catch {
    return toast(tab.id, 'error', 'На этой странице захват недоступен')
  }
  const total = Math.min(m.height, MAX_CSS_HEIGHT)
  const strips = []
  try {
    for (let y = 0, i = 0; y < total; y += m.vh, i++) {
      const actual = await chrome.tabs.sendMessage(tab.id, { type: 'stash:page-scroll', y, hideFixed: i > 0 })
      if (i > 0) await sleep(550) // captureVisibleTab is limited to ~2 calls per second
      strips.push({ y: actual, bmp: await toBitmap(await capture(tab)) })
      if (actual + m.vh >= total) break
    }
  } catch (err) {
    chrome.tabs.sendMessage(tab.id, { type: 'stash:page-restore', y: m.y }).catch(() => {})
    return toast(tab.id, 'error', err.message)
  }
  chrome.tabs.sendMessage(tab.id, { type: 'stash:page-restore', y: m.y }).catch(() => {})
  const k = strips[0].bmp.width / m.vw
  const canvas = new OffscreenCanvas(strips[0].bmp.width, Math.round(total * k))
  const ctx = canvas.getContext('2d')
  for (const s of strips) ctx.drawImage(s.bmp, 0, Math.round(s.y * k))
  const data = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
  await save(tab, { kind: 'image', data, title: `Страница — ${tab.title}`, pageUrl: tab.url })
}

async function saveBookmark(tab) {
  try {
    const data = await capture(tab)
    await save(tab, { kind: 'image', data, title: tab.title, pageUrl: tab.url, tags: ['закладка'] })
  } catch (err) {
    toast(tab.id, 'error', err.message)
  }
}

async function saveScreenshot(tab, note) {
  try {
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    await save(tab, { kind: 'image', data, title: `Скриншот — ${tab.title}`, pageUrl: tab.url })
    if (note) toast(tab.id, 'ok', note)
  } catch (err) {
    toast(tab.id, 'error', err.message)
  }
}
