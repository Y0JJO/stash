// Stash Clipper — drag & drop panel: start dragging any image on a page and drop it onto a Stash folder.
;(() => {
  const S = globalThis.__stash
  if (!S || S.dragReady) return
  S.dragReady = true

  const style = document.createElement('style')
  style.textContent = `
    .drag-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 280px; display: none; flex-direction: column;
      pointer-events: auto; background: rgba(20, 21, 25, 0.94); border-left: 1px solid var(--line);
      box-shadow: -12px 0 40px rgba(0,0,0,.35); backdrop-filter: blur(10px); color: var(--text); font-size: 13px;
      animation: slide .15s ease-out;
    }
    @keyframes slide { from { transform: translateX(30px); opacity: 0 } }
    .drag-head { display: flex; align-items: center; gap: 8px; padding: 16px; font-weight: 700; font-size: 14px; }
    .drag-zone {
      margin: 0 12px 10px; height: 120px; border: 2px dashed rgba(255,255,255,.25); border-radius: 12px;
      display: flex; align-items: center; justify-content: center; text-align: center; color: var(--muted); padding: 10px;
    }
    .drag-list { flex: 1; overflow-y: auto; padding: 0 8px 16px; }
    .drag-label { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 8px 8px 4px; }
    .drag-row { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 8px; border: 1px solid transparent; }
    .drag-row .ic { color: var(--muted); }
    .drag-zone.over, .drag-row.over { border-color: var(--accent); background: rgba(107,124,255,.18); color: #fff; }
  `
  S.root.appendChild(style)

  const panel = document.createElement('div')
  panel.className = 'drag-panel'
  S.root.appendChild(panel)

  let dragged = null
  let folders = []

  async function loadFolders() {
    const r = await S.send({ type: 'stash:folders' }).catch(() => null)
    folders = r?.folders ?? null
  }

  const byId = () => new Map((folders ?? []).map((f) => [f.id, f]))
  function pathOf(f, map, depth = 0) {
    const p = f.parentId && map.get(f.parentId)
    return p && depth < 32 ? `${pathOf(p, map, depth + 1)} / ${f.name}` : f.name
  }

  function render() {
    const map = byId()
    const rows = (folders ?? [])
      .map((f) => ({ id: f.id, label: pathOf(f, map) }))
      .sort((a, b) => a.label.localeCompare(b.label))
    panel.innerHTML = `
      <div class="drag-head"><i class="logo"></i>Stash</div>
      <div class="drag-zone" data-folder="">Отпустите здесь,<br>чтобы сохранить без папки</div>
      ${rows.length ? '<div class="drag-label">Или в папку</div>' : ''}
      <div class="drag-list">${rows.map((r) => `<div class="drag-row" data-folder="${r.id}"><span class="ic">▣</span><span></span></div>`).join('')}</div>`
    // Folder names go in as text, never as HTML.
    panel.querySelectorAll('.drag-row').forEach((row, i) => (row.lastElementChild.textContent = rows[i].label))
  }

  const isOurs = (e) => e.composedPath().includes(S.host)

  document.addEventListener(
    'dragstart',
    async (e) => {
      if (!S.prefs.dragPanel || isOurs(e)) return
      const t = e.target
      const el = t?.tagName === 'IMG' || t?.tagName === 'VIDEO' ? t : t?.querySelector?.('img') ?? S.findMedia(e.clientX, e.clientY)
      if (!el) return
      dragged = el
      await loadFolders()
      if (folders === null || !dragged) return // Stash isn't running — don't get in the way
      render()
      panel.style.display = 'flex'
    },
    true
  )

  const hide = () => {
    panel.style.display = 'none'
    dragged = null
  }
  document.addEventListener('dragend', hide, true)

  panel.addEventListener('dragover', (e) => {
    const target = e.composedPath().find((n) => n.dataset && 'folder' in n.dataset)
    panel.querySelectorAll('.over').forEach((n) => n !== target && n.classList.remove('over'))
    if (!target) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    target.classList.add('over')
  })
  panel.addEventListener('drop', async (e) => {
    const target = e.composedPath().find((n) => n.dataset && 'folder' in n.dataset)
    if (!target || !dragged) return
    e.preventDefault()
    e.stopPropagation()
    const el = dragged
    hide()
    const media = await S.describe(el).catch(() => null)
    if (!media) return S.toast('error', 'Не удалось найти файл')
    S.send({ type: 'stash:save', media: { ...media, folderId: target.dataset.folder || null } })
  })
})()
