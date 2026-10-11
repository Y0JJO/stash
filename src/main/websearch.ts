import { BrowserWindow } from 'electron'
import sharp from 'sharp'

export type SearchEngine = 'google' | 'yandex' | 'bing' | 'tineye' | 'saucenao'

/** Upload endpoints: each takes the image as a multipart file field. */
const ENGINES: Record<SearchEngine, { title: string; action: string; field: string; base64?: boolean }> = {
  google: { title: 'Google Lens', action: 'https://lens.google.com/v3/upload', field: 'encoded_image' },
  yandex: { title: 'Яндекс Картинки', action: 'https://yandex.ru/images/search?rpt=imageview', field: 'upfile' },
  bing: { title: 'Bing', action: 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload', field: 'imageBin', base64: true },
  tineye: { title: 'TinEye', action: 'https://tineye.com/search', field: 'image' },
  saucenao: { title: 'SauceNAO', action: 'https://saucenao.com/search.php', field: 'file' }
}

export const ENGINE_LABELS = Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.title])) as Record<SearchEngine, string>

/**
 * Opens a window that uploads the image to a reverse-image-search engine.
 * The upload is a regular form POST from a local page, exactly like using the site's own "upload" button.
 */
export async function reverseSearch(file: string, engine: SearchEngine): Promise<void> {
  const e = ENGINES[engine]
  const jpeg = await sharp(file, { animated: false, limitInputPixels: false })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer()

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: e.title,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { partition: 'persist:websearch', sandbox: true, contextIsolation: true }
  })
  const html = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;color:#666;display:grid;place-items:center;height:90vh">
    Отправка в ${e.title}…<form id="f" method="POST" enctype="multipart/form-data" action="${e.action}"></form></body>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await win.webContents.executeJavaScript(`(() => {
    const b64 = ${JSON.stringify(jpeg.toString('base64'))}
    const form = document.getElementById('f')
    if (${!!e.base64}) {
      const t = document.createElement('input'); t.type = 'hidden'; t.name = ${JSON.stringify(e.field)}; t.value = b64; form.appendChild(t)
    } else {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const input = document.createElement('input'); input.type = 'file'; input.name = ${JSON.stringify(e.field)}
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'image.jpg', { type: 'image/jpeg' }))
      input.files = dt.files; form.appendChild(input)
    }
    form.submit()
  })()`)
}
