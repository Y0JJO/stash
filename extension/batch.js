// Stash Clipper — batch save: collect every image on the page, filter by size/format/domain, save the selection.
// "Auto-collect" keeps gathering while you scroll (infinite feeds like Pinterest boards), optionally auto-scrolling.
;(() => {
  const S = globalThis.__stash
  if (!S || S.openBatch) return

  const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?:[?#]|$)/i
  const SIZES = [
    { key: 'all', label: 'Все', min: 0 },
    { key: 'm', label: 'От 300 px', min: 300 },
    { key: 'l', label: 'От 800 px', min: 800 },
    { key: 'xl', label: 'От 1500 px', min: 1500 }
  ]

  const style = document.createElement('style')
  style.textContent = `
    .batch { position: fixed; inset: 3vh 3vw; display: flex; pointer-events: auto; color: var(--text); font-size: 13px;
      background: #16171b; border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
      box-shadow: 0 30px 90px rgba(0,0,0,.6); }
    .batch-shade { position: fixed; inset: 0; background: rgba(0,0,0,.5); pointer-events: auto; }
    .b-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .b-top { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .b-top .title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; margin-right: auto; }
    .b-grid { flex: 1; overflow-y: auto; padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 14px; align-content: start; }
    .card { cursor: pointer; text-align: center; }
    .card .im { height: 150px; border-radius: 8px; background: #111; display: flex; align-items: center; justify-content: center;
      overflow: hidden; outline: 2px solid transparent; outline-offset: 2px; position: relative; }
    .card .im img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .card.on .im { outline-color: var(--accent); }
    .card .tick { position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.7); background: rgba(0,0,0,.35); }
    .card.on .tick { background: var(--accent); border-color: var(--accent); }
    .card.on .tick::after { content: '✓'; color: #fff; font-size: 11px; line-height: 14px; display: block; }
    .card .meta { margin-top: 6px; color: var(--muted); font: 11px ui-monospace, Consolas, monospace; }
    .b-side { width: 270px; border-left: 1px solid var(--line); display: flex; flex-direction: column; background: rgba(30,31,36,.98); }
    .b-scroll { flex: 1; overflow-y: auto; padding: 12px; }
    .b-label { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 6px; }
    .b-opt { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
    .b-opt:hover { background: rgba(255,255,255,.05); }
    .b-opt.on { background: rgba(107,124,255,.16); color: #fff; }
    .b-opt .n { margin-left: auto; color: var(--muted); font-size: 12px; }
    .b-opt .chk { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(255,255,255,.35); flex: none; }
    .b-opt.on .chk { background: var(--accent); border-color: var(--accent); }
    input, select { width: 100%; font: inherit; color: inherit; background: #141518; border: 1px solid var(--line);
      border-radius: 6px; padding: 6px 8px; outline: none; }
    input:focus, select:focus { border-color: var(--accent); }
    .btn { font: inherit; font-weight: 600; color: var(--text); background: rgba(255,255,255,.06); border: 1px solid var(--line);
      border-radius: 7px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: rgba(255,255,255,.12); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:disabled { opacity: .5; cursor: default; }
    .b-foot { padding: 12px; border-top: 1px solid var(--line); }
    .b-foot .btn { width: 100%; padding: 9px; }
    .empty { grid-column: 1 / -1; color: var(--muted); text-align: center; padding: 60px 0; }
    .pill { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 8px; pointer-events: auto;
      background: rgba(24,25,30,.96); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px 8px 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,.4); color: var(--text); font-size: 13px; }
    .pill b { font-variant-numeric: tabular-nums; }
  `
  S.root.appendChild(style)

  /** url → { url, thumb, w, h, ext, domain, title, el } */
  const found = new Map()
  const state = { open: false, size: 'm', exts: new Set(), domains: new Set(), q: '', selected: new Set(), folderId: null, tags: '', auto: false, scrolling: false }
  let shade = null
  let panel = null
  let pill = null

  // ---------- collecting ----------

  function add(url, thumb, w, h, title, el) {
    if (!url || !/^https?:/.test(url) || found.has(url)) return
    let ext = (IMG_EXT.exec(new URL(url).pathname) || [])[1]?.toLowerCase() || 'другое'
    if (ext === 'jpeg') ext = 'jpg'
    found.set(url, { url, thumb: thumb || url, w, h, ext, domain: new URL(url).hostname, title, el })
    if (!w) measure(url)
  }

  /** Background images and plain links have unknown size until loaded. */
  function measure(url) {
    const img = new Image()
    img.onload = () => {
      const it = found.get(url)
      if (it) {
        it.w = img.naturalWidth
        it.h = img.naturalHeight
        scheduleRender()
      }
    }
    img.src = url
  }

  function collect() {
    for (const img of document.images) {
      if (img.naturalWidth < 2 || S.host.contains(img)) continue
      const url = S.bestFromSrcset(img) || img.currentSrc || img.src
      add(url, img.currentSrc || img.src, img.naturalWidth, img.naturalHeight, S.titleFor(img), img)
    }
    for (const a of document.querySelectorAll('a[href]')) if (IMG_EXT.test(a.href)) add(a.href, a.href, 0, 0, a.textContent.trim() || document.title, a)
    for (const el of document.querySelectorAll('[style*="background"]')) {
      const url = S.bgUrl(el)
      if (url && el.clientWidth >= 60) add(url, url, 0, 0, S.titleFor(el), el)
    }
    for (const v of document.querySelectorAll('video[poster]')) add(new URL(v.poster, location.href).href, null, 0, 0, S.titleFor(v), v)
  }

  // ---------- filtering ----------

  const minSize = () => SIZES.find((s) => s.key === state.size).min
  function visible() {
    const q = state.q.trim().toLowerCase()
    return [...found.values()].filter(
      (it) =>
        Math.max(it.w, it.h) >= minSize() &&
        (it.w > 0 || minSize() === 0) &&
        (!state.exts.size || state.exts.has(it.ext)) &&
        (!state.domains.size || state.domains.has(it.domain)) &&
        (!q || it.url.toLowerCase().includes(q) || (it.title || '').toLowerCase().includes(q))
    )
  }
  const countBy = (list, key) => {
    const m = new Map()
    for (const it of list) m.set(it[key], (m.get(it[key]) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }

  // ---------- rendering ----------

  let renderQueued = false
  function scheduleRender() {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      if (state.open) render()
      else if (pill) renderPill()
    })
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

  function render() {
    const list = visible()
    const bySize = [...found.values()]
    // Drop selections that are filtered out so the button count matches what you see.
    const ids = new Set(list.map((i) => i.url))
    for (const u of state.selected) if (!ids.has(u)) state.selected.delete(u)
    const sizedForCounts = bySize.filter((it) => Math.max(it.w, it.h) >= minSize())

    panel.innerHTML = `
      <div class="b-main">
        <div class="b-top">
          <div class="title"><i class="logo"></i>Пакетное сохранение · ${list.length}</div>
          <button class="btn" data-act="all">Выбрать все</button>
          <button class="btn" data-act="none">Снять</button>
          <button class="btn" data-act="auto" title="Свернуть и собирать картинки, пока вы листаете страницу">⟳ Автосбор при прокрутке</button>
          <button class="btn" data-act="close">✕</button>
        </div>
        <div class="b-grid">
          ${list.length ? list.map((it) => `
            <div class="card${state.selected.has(it.url) ? ' on' : ''}" data-url="${esc(it.url)}">
              <div class="im"><img src="${esc(it.thumb)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"><span class="tick"></span></div>
              <div class="meta">${it.w ? `${it.w}×${it.h}` : '…'} · ${esc(it.ext)}</div>
            </div>`).join('') : '<div class="empty">Картинок под эти фильтры нет</div>'}
        </div>
      </div>
      <div class="b-side">
        <div class="b-scroll">
          <input data-in="q" placeholder="Поиск по имени или адресу" value="${esc(state.q)}">
          <div class="b-label">Размер</div>
          ${SIZES.map((s) => `<div class="b-opt${state.size === s.key ? ' on' : ''}" data-size="${s.key}">${s.label}
            <span class="n">${bySize.filter((it) => Math.max(it.w, it.h) >= s.min && (it.w > 0 || s.min === 0)).length}</span></div>`).join('')}
          <div class="b-label">Формат</div>
          ${countBy(sizedForCounts, 'ext').map(([k, n]) => `<div class="b-opt${state.exts.has(k) ? ' on' : ''}" data-ext="${esc(k)}"><span class="chk"></span>${esc(k)}<span class="n">${n}</span></div>`).join('')}
          <div class="b-label">Домен</div>
          ${countBy(sizedForCounts, 'domain').map(([k, n]) => `<div class="b-opt${state.domains.has(k) ? ' on' : ''}" data-domain="${esc(k)}"><span class="chk"></span>${esc(k)}<span class="n">${n}</span></div>`).join('')}
          <div class="b-label">Папка</div>
          <select data-in="folder"><option value="">Без папки</option></select>
          <div class="b-label">Теги (через запятую)</div>
          <input data-in="tags" placeholder="например: референсы, свет" value="${esc(state.tags)}">
        </div>
        <div class="b-foot"><button class="btn primary" data-act="save" ${state.selected.size ? '' : 'disabled'}>Сохранить (${state.selected.size})</button></div>
      </div>`
    fillFolders(panel.querySelector('[data-in="folder"]'))
  }

  let folderCache = null
  async function fillFolders(select) {
    folderCache ??= (await S.send({ type: 'stash:folders' }).catch(() => null))?.folders ?? []
    const map = new Map(folderCache.map((f) => [f.id, f]))
    const pathOf = (f, d = 0) => (f.parentId && map.get(f.parentId) && d < 32 ? `${pathOf(map.get(f.parentId), d + 1)} / ${f.name}` : f.name)
    folderCache
      .map((f) => [f.id, pathOf(f)])
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([id, label]) => select.add(new Option(label, id)))
    select.value = state.folderId ?? ''
  }

  function renderPill() {
    pill.innerHTML = `<i class="logo"></i>Автосбор: <b>${found.size}</b>
      <button class="btn" data-act="scroll">${state.scrolling ? '■ Стоп' : '▶ Листать'}</button>
      <button class="btn primary" data-act="reopen">Открыть</button>`
  }

  // ---------- interaction ----------

  function onClick(e) {
    const path = e.composedPath()
    const hit = (attr) => path.find((n) => n.dataset && attr in n.dataset)
    const act = hit('act')?.dataset.act
    if (act === 'close') return close()
    if (act === 'all') visible().forEach((it) => state.selected.add(it.url))
    if (act === 'none') state.selected.clear()
    if (act === 'auto') return startAuto()
    if (act === 'save') return save()
    const card = hit('url')
    if (card) {
      const u = card.dataset.url
      state.selected.has(u) ? state.selected.delete(u) : state.selected.add(u)
      card.classList.toggle('on')
      panel.querySelector('[data-act="save"]').textContent = `Сохранить (${state.selected.size})`
      panel.querySelector('[data-act="save"]').disabled = !state.selected.size
      return
    }
    const size = hit('size')
    if (size) state.size = size.dataset.size
    const ext = hit('ext')
    if (ext) toggle(state.exts, ext.dataset.ext)
    const dom = hit('domain')
    if (dom) toggle(state.domains, dom.dataset.domain)
    if (act || size || ext || dom) render()
  }
  const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v))

  function onInput(e) {
    const el = e.composedPath()[0]
    const k = el.dataset?.in
    if (k === 'q') {
      state.q = el.value
      render()
      const input = panel.querySelector('[data-in="q"]')
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    if (k === 'tags') state.tags = el.value
    if (k === 'folder') state.folderId = el.value || null
  }

  async function save() {
    const items = visible().filter((it) => state.selected.has(it.url))
    const tags = state.tags.split(',').map((t) => t.trim()).filter(Boolean)
    const media = items.map((it) => ({
      kind: 'image',
      urls: [it.url, it.thumb],
      title: it.title,
      pageUrl: it.el ? S.sourcePage(it.el) : location.href,
      tags,
      folderId: state.folderId
    }))
    close()
    S.send({ type: 'stash:batch-save', media })
  }

  // ---------- open / close / auto-collect ----------

  function open() {
    if (state.open) return
    stopAuto()
    collect()
    state.open = true
    S.busy = true
    shade = document.createElement('div')
    shade.className = 'batch-shade'
    shade.addEventListener('click', close)
    panel = document.createElement('div')
    panel.className = 'batch'
    panel.addEventListener('click', onClick)
    panel.addEventListener('input', onInput)
    panel.addEventListener('change', onInput)
    S.root.append(shade, panel)
    addEventListener('keydown', onKey, true)
    render()
  }

  function close() {
    state.open = false
    S.busy = false
    shade?.remove()
    panel?.remove()
    removeEventListener('keydown', onKey, true)
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }

  let observer = null
  let scrollTimer = 0
  const onScroll = () => {
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      collect()
      scheduleRender()
    }, 300)
  }

  function startAuto() {
    close()
    state.auto = true
    pill = document.createElement('div')
    pill.className = 'pill'
    pill.addEventListener('click', (e) => {
      const act = e.composedPath().find((n) => n.dataset?.act)?.dataset.act
      if (act === 'reopen') open()
      if (act === 'scroll') {
        state.scrolling ? (state.scrolling = false) : autoScroll()
        renderPill()
      }
    })
    S.root.appendChild(pill)
    renderPill()
    addEventListener('scroll', onScroll, { passive: true, capture: true })
    observer = new MutationObserver(onScroll)
    observer.observe(document.body, { childList: true, subtree: true })
  }

  function stopAuto() {
    state.auto = false
    state.scrolling = false
    pill?.remove()
    pill = null
    observer?.disconnect()
    removeEventListener('scroll', onScroll, { capture: true })
  }

  /** Scrolls down a screen at a time until the page stops growing (3 tries) or you press Stop. */
  async function autoScroll() {
    state.scrolling = true
    let still = 0
    while (state.scrolling && still < 3) {
      const before = document.documentElement.scrollHeight
      scrollBy(0, innerHeight * 0.9)
      await S.sleep(1200)
      collect()
      scheduleRender()
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4
      still = atBottom && document.documentElement.scrollHeight === before ? still + 1 : 0
    }
    state.scrolling = false
    if (pill) renderPill()
  }

  S.openBatch = open
})()
