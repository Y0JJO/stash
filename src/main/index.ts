import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, protocol, shell, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { Library } from './library'
import { Importer } from './importer'
import { ThumbQueue } from './thumbs'
import { loadConfig, saveConfig } from './config'
import { AutoTagger, Clip } from './ai'
import { handleClip, startClipperServer, type ClipperDeps } from './clipper'
import { pinCandidates, pinterestSearch, type PinResult } from './pinterest'
import { fmtTime, grabFrame, makeStoryboard, type StoryboardOptions } from './storyboard'
import { videoFps } from './media'
import { Conversion, trimVideo, type TrimMode } from './convert'
import { SettingsManager } from './settings'
import { Updater } from './updater'
import { browserExtInfo, extensionDir, openExtensionsPage, syncExtension } from './browserExt'
import type { Settings } from '../shared/settings'
import { PluginHost } from './pluginHost'
import { boardSvg, renderBoardPng } from './boards'
import { copyFolderToLibrary, exportFolderToDir, exportFolderToZip } from './folderOps'
import { boundsOf, masonry } from '../shared/boardLayout'
import { captureArea } from './capture'
import { reverseSearch, type SearchEngine } from './websearch'
import { installTools, TelegramBot, type TelegramConfig } from './telegram'
import type { AiStatus, BoardData, ConvertOptions, FolderPatch, ItemPatch, MenuEntry, Query } from '../shared/types'

protocol.registerSchemesAsPrivileged([
  { scheme: 'stash', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

// Dev hook: STASH_USER_DATA isolates config (recent libraries, window bounds) for test runs.
// Otherwise keep the folder from before the rename to D3S3RT, so existing installs keep their libraries and settings.
app.setPath('userData', process.env.STASH_USER_DATA || path.join(app.getPath('appData'), 'Stash'))

const config = loadConfig()
// Must be decided before the app is ready.
if (config.settings?.gpu === false) app.disableHardwareAcceleration()
let win: BrowserWindow | null = null
let lib: Library | null = null
let importer: Importer | null = null
let thumbs: ThumbQueue | null = null
let tagger: AutoTagger | null = null
let dragIcon: NativeImage | null = null
let plugins: PluginHost | null = null
let updater: Updater | null = null
/** When the browser extension last talked to Stash (this run). */
let extensionSeenAt: number | null = null
let telegram: TelegramBot | null = null
let settings: SettingsManager | null = null
/** What the user has selected in the grid — plugins can ask for it. */
let uiState: { ids: string[]; folderId: string | null } = { ids: [], folderId: null }
let aiStatus: AiStatus = { phase: 'idle' }

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function setAiStatus(s: AiStatus): void {
  aiStatus = s
  send('ai:status', s)
}

// The model is shared by all libraries; it lives outside userData so test profiles reuse the download.
const clip = new Clip(path.join(app.getPath('appData'), 'Stash', 'models'), (progress) => setAiStatus({ phase: 'loading', progress }))

let changedTimer: NodeJS.Timeout | null = null
/** Tells the renderer to re-query; coalesces bursts of changes. */
function notifyChanged(): void {
  changedTimer ??= setTimeout(() => {
    changedTimer = null
    send('lib:changed')
  }, 120)
}

function closeLibrary(): void {
  importer?.cancel()
  thumbs?.stop()
  tagger?.stop()
  lib?.close()
  lib = importer = thumbs = tagger = null
}

function openLibrary(dir: string): Library {
  closeLibrary()
  const l = (lib = new Library(dir))
  const t = (tagger = new AutoTagger(l, clip, { onStatus: setAiStatus, onTagged: () => notifyChanged() }, config.autoTag))
  thumbs = new ThumbQueue(l, (batch) => {
    send('thumbs:ready', batch)
    // Tagging works from the thumbnail, so it starts once the thumbnail exists.
    t.enqueue(batch.filter((b) => b.thumb === 1).map((b) => b.id))
  })
  importer = new Importer(l, {
    onProgress: (p) => {
      send('import:progress', p)
      notifyChanged()
    },
    onAdded: (ids) => {
      thumbs?.enqueue(ids)
      notifyChanged()
      send('import:added', ids)
    }
  })
  thumbs.enqueueMissing()
  t.enqueuePending()
  config.lastLibrary = dir
  config.recent = [dir, ...config.recent.filter((r) => r !== dir)].slice(0, 8)
  saveConfig(config)
  send('lib:switched', l.info)
  plugins?.broadcast('library', { name: l.info.name, path: l.root })
  return l
}

/** Imports for the extension, plugins and Pinterest saves. Unknown folder ids fall back to "no folder". */
const clipDeps: ClipperDeps = {
  libraryName: () => lib?.info.name ?? null,
  folders: () => lib?.folders() ?? [],
  importFile: (file, folderId, meta) => {
    if (!lib || !importer) throw new Error('В D3S3RT не открыта библиотека')
    const l = lib
    const target = folderId && l.folders().some((f) => f.id === folderId) ? folderId : null
    return importer.importFile(file, target, meta)
  }
}

function need(): Library {
  if (!lib) throw new Error('Библиотека не открыта')
  return lib
}

// ---------- stash:// protocol ----------

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska'
}

async function serve(req: Request): Promise<Response> {
  if (!lib) return new Response('No library', { status: 404 })
  const url = new URL(req.url)
  const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const file = url.hostname === 'thumb' ? lib.thumbPath(id) : lib.filePath(id)
  if (!file) return new Response('Not found', { status: 404 })

  let size: number
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
  const body = (start: number, end: number) => Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream

  // Range support is what makes <video> seeking work.
  const range = req.headers.get('range')
  const m = range && /bytes=(\d*)-(\d*)/.exec(range)
  if (m) {
    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Number(m[2]) : size - 1
    if (!m[1] && m[2]) {
      start = size - Number(m[2])
      end = size - 1
    }
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    return new Response(body(start, end), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }
  return new Response(body(0, size - 1), {
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}

// ---------- IPC ----------

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

function registerIpc(): void {
  handle('lib:current', () => lib?.info ?? null)
  handle('lib:recent', () => config.recent.filter((p) => Library.isLibrary(p)))
  handle('lib:open', (dir: string) => (Library.isLibrary(dir) ? openLibrary(dir).info : null))
  handle('lib:openDialog', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Открыть библиотеку', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    if (!Library.isLibrary(r.filePaths[0])) {
      await dialog.showMessageBox(win!, { type: 'warning', message: 'Эта папка не является библиотекой D3S3RT.' })
      return null
    }
    return openLibrary(r.filePaths[0]).info
  })
  handle('lib:create', async () => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Создать библиотеку',
      defaultPath: path.join(app.getPath('documents'), 'Моя библиотека.stash'),
      buttonLabel: 'Создать',
      properties: ['createDirectory']
    })
    if (r.canceled || !r.filePath) return null
    let dir = r.filePath
    if (!/\.stash$/i.test(dir)) dir += '.stash'
    if (fs.existsSync(dir) && !Library.isLibrary(dir) && fs.readdirSync(dir).length) {
      await dialog.showMessageBox(win!, { type: 'warning', message: 'Папка уже существует и не пуста.' })
      return null
    }
    return openLibrary(dir).info
  })
  handle('lib:reveal', () => lib && shell.openPath(lib.root))

  handle('plugins:list', () => plugins?.list() ?? [])
  handle('plugins:run', (id: string) => plugins?.run(id))
  handle('plugins:uninstall', (id: string) => {
    plugins?.uninstall(id)
    send('plugins:changed')
  })
  handle('plugins:reveal', () => plugins?.revealPlugins())
  handle('plugins:formats', () => plugins?.formats() ?? [])
  handle('extensions:list', () => plugins?.extensions() ?? [])
  handle('extensions:setEnabled', (id: string, on: boolean) => {
    plugins?.setExtensionEnabled(id, on)
    if (on && lib) plugins?.startServices()
  })
  handle('extensions:uninstall', (id: string) => plugins?.uninstallExtension(id))
  handle('extensions:reveal', () => plugins?.revealExtensions())
  handle('plugins:setEnabled', (id: string, on: boolean) => {
    plugins?.setEnabled(id, on)
    send('plugins:changed')
  })
  handle('plugins:stop', (id: string) => plugins?.stop(id))
  handle('plugins:restart', (id: string) => plugins?.restart(id))
  handle('plugins:devtools', (id: string) => plugins?.devtools(id))
  handle('plugins:revealOne', (id: string) => plugins?.reveal(id))
  handle('plugins:installDialog', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Установить плагин',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Плагины и расширения', extensions: plugins?.formats() ?? [] }]
    })
    for (const f of r.canceled ? [] : r.filePaths) await installPlugin(f)
  })
  ipcMain.on('state:selection', (_e, ids: string[], folderId: string | null) => {
    uiState = { ids, folderId }
  })
  handle('pinterest:search', (id: string, bookmark: string | null) => {
    const l = need()
    // The thumbnail is enough for matching and also covers videos and formats sharp can't decode.
    const thumb = l.thumbPath(id)
    const file = thumb && fs.existsSync(thumb) ? thumb : l.filePath(id)
    if (!file) throw new Error('Файл не найден')
    return pinterestSearch(file, bookmark)
  })
  handle('pinterest:save', async (pin: PinResult, folderId: string | null) => {
    const r = await handleClip(
      { kind: 'image', urls: pinCandidates(pin), pageUrl: pin.pinUrl, title: pin.title || 'Pinterest', folderId },
      clipDeps
    )
    return r.id
  })
  handle('storyboard:make', async (id: string, opts: StoryboardOptions) => {
    const l = need()
    if (!importer) throw new Error('Библиотека не открыта')
    const r = await makeStoryboard(l, importer, id, opts, (done, total) => send('storyboard:progress', { done, total }))
    notifyChanged()
    return r
  })
  // ----- preferences -----
  handle('settings:get', () => settings!.get())
  handle('settings:set', (patch: Partial<Settings>) => {
    const r = settings!.set(patch)
    if ('autoUpdate' in patch) updater?.setAuto(r.settings.autoUpdate)
    return r
  })
  handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Папка для авто-импорта', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('lock:has', () => settings!.hasLock())
  handle('lock:check', (password: string) => settings!.checkLock(password))
  handle('lock:set', (password: string | null, current: string) => settings!.setLock(password, current))
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: app.getPath('userData'),
    library: lib?.root ?? null
  }))
  handle('update:state', () => updater?.get() ?? null)
  handle('update:check', () => updater?.check() ?? null)
  handle('update:install', () => updater?.install())
  handle('browserExt:info', () => ({ ...browserExtInfo(), seenAt: extensionSeenAt }))
  handle('browserExt:open', (id: string) => openExtensionsPage(id))
  handle('browserExt:reveal', () => shell.openPath(extensionDir()))
  handle('app:openUserData', () => shell.openPath(app.getPath('userData')))
  handle('app:devtools', () => win?.webContents.openDevTools({ mode: 'detach' }))
  handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })

  // ----- format converter -----
  let conversion: Conversion | null = null
  handle('convert:start', async (ids: string[], opts: ConvertOptions) => {
    const l = need()
    if (!importer) throw new Error('Библиотека не открыта')
    if (conversion) throw new Error('Конвертация уже идёт')
    let outDir: string | undefined
    if (opts.output === 'folder') {
      const r = await dialog.showOpenDialog(win!, { title: 'Куда сохранить результат', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      outDir = r.filePaths[0]
    }
    conversion = new Conversion()
    try {
      const res = await conversion.run(ids, opts, {
        lib: l,
        importer,
        outDir,
        enqueueThumbs: (list) => thumbs?.enqueue(list),
        onProgress: (p) => send('convert:progress', p)
      })
      notifyChanged()
      if (outDir && res.converted) shell.openPath(outDir)
      return res
    } finally {
      conversion = null
    }
  })
  handle('convert:cancel', () => conversion?.cancel())

  handle('video:info', async (id: string) => {
    const p = need().filePath(id)
    if (!p) throw new Error('Файл не найден')
    return { fps: await videoFps(p) }
  })
  handle('video:grabFrame', async (id: string, at: number, folderId: string | null, target: 'library' | 'clipboard' | 'file' = 'library') => {
    const l = need()
    const it = l.getItem(id)
    if (!it || !importer) throw new Error('Файл не найден')
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'stash-frame-'))
    try {
      const file = path.join(dir, 'frame.jpg')
      await grabFrame(it.path, at, file)
      if (target === 'clipboard') {
        const png = await sharp(file).png().toBuffer()
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
        return null
      }
      if (target === 'file') {
        const r = await dialog.showSaveDialog(win!, {
          title: 'Сохранить кадр',
          defaultPath: path.join(app.getPath('pictures'), `${it.name} — ${fmtTime(at).replace(':', '-')}.png`),
          filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }]
        })
        if (r.canceled || !r.filePath) return null
        if (/\.jpe?g$/i.test(r.filePath)) await fs.promises.copyFile(file, r.filePath)
        else await sharp(file).png().toFile(r.filePath)
        shell.showItemInFolder(r.filePath)
        return null
      }
      const r = await importer.importFile(file, folderId, { name: `${it.name} — кадр ${fmtTime(at)}`, url: it.url, tags: ['кадр'] })
      return r.id
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
  handle('video:trim', async (id: string, start: number, end: number, mode: TrimMode, target: 'library' | 'file' = 'library') => {
    const l = need()
    const it = l.getItem(id)
    if (!it || !importer) throw new Error('Файл не найден')
    const from = Math.max(0, start)
    if (!(end - from > 0.02)) throw new Error('Слишком короткий фрагмент')
    const ext = mode === 'gif' ? 'gif' : mode === 'fast' ? it.ext : 'mp4'
    const name = `${it.name} — фрагмент ${fmtTime(from)}–${fmtTime(end)}`
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'stash-trim-'))
    try {
      const file = path.join(dir, `clip.${ext}`)
      await trimVideo(it.path, file, from, end - from, mode)
      if (target === 'file') {
        const r = await dialog.showSaveDialog(win!, {
          title: 'Сохранить фрагмент',
          defaultPath: path.join(app.getPath('videos'), `${name.replace(/[<>:"/\\|?*]/g, '-')}.${ext}`),
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
        })
        if (r.canceled || !r.filePath) return null
        await fs.promises.copyFile(file, r.filePath)
        shell.showItemInFolder(r.filePath)
        return null
      }
      // The clip keeps the original's source link, tags and folders.
      const r = await importer.importFile(file, it.folderIds[0] ?? null, { name, url: it.url, tags: it.tags })
      if (it.folderIds.length > 1) l.setItemFolders(r.id, it.folderIds)
      return r.id
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
  // ----- moodboards -----
  /** Appends items to a board as a masonry block to the right of what's already there. */
  const addToBoard = (boardId: string, ids: string[], at?: { x: number; y: number }) => {
    const l = need()
    const board = l.getBoard(boardId)
    if (!board) throw new Error('Мудборд не найден')
    const existing = new Set(board.data.nodes.map((n) => n.itemId))
    const items = l.itemsLite(ids.filter((id) => !existing.has(id)))
    if (!items.length) return board.data
    const b = boundsOf(board.data.nodes)
    const origin = at ?? (b ? { x: b.x + b.w + 80, y: b.y } : { x: 0, y: 0 })
    const z = Math.max(0, ...board.data.nodes.map((n) => n.z)) + 1
    const data: BoardData = { ...board.data, nodes: [...board.data.nodes, ...masonry(items, origin, z)] }
    l.saveBoard(boardId, data)
    send('boards:changed', boardId)
    return data
  }
  /** Imports external files (or maps library files back to ids) and returns item ids in order. */
  const idsFromPaths = async (paths: string[]): Promise<string[]> => {
    const l = need()
    const out: string[] = []
    for (const p of paths) {
      const internal = l.idFromPath(p)
      if (internal) out.push(internal)
      else if (importer && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const r = await importer.importFile(p, null, {}).catch(() => null)
        if (r) out.push(r.id)
      }
    }
    return out
  }
  handle('boards:list', () => need().boards())
  handle('boards:get', (id: string) => need().getBoard(id))
  handle('boards:create', (name: string, ids: string[] = []) => {
    const l = need()
    const items = l.itemsLite(ids)
    const info = l.createBoard(name, { nodes: masonry(items, { x: 0, y: 0 }, 1), bg: '#1a1b1f' })
    notifyChanged()
    return info
  })
  handle('boards:save', (id: string, data: BoardData) => need().saveBoard(id, data))
  handle('boards:rename', (id: string, name: string) => {
    need().renameBoard(id, name)
    notifyChanged()
  })
  handle('boards:delete', (id: string) => {
    need().deleteBoard(id)
    notifyChanged()
  })
  handle('boards:addItems', (boardId: string, ids: string[], at?: { x: number; y: number }) => {
    const data = addToBoard(boardId, ids, at)
    notifyChanged()
    return data
  })
  handle('boards:addFromDialog', async (boardId: string, at?: { x: number; y: number }) => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Добавить на доску',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Изображения и видео', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'mp4', 'mov', 'webm', 'mkv'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths.length) return null
    const data = addToBoard(boardId, await idsFromPaths(r.filePaths), at)
    notifyChanged()
    return data
  })
  handle('boards:addPaths', async (boardId: string, paths: string[], at?: { x: number; y: number }) => {
    const data = addToBoard(boardId, await idsFromPaths(paths), at)
    notifyChanged()
    return data
  })
  /** Ctrl+V on a board: import whatever image/file is on the clipboard and return its id. */
  handle('boards:paste', async () => {
    if (!importer) return null
    const tmp = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'stash-paste-'))
    try {
      for (const item of await clipboard.read()) {
        const fileFormat = 'electron application/osclipboard;format="FileNameW"'
        if (item.types.includes(fileFormat)) {
          const p = Buffer.from(await ((await item.getType(fileFormat)) as Blob).arrayBuffer()).toString('utf16le').replace(/\0+$/, '')
          if (p && fs.existsSync(p)) return (await idsFromPaths([p]))[0] ?? null
        }
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) {
          const file = path.join(tmp, `Вставка ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')}.png`)
          await sharp(Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer())).png().toFile(file)
          return (await importer.importFile(file, null, {})).id
        }
      }
      return null
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true })
    }
  })
  handle('boards:duplicate', (id: string) => {
    const l = need()
    const board = l.getBoard(id)
    if (!board) throw new Error('Мудборд не найден')
    const info = l.createBoard(`${board.name} (копия)`, board.data)
    notifyChanged()
    return info
  })
  handle('boards:export', async (id: string, target: 'file' | 'library' | 'clipboard', only?: string[]) => {
    const l = need()
    const board = l.getBoard(id)
    if (!board) throw new Error('Мудборд не найден')
    const png = await renderBoardPng(l, board, 8000, only?.length ? new Set(only) : undefined)
    if (target === 'clipboard') {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
      return true
    }
    if (target === 'library') {
      const tmp = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'stash-board-'))
      try {
        const file = path.join(tmp, `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.png`)
        await fs.promises.writeFile(file, png)
        await importer?.importFile(file, null, { name: `Мудборд — ${board.name}`, tags: ['мудборд'] })
        return true
      } finally {
        await fs.promises.rm(tmp, { recursive: true, force: true })
      }
    }
    const r = await dialog.showSaveDialog(win!, {
      title: 'Экспорт мудборда',
      defaultPath: path.join(app.getPath('pictures'), `${board.name}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (r.canceled || !r.filePath) return false
    await fs.promises.writeFile(r.filePath, png)
    shell.showItemInFolder(r.filePath)
    return true
  })
  /** Figma: SVG with one <image> per asset — paste keeps every picture as its own layer. */
  handle('boards:svg', async (id: string, target: 'clipboard' | 'file') => {
    const l = need()
    const board = l.getBoard(id)
    if (!board) throw new Error('Мудборд не найден')
    const svg = await boardSvg(l, board)
    if (target === 'clipboard') {
      await clipboard.writeText(svg)
      return true
    }
    const r = await dialog.showSaveDialog(win!, {
      title: 'Сохранить SVG для Figma',
      defaultPath: path.join(app.getPath('documents'), `${board.name}.svg`),
      filters: [{ name: 'SVG', extensions: ['svg'] }]
    })
    if (r.canceled || !r.filePath) return false
    await fs.promises.writeFile(r.filePath, svg)
    shell.showItemInFolder(r.filePath)
    return true
  })
  /** Finds PureRef.exe (remembered path, common install dirs, or ask the user once). */
  const purerefExe = async (): Promise<string | null> => {
    const candidates = [
      config.purerefPath,
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PureRef', 'PureRef.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'PureRef', 'PureRef.exe'),
      path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'PureRef', 'PureRef.exe'),
      'D:/Programs/Portable/PureRef/PureRef.exe'
    ]
    const found = candidates.find((c): c is string => !!c && fs.existsSync(c))
    if (found) return found
    const r = await dialog.showOpenDialog(win!, {
      title: 'Где находится PureRef.exe?',
      properties: ['openFile'],
      filters: [{ name: 'PureRef', extensions: ['exe'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    config.purerefPath = r.filePaths[0]
    saveConfig(config)
    return r.filePaths[0]
  }
  /** Renders the board to a PNG and opens it in PureRef (layout preserved as one image). */
  handle('apps:pureref', async (boardId: string) => {
    const l = need()
    const board = l.getBoard(boardId)
    if (!board) throw new Error('Мудборд не найден')
    const exe = await purerefExe()
    if (!exe) return false
    const dir = path.join(app.getPath('userData'), 'pureref')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.png`)
    await fs.promises.writeFile(file, await renderBoardPng(l, board))
    spawn(exe, [file], { detached: true, stdio: 'ignore' }).unref()
    return true
  })
  handle('apps:open', (name: 'figma' | 'miro' | 'pureref') => {
    const urls = { figma: 'figma://', miro: 'https://miro.com/app/dashboard/', pureref: 'https://www.pureref.com/download.php' }
    const figmaExe = path.join(app.getPath('home'), 'AppData', 'Local', 'Figma', 'Figma.exe')
    if (name === 'figma' && fs.existsSync(figmaExe)) return shell.openPath(figmaExe)
    return shell.openExternal(urls[name])
  })

  handle('items:query', (q: Query) => need().query(q))
  handle('items:exts', () => need().exts())
  handle('items:hasVector', (id: string) => need().hasVector(id))
  handle('items:webSearch', async (id: string, engine: SearchEngine) => {
    const l = need()
    // Prefer the original; fall back to the thumbnail for formats sharp can't read.
    const file = l.filePath(id)
    const thumb = l.thumbPath(id)
    try {
      if (file) return await reverseSearch(file, engine)
    } catch {
      if (thumb && fs.existsSync(thumb)) return reverseSearch(thumb, engine)
      throw new Error('Не удалось прочитать изображение')
    }
  })
  handle('capture:area', (folderId: string | null) => screenshotToLibrary(folderId))
  handle('items:get', (id: string) => need().getItem(id))
  handle('items:update', (ids: string[], patch: ItemPatch) => {
    need().updateItems(ids, patch)
    notifyChanged()
  })
  handle('items:addTags', (ids: string[], tags: string[]) => {
    need().addTags(ids, tags)
    notifyChanged()
  })
  handle('items:removeTag', (ids: string[], tag: string) => {
    need().removeTag(ids, tag)
    notifyChanged()
  })
  handle('items:addToFolder', (ids: string[], folderId: string) => {
    need().addToFolder(ids, folderId)
    notifyChanged()
  })
  handle('items:removeFromFolder', (ids: string[], folderId: string) => {
    need().removeFromFolder(ids, folderId)
    notifyChanged()
  })
  handle('items:trash', (ids: string[]) => {
    need().trash(ids)
    notifyChanged()
  })
  handle('items:restore', (ids: string[]) => {
    need().restore(ids)
    notifyChanged()
  })
  handle('items:deleteForever', (ids: string[]) => {
    need().deleteForever(ids)
    notifyChanged()
  })
  handle('items:emptyTrash', () => {
    const l = need()
    l.deleteForever(l.trashedIds())
    notifyChanged()
  })
  handle('items:regenThumbs', (ids: string[]) => {
    need().resetThumbs(ids)
    thumbs?.enqueue(ids)
  })
  handle('items:retag', (ids: string[]) => {
    need().resetAutotags(ids)
    tagger?.enqueue(ids)
  })
  handle('ai:status', () => aiStatus)
  handle('tg:status', () => telegram?.getStatus() ?? { state: 'off' })
  handle('tg:connect', (token: string) => telegram!.connect(token))
  handle('tg:cloudPair', async () => {
    const url = await telegram!.cloudPair()
    await shell.openExternal(url)
  })
  handle('tg:disconnect', () => telegram?.disconnect())
  handle('tg:repair', () => telegram?.repair())
  handle('tg:update', (patch: Pick<TelegramConfig, 'folderId' | 'cookiesFrom'>) => telegram?.update(patch))
  handle('tg:installTools', async () => {
    await installTools((done, total) => send('tg:toolsProgress', { done, total }))
    send('tg:status', telegram?.getStatus())
  })
  handle('ai:enabled', () => config.autoTag)
  handle('ai:setEnabled', (on: boolean) => {
    config.autoTag = on
    saveConfig(config)
    tagger?.setEnabled(on)
  })
  handle('items:import', async (paths: string[], folderId: string | null) => {
    // Dropping a plugin or extension file installs it instead of importing it as a file.
    const formats = new Set(plugins?.formats() ?? [])
    const pluginFiles = paths.filter((p) => formats.has(path.extname(p).slice(1).toLowerCase()))
    if (pluginFiles.length) {
      paths = paths.filter((p) => !pluginFiles.includes(p))
      for (const f of pluginFiles) await installPlugin(f)
      if (!paths.length) return
    }
    const l = need()
    // Files dragged out of our own grid come back as paths inside the library:
    // treat those as "add to folder" rather than an import.
    const internal = paths.map((p) => l.idFromPath(p)).filter((id): id is string => !!id)
    if (internal.length && folderId) {
      l.addToFolder(internal, folderId)
      notifyChanged()
    }
    const external = paths.filter((p) => !l.contains(p))
    if (external.length) void importer?.addPaths(external, folderId)
  })
  handle('items:importDialog', async (folderId: string | null) => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Импорт файлов',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Изображения и видео', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (!r.canceled) void importer?.addPaths(r.filePaths, folderId)
  })
  handle('items:paste', async (folderId: string | null) => {
    if (!importer) return false
    const items = await clipboard.read()
    // A file copied in Explorer (raw Windows clipboard format).
    const fileFormat = 'electron application/osclipboard;format="FileNameW"'
    for (const item of items) {
      if (!item.types.includes(fileFormat)) continue
      const raw = Buffer.from(await ((await item.getType(fileFormat)) as Blob).arrayBuffer())
      const p = raw.toString('utf16le').replace(/\0+$/, '')
      if (p && fs.existsSync(p)) {
        void importer.addPaths([p], folderId)
        return true
      }
    }
    // Raw image data (screenshot, "copy image" in a browser).
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const data = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer())
      const png = await sharp(data).png().toBuffer()
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
      void importer.importBuffer(png, `Вставка ${stamp}.png`, folderId)
      return true
    }
    return false
  })
  handle('items:openExternal', (id: string) => {
    const p = need().filePath(id)
    if (p) return shell.openPath(p)
  })
  handle('items:showInFolder', (id: string) => {
    const p = need().filePath(id)
    if (p) shell.showItemInFolder(p)
  })
  handle('items:copyPath', (id: string) => {
    const p = need().filePath(id)
    if (p) clipboard.writeText(p)
  })
  handle('openUrl', (url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
  })

  handle('folders:list', () => need().folders())
  handle('folders:update', (id: string, patch: FolderPatch) => {
    need().updateFolder(id, patch)
    notifyChanged()
  })
  handle('folders:setPassword', (id: string, password: string | null) => {
    need().setFolderPassword(id, password)
    notifyChanged()
  })
  handle('folders:checkPassword', (id: string, password: string) => need().checkFolderPassword(id, password))
  handle('folders:duplicate', (id: string) => {
    const f = need().duplicateFolder(id)
    notifyChanged()
    return f
  })
  /** Applies the folder's auto-tags to everything already inside it. */
  handle('folders:applyAutoTags', (id: string) => {
    const l = need()
    const f = l.folders().find((x) => x.id === id)
    if (f?.autoTags.length) l.addTags(l.folderItemIds(id), f.autoTags)
    notifyChanged()
  })
  handle('folders:exportDir', async (id: string) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Куда экспортировать папку', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const res = await exportFolderToDir(need(), id, r.filePaths[0])
    shell.openPath(res.dir)
    return res.files
  })
  handle('folders:exportZip', async (id: string) => {
    const l = need()
    const f = l.folders().find((x) => x.id === id)
    const r = await dialog.showSaveDialog(win!, {
      title: 'Экспорт папки в ZIP',
      defaultPath: path.join(app.getPath('documents'), `${f?.name ?? 'Папка'}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return null
    const n = await exportFolderToZip(l, id, r.filePath)
    shell.showItemInFolder(r.filePath)
    return n
  })
  handle('folders:copyToLibrary', async (id: string, target: string | null) => {
    let dir = target
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { title: 'Выберите библиотеку D3S3RT', properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      dir = r.filePaths[0]
    }
    if (!Library.isLibrary(dir)) throw new Error('Эта папка не является библиотекой D3S3RT')
    return copyFolderToLibrary(need(), id, dir)
  })
  /** stash-app://folder/<id> — clicking it (in a chat, notes…) opens Stash right in that folder. */
  handle('folders:copyLink', async (id: string) => {
    registerDeepLinks()
    await clipboard.writeText(`stash-app://folder/${id}`)
  })
  handle('folders:create', (name: string, parentId: string | null) => {
    const f = need().createFolder(name, parentId)
    notifyChanged()
    return f
  })
  handle('folders:rename', (id: string, name: string) => {
    need().renameFolder(id, name)
    notifyChanged()
  })
  handle('folders:delete', (id: string) => {
    need().deleteFolder(id)
    notifyChanged()
  })
  handle('folders:move', (id: string, parentId: string | null) => {
    need().moveFolder(id, parentId)
    notifyChanged()
  })

  handle('tags:list', () => need().tags())
  handle('tags:rename', (from: string, to: string) => {
    need().renameTag(from, to)
    notifyChanged()
  })
  handle('tags:delete', (name: string) => {
    need().deleteTag(name)
    notifyChanged()
  })
  handle('counts', () => need().counts())

  handle(
    'menu:popup',
    (entries: MenuEntry[]) =>
      new Promise<string | null>((resolve) => {
        const build = (list: MenuEntry[]): MenuItemConstructorOptions[] =>
          list.map((e) =>
            e.type === 'separator'
              ? { type: 'separator' as const }
              : e.submenu
                ? { label: e.label, enabled: e.enabled !== false, submenu: build(e.submenu) }
                : { label: e.label, enabled: e.enabled !== false, click: () => resolve(e.id ?? null) }
          )
        const menu = Menu.buildFromTemplate(build(entries))
        // `callback` fires on close; give a pending click handler the chance to resolve first.
        menu.popup({ window: win!, callback: () => setTimeout(() => resolve(null), 50) })
      })
  )
  handle('dialog:confirm', async (message: string, detail?: string, okLabel = 'Удалить') => {
    const r = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Отмена', okLabel],
      defaultId: 1,
      cancelId: 0,
      message,
      detail
    })
    return r.response === 1
  })

  // Native drag of library files into other apps (Explorer, Photoshop, Figma, browsers…).
  ipcMain.on('drag:start', (e, ids: string[]) => {
    const l = lib
    if (!l || !ids.length) return
    const files = ids.map((id) => l.filePath(id)).filter((p): p is string => !!p && fs.existsSync(p))
    if (!files.length) return
    const thumb = l.thumbPath(ids[0])
    let icon = thumb && fs.existsSync(thumb) ? nativeImage.createFromPath(thumb) : null
    if (icon && !icon.isEmpty()) icon = icon.resize({ width: 96 })
    else icon = dragIcon
    e.sender.startDrag({ file: files[0], files, icon: icon! })
  })
}

// ---------- deep links (stash-app://folder/<id>) ----------

function registerDeepLinks(): void {
  if (app.isDefaultProtocolClient('stash-app')) return
  // In development Electron is started as "electron.exe <app dir>", so the app path is passed along.
  if (process.defaultApp) app.setAsDefaultProtocolClient('stash-app', process.execPath, [path.resolve(app.getAppPath())])
  else app.setAsDefaultProtocolClient('stash-app')
}

function handleDeepLink(argv: string[]): void {
  const link = argv.find((a) => a.startsWith('stash-app://'))
  const m = link && /^stash-app:\/\/folder\/([\w-]+)/.exec(link)
  if (!m) return
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  send('plugin:open-folder', m[1])
}

// ---------- screenshot ----------

let capturing = false
/** Area screenshot → library. Hides Stash first if it is in front, so it doesn't end up in the shot. */
async function screenshotToLibrary(folderId: string | null): Promise<boolean> {
  if (capturing || !importer) return false
  capturing = true
  const hide = !!win && win.isVisible() && win.isFocused()
  try {
    if (hide) {
      win!.hide()
      await new Promise((r) => setTimeout(r, 250))
    }
    const png = await captureArea()
    if (!png) return false
    const s = settings?.get()
    const format = s?.shotFormat ?? 'png'
    const data = format === 'jpg' ? await sharp(png).jpeg({ quality: 92 }).toBuffer() : format === 'webp' ? await sharp(png).webp({ quality: 92 }).toBuffer() : png
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'stash-shot-'))
    const file = path.join(dir, `Скриншот ${stamp}.${format}`)
    await fs.promises.writeFile(file, data)
    void importer
      ?.importFile(file, folderId, { tags: s?.shotTag === false ? [] : ['скриншот'] })
      .catch(() => null)
      .finally(() => fs.promises.rm(dir, { recursive: true, force: true }))
    if (s?.shotCopy) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    if (s?.shotNotify) new Notification({ title: 'Скриншот сохранён', body: 'Добавлен в библиотеку D3S3RT' }).show()
    return true
  } finally {
    capturing = false
    if (hide && win && !win.isDestroyed()) win.show()
  }
}

async function installPlugin(file: string): Promise<void> {
  if (!plugins) return
  try {
    const name = await plugins.install(file)
    send('plugins:changed')
    new Notification({ title: 'Плагин установлен', body: name }).show()
  } catch (err) {
    await dialog.showMessageBox(win!, { type: 'error', message: 'Не удалось установить плагин', detail: (err as Error).message })
  }
}

// ---------- window ----------

function createWindow(): void {
  const b = config.bounds
  win = new BrowserWindow({
    x: b?.x,
    y: b?.y,
    width: b?.width ?? 1440,
    height: b?.height ?? 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#141518',
    title: 'D3S3RT',
    titleBarStyle: 'hidden',
    // Windows draws its window buttons over the toolbar; macOS keeps its traffic lights on the left.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { icon: path.join(app.getAppPath(), 'resources', 'icon.ico'), titleBarOverlay: { color: '#1a1b1f', symbolColor: '#b9bcc4', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  if (b?.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())
  // The zoom factor resets on every load, so re-apply the "interface scale" preference.
  win.webContents.on('did-finish-load', () => settings?.applyZoom())

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return
    config.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    saveConfig(config)
  }
  win.on('close', saveBounds)
  // Plugin windows (some hidden) must not keep Stash running after its main window is closed.
  win.on('closed', () => {
    plugins?.stopAll()
    app.quit()
  })

  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win?.webContents.toggleDevTools()
    if (!app.isPackaged && input.control && input.key.toLowerCase() === 'r') win?.webContents.reload()
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Dev hook: STASH_SCREENSHOT=out.png captures the window a few seconds after load.
  const shot = process.env.STASH_SCREENSHOT
  if (shot) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message))
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.STASH_EVAL) {
          const result = await win!.webContents.executeJavaScript(process.env.STASH_EVAL).catch((e) => `eval error: ${e}`)
          console.log('[eval]', JSON.stringify(result))
          await new Promise((r) => setTimeout(r, 1000))
        }
        const img = await win!.webContents.capturePage()
        fs.writeFileSync(shot, img.toPNG())
        // Also capture any other open windows (plugin windows) as <shot>-1.png, -2.png …
        let n = 0
        for (const w of BrowserWindow.getAllWindows()) {
          if (w === win || !w.isVisible()) continue
          // STASH_PLUGIN_EVAL runs in each plugin window first (e.g. to press its buttons).
          if (process.env.STASH_PLUGIN_EVAL) {
            const r = await w.webContents.executeJavaScript(process.env.STASH_PLUGIN_EVAL).catch((e) => `eval error: ${e}`)
            console.log('[plugin-eval]', JSON.stringify(r))
          }
          fs.writeFileSync(shot.replace(/\.png$/, `-${++n}.png`), (await w.webContents.capturePage()).toPNG())
        }
        if (process.env.STASH_SCREENSHOT_QUIT) app.quit()
      }, Number(process.env.STASH_SCREENSHOT_DELAY ?? 4000))
    })
  }
}

// One Stash per profile: a second launch (e.g. from a stash-app:// link) hands over to the running one.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', (_e, argv) => handleDeepLink(argv))

app.whenReady().then(async () => {
  if (!primary) return
  // macOS needs an application menu for Cmd+Q / copy / paste; Windows runs without one.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
  protocol.handle('stash', serve)
  registerIpc()
  dragIcon = nativeImage.createFromBuffer(
    await sharp({ create: { width: 48, height: 48, channels: 4, background: '#6b7cff' } }).png().toBuffer()
  )

  // Dev hook: STASH_LIBRARY opens (or creates) a specific library.
  const initial = process.env.STASH_LIBRARY ?? config.lastLibrary
  if (initial && (process.env.STASH_LIBRARY || Library.isLibrary(initial))) {
    try {
      openLibrary(initial)
    } catch (err) {
      console.error('Failed to open library', initial, err)
    }
  }
  createWindow()

  // Preferences: global shortcuts, zoom, autostart, auto-import (see src/main/settings.ts).
  settings = new SettingsManager({
    config,
    save: () => saveConfig(config),
    win: () => win,
    send,
    screenshot: () => void screenshotToLibrary(null),
    importPaths: (paths, folderId) => {
      const target = folderId && lib?.folders().some((f) => f.id === folderId) ? folderId : null
      void importer?.addPaths(paths, target)
    }
  })
  for (const w of settings.start()) console.warn('[settings]', w)

  // New versions come from the releases feed baked into the installer.
  updater = new Updater((s) => send('update:state', s))
  updater.setAuto(settings.get().autoUpdate)

  // Local endpoint for the browser extension (see /extension).
  syncExtension()
  startClipperServer({
    ...clipDeps,
    onExtensionSeen: () => (extensionSeenAt = Date.now()),
    importFile: async (file, folderId, meta) => {
      const r = await clipDeps.importFile(file, folderId, meta)
      if (settings?.get().notifyExtension && !r.duplicate) new Notification({ title: 'Сохранено в D3S3RT', body: meta.name ?? 'Файл из браузера' }).show()
      return r
    }
  })

  // Personal Telegram bot (see src/main/telegram.ts).
  telegram = new TelegramBot({
    ...clipDeps,
    config: () => config.telegram ?? {},
    save: (c) => {
      config.telegram = c
      saveConfig(config)
    },
    onStatus: (s) => send('tg:status', s)
  })
  telegram.start()

  // Extensions (see src/main/pluginHost.ts).
  plugins = new PluginHost(
    {
      lib: () => lib,
      importer: () => importer,
      mainWindow: () => win,
      selection: () => uiState,
      notifyChanged,
      enqueueThumbs: (ids) => thumbs?.enqueue(ids),
      sendToRenderer: send,
      clipDeps,
      disabled: () => config.disabledPlugins ?? [],
      setDisabled: (ids) => {
        config.disabledPlugins = ids
        saveConfig(config)
      }
    },
    {
      disabled: () => config.disabledExtensions ?? [],
      setDisabled: (ids) => {
        config.disabledExtensions = ids
        saveConfig(config)
      }
    }
  )
  plugins.loadAll()
  if (lib) plugins.startServices()

  // Launched through a stash-app:// link.
  win?.webContents.once('did-finish-load', () => setTimeout(() => handleDeepLink(process.argv), 500))

  // Dev hook: STASH_IMPORT="a;b;c" imports those paths on startup.
  if (process.env.STASH_IMPORT && importer) void importer.addPaths(process.env.STASH_IMPORT.split(';'), null)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  settings?.stop()
  telegram?.stop()
  plugins?.stopAll()
})

app.on('window-all-closed', () => {
  closeLibrary()
  app.quit()
})
