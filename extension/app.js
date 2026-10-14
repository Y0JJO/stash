// Finds the running D3S3RT app. It listens on the first free port from 41597 up (another program,
// e.g. Eagle, may hold 41597), so every port is pinged and only an answer from D3S3RT itself counts.
// Shared by the service worker (importScripts) and the popup (<script>).

const APP_PORTS = Array.from({ length: 10 }, (_, i) => 41597 + i)
let appBase = null

async function pingPort(port) {
  const base = `http://127.0.0.1:${port}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`${base}/api/ping`, { signal: ctrl.signal })
    const body = res.ok ? await res.json().catch(() => null) : null
    return body?.app === 'stash' ? { base, ping: body } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves with { base, ping } of the running app; throws a TypeError ("not running") when there is none. */
async function findApp() {
  if (appBase) {
    const hit = await pingPort(Number(new URL(appBase).port))
    if (hit) return hit
    appBase = null
  }
  const hits = await Promise.all(APP_PORTS.map(pingPort))
  const hit = hits.find(Boolean)
  if (!hit) throw new TypeError('D3S3RT не запущен')
  appBase = hit.base
  return hit
}

/** fetch() against the app; finds it again once if the remembered port stopped answering. */
async function appFetch(path, init) {
  if (!appBase) await findApp()
  try {
    return await fetch(appBase + path, init)
  } catch {
    appBase = null
    await findApp()
    return fetch(appBase + path, init)
  }
}
