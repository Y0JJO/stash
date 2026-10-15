// Stash Clipper — content script core: media detection, hover button, toasts, area selection and
// full-page capture helpers. drag.js and batch.js build on the helpers exported via globalThis.__stash.
;(() => {
  if (globalThis.__stash) return

  const MIN_W = 140
  const MIN_H = 100
  const prefs = { hoverButton: true, dragPanel: true }
  let lastTarget = null
  let current = null

  chrome.storage.local.get(prefs, (s) => Object.assign(prefs, s))
  chrome.storage.onChanged.addListener((c) => {
    for (const k of Object.keys(prefs)) if (c[k]) prefs[k] = c[k].newValue
    if (!prefs.hoverButton) hideButton()
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  // ---------- finding media ----------

  const bgUrl = (el) => {
    const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '')
    return m && /^(https?:|data:|blob:)/.test(m[1]) ? new URL(m[1], location.href).href : null
  }

  /** Instagram/Pinterest cover media with transparent overlays, so look through the whole stack. */
  function findMedia(x, y) {
    let bg = null
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host) continue
      if (el.tagName === 'VIDEO') return el
      if (el.tagName === 'IMG' && el.naturalWidth > 1) return el
      if (!bg && el.clientWidth >= MIN_W && el.clientHeight >= MIN_H && bgUrl(el)) bg = el
    }
    return bg || mediaInside(x, y)
  }

  /**
   * elementsFromPoint skips elements with pointer-events: none, which Behance (and others) put on every
   * image, so look inside the topmost containers for media drawn under the cursor.
   */
  function mediaInside(x, y) {
    for (const el of document.elementsFromPoint(x, y).slice(0, 6)) {
      if (el === host || el === document.body || el === document.documentElement) continue
      for (const m of el.querySelectorAll('img, video')) {
        if (m.tagName === 'IMG' && m.naturalWidth <= 1) continue
        const r = m.getBoundingClientRect()
        if (r.width >= MIN_W && r.height >= MIN_H && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m
      }
    }
    return null
  }

  function bestFromSrcset(img) {
    const set = img.getAttribute('srcset')
    if (!set) return null
    let best = null
    let bestW = 0
    for (const part of set.split(/,\s+/)) {
      const [url, size = '1x'] = part.trim().split(/\s+/)
      const w = parseFloat(size) * (size.endsWith('x') ? 1000 : 1)
      if (url && w > bestW) {
        best = url
        bestW = w
      }
    }
    return best ? new URL(best, location.href).href : null
  }

  function sourcePage(el) {
    const a = el.closest?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/pin/"], a[href*="/gallery/"], a[href*="/shots/"]')
    return a ? a.href : location.href
  }

  function titleFor(el) {
    const alt = (el.getAttribute?.('alt') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim()
    return alt && alt.length > 2 ? alt : document.title
  }

  async function toDataUrl(url) {
    const blob = await (await fetch(url)).blob()
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = reject
      r.readAsDataURL(blob)
    })
  }

  const meta = (prop) => document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.content || null

  /** Turns an element into the request the background script sends to Stash. */
  async function describe(el) {
    if (!el) {
      const video = meta('og:video') || meta('og:video:url')
      const image = meta('og:image')
      if (video) return { kind: 'video', urls: [video], title: document.title, pageUrl: location.href }
      if (image) return { kind: 'image', urls: [image], title: document.title, pageUrl: location.href }
      return null
    }
    const base = { title: titleFor(el), pageUrl: sourcePage(el) }
    if (el.tagName === 'VIDEO') {
      const srcs = [el.currentSrc, el.src, ...[...el.querySelectorAll('source')].map((s) => s.src)]
      return { kind: 'video', urls: srcs.filter((s) => s && /^https?:/.test(s)), ...base }
    }
    const src = el.tagName === 'IMG' ? el.currentSrc || el.src : bgUrl(el)
    if (!src) return null
    if (/^(blob|data):/.test(src)) return { kind: 'image', data: await toDataUrl(src), ...base }
    const urls = [el.tagName === 'IMG' ? bestFromSrcset(el) : null, src, el.src].filter(Boolean)
    return { kind: 'image', urls, ...base }
  }

  const send = (msg) => chrome.runtime.sendMessage(msg)

  document.addEventListener('contextmenu', (e) => (lastTarget = findMedia(e.clientX, e.clientY)), true)

  // ---------- UI root (shadow DOM so page CSS can't touch it) ----------

  const host = document.createElement('stash-clipper')
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647; pointer-events: none;'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { --bg: rgba(24,25,30,.96); --line: rgba(255,255,255,.12); --text: #e8e9ee; --muted: #8b8e98; --accent: #6b7cff; }
    * { box-sizing: border-box; font-family: system-ui, 'Segoe UI', sans-serif; }
    .hover-btn {
      position: fixed; display: none; align-items: center; gap: 6px; pointer-events: auto;
      font-size: 12px; font-weight: 600; line-height: 1; color: #fff; cursor: pointer;
      background: rgba(24, 25, 30, 0.88); border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
      padding: 7px 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); backdrop-filter: blur(6px);
    }
    .hover-btn:hover { background: var(--accent); border-color: var(--accent); }
    .logo { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg,#ffc35c, #e0577f); flex: none; }
    .toast {
      position: fixed; right: 20px; bottom: 20px; display: none; align-items: center; gap: 8px; pointer-events: none;
      font-size: 13px; line-height: 1.3; color: var(--text); max-width: 360px;
      background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
      padding: 10px 14px; box-shadow: 0 8px 30px rgba(0,0,0,0.4); z-index: 10;
    }
    .toast b { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
    .toast.ok b { background: #4ade80; }
    .toast.error b { background: #ff8a6b; }
    .toast.busy b { animation: p .7s infinite alternate; }
    @keyframes p { to { opacity: .3 } }
    .area { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(0,0,0,.35); }
    .area .sel { position: fixed; display: none; outline: 1px solid var(--accent); box-shadow: 0 0 0 9999px rgba(0,0,0,.35); }
    .area .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 13px;
      background: var(--bg); padding: 7px 14px; border-radius: 8px; }
  `
  root.appendChild(style)
  // ShadowRoot has no insertAdjacentHTML, so build the nodes in a template.
  const tpl = document.createElement('template')
  tpl.innerHTML = `<button class="hover-btn" title="Сохранить в D3S3RT"><i class="logo"></i>D3S3RT</button>
     <div class="toast"><b></b><span></span></div>`
  root.appendChild(tpl.content)
  const button = root.querySelector('.hover-btn')
  const toastEl = root.querySelector('.toast')
  ;(document.body || document.documentElement).appendChild(host)

  // ---------- hover button ----------

  function hideButton() {
    button.style.display = 'none'
    current = null
  }

  let raf = 0
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!prefs.hoverButton || raf || globalThis.__stash.busy) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (e.composedPath().includes(host)) return
        const el = findMedia(e.clientX, e.clientY)
        const r = el?.getBoundingClientRect()
        if (!el || r.width < MIN_W || r.height < MIN_H) return hideButton()
        current = el
        button.style.display = 'flex'
        button.style.left = `${Math.max(4, r.left + 10)}px`
        button.style.top = `${Math.max(4, r.top + 10)}px`
      })
    },
    { passive: true }
  )
  window.addEventListener('scroll', hideButton, { passive: true, capture: true })

  // Stop the page from reacting (Pinterest/Instagram open the item on click).
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) button.addEventListener(type, (e) => e.stopPropagation())
  button.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    const media = await describe(current).catch(() => null)
    if (!media) return toast('error', 'Не удалось найти файл')
    send({ type: 'stash:save', media })
  })

  // ---------- toasts ----------

  let toastTimer = 0
  function toast(state, text) {
    toastEl.className = `toast ${state}`
    toastEl.querySelector('span').textContent = text
    toastEl.style.display = 'flex'
    clearTimeout(toastTimer)
    if (state !== 'busy') toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 2600)
  }

  // ---------- area selection (for "Capture area") ----------

  function selectArea() {
    return new Promise((resolve) => {
      const layer = document.createElement('div')
      layer.className = 'area'
      layer.innerHTML = '<div class="sel"></div><div class="hint">Выделите область · Esc — отмена</div>'
      root.appendChild(layer)
      const sel = layer.querySelector('.sel')
      let start = null
      let rect = null
      const finish = async (value) => {
        removeEventListener('keydown', onKey, true)
        layer.remove()
        await frames() // make sure the overlay is gone before the screenshot is taken
        resolve(value)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }
      addEventListener('keydown', onKey, true)
      layer.addEventListener('mousedown', (e) => {
        e.preventDefault()
        if (e.button !== 0) return finish(null)
        start = { x: e.clientX, y: e.clientY }
        layer.style.background = 'transparent'
        layer.querySelector('.hint').remove()
      })
      layer.addEventListener('mousemove', (e) => {
        if (!start) return
        rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) }
        Object.assign(sel.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` })
      })
      layer.addEventListener('mouseup', () => finish(rect && rect.w > 4 && rect.h > 4 ? { ...rect, vw: innerWidth } : null))
    })
  }

  // ---------- full-page capture helpers ----------

  let hiddenFixed = []
  function hideFixed() {
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position
      if ((pos === 'fixed' || pos === 'sticky') && el !== host) {
        hiddenFixed.push([el, el.style.visibility])
        el.style.visibility = 'hidden'
      }
    }
  }
  function restoreFixed() {
    for (const [el, v] of hiddenFixed) el.style.visibility = v
    hiddenFixed = []
  }

  // ---------- messages from the background ----------

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'stash:last-target':
        describe(lastTarget).then(reply, () => reply(null))
        return true
      case 'stash:toast':
        toast(msg.state, msg.text)
        break
      case 'stash:select-area':
        selectArea().then(reply)
        return true
      case 'stash:page-metrics':
        host.style.display = 'none'
        reply({
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          vh: innerHeight,
          vw: innerWidth,
          y: scrollY
        })
        break
      case 'stash:page-scroll':
        ;(async () => {
          scrollTo(0, msg.y)
          // From the second frame on, fixed headers would repeat in every strip.
          if (msg.hideFixed && !hiddenFixed.length) hideFixed()
          await frames()
          await sleep(150)
          reply(scrollY)
        })()
        return true
      case 'stash:page-restore':
        restoreFixed()
        scrollTo(0, msg.y)
        host.style.display = ''
        break
      case 'stash:batch-open':
        globalThis.__stash.openBatch?.()
        break
    }
  })

  globalThis.__stash = { root, host, describe, findMedia, bestFromSrcset, bgUrl, titleFor, sourcePage, toast, send, prefs, sleep, busy: false }
})()
