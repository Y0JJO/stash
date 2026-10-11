import { BrowserWindow, desktopCapturer, screen } from 'electron'

/** Overlay page: shows the frozen screen, lets the user drag a rectangle, resolves with it (CSS px) or null. */
const OVERLAY_HTML = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:#000}
  #img{position:fixed;inset:0;width:100%;height:100%}
  #shade{position:fixed;inset:0;background:rgba(0,0,0,.45)}
  #sel{position:fixed;display:none;outline:1px solid #6b7cff;box-shadow:0 0 0 9999px rgba(0,0,0,.45);background:transparent}
  #size{position:fixed;display:none;font:12px system-ui;color:#fff;background:rgba(20,21,24,.9);padding:3px 7px;border-radius:5px}
  #hint{position:fixed;top:18px;left:50%;transform:translateX(-50%);font:13px system-ui;color:#fff;background:rgba(20,21,24,.85);
    padding:7px 14px;border-radius:8px}
</style>
<img id="img"><div id="shade"></div><div id="sel"></div><div id="size"></div>
<div id="hint">Выделите область · Esc — отмена</div>`

function selectArea(): string {
  return `new Promise((resolve) => {
    const sel = document.getElementById('sel'), size = document.getElementById('size'), shade = document.getElementById('shade')
    let start = null, rect = null
    const draw = (x, y) => {
      rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) }
      Object.assign(sel.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' })
      Object.assign(size.style, { display: 'block', left: rect.x + 'px', top: Math.max(0, rect.y - 26) + 'px' })
      size.textContent = Math.round(rect.w * devicePixelRatio) + ' × ' + Math.round(rect.h * devicePixelRatio)
    }
    addEventListener('mousedown', (e) => { if (e.button !== 0) return resolve(null); start = { x: e.clientX, y: e.clientY }; shade.style.display = 'none'; document.getElementById('hint').remove() })
    addEventListener('mousemove', (e) => start && draw(e.clientX, e.clientY))
    addEventListener('mouseup', () => resolve(rect && rect.w > 4 && rect.h > 4 ? rect : null))
    addEventListener('keydown', (e) => e.key === 'Escape' && resolve(null))
    addEventListener('contextmenu', () => resolve(null))
  })`
}

/** Freezes the display under the cursor and lets the user cut out a region. Returns PNG bytes or null. */
export async function captureArea(): Promise<Buffer | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sf = display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) }
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null
  const shot = source.thumbnail

  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  try {
    await overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)
    await overlay.webContents.executeJavaScript(
      `new Promise((r) => { const i = document.getElementById('img'); i.onload = r; i.src = ${JSON.stringify(shot.toDataURL())} })`
    )
    overlay.show()
    overlay.focus()
    const rect = (await overlay.webContents.executeJavaScript(selectArea())) as { x: number; y: number; w: number; h: number } | null
    if (!rect) return null
    // The overlay is laid out in DIPs; the captured bitmap is in physical pixels.
    const scaleX = shot.getSize().width / display.bounds.width
    const scaleY = shot.getSize().height / display.bounds.height
    return shot
      .crop({
        x: Math.round(rect.x * scaleX),
        y: Math.round(rect.y * scaleY),
        width: Math.round(rect.w * scaleX),
        height: Math.round(rect.h * scaleY)
      })
      .toPNG()
  } finally {
    if (!overlay.isDestroyed()) overlay.destroy()
  }
}
