const $ = (id) => document.getElementById(id)

async function init() {
  const s = await chrome.storage.local.get({ folderId: null, hoverButton: true, dragPanel: true })
  for (const key of ['hoverButton', 'dragPanel']) {
    $(key).checked = s[key]
    $(key).onchange = (e) => chrome.storage.local.set({ [key]: e.target.checked })
  }

  let online = false
  try {
    const { ping } = await findApp()
    online = !!ping.library
    $('status').textContent = ping.library ? `Библиотека: ${ping.library}` : 'D3S3RT запущен, но библиотека не открыта'
    if (online) {
      $('dot').classList.add('on')
      const { folders } = await (await appFetch('/api/folders')).json()
      const byId = new Map(folders.map((f) => [f.id, f]))
      const pathOf = (f, depth = 0) => {
        const p = f.parentId && byId.get(f.parentId)
        return p && depth < 32 ? `${pathOf(p, depth + 1)} / ${f.name}` : f.name
      }
      folders
        .map((f) => ({ id: f.id, label: pathOf(f) }))
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach((f) => $('folder').add(new Option(f.label, f.id)))
      $('folder').value = byId.has(s.folderId) ? s.folderId : ''
    }
  } catch {
    $('status').textContent = 'D3S3RT не запущен'
  }
  $('folder').onchange = (e) => chrome.storage.local.set({ folderId: e.target.value || null })
  document.querySelectorAll('[data-action]').forEach((b) => (b.disabled = !online))
}

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) await chrome.runtime.sendMessage({ type: 'stash:action', action: btn.dataset.action, tabId: tab.id })
    window.close()
  }
})

init()
