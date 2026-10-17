import type {
  AiStatus,
  ConvertOptions,
  ConvertProgress,
  Board,
  BoardData,
  BoardInfo,
  BoardNode,
  Counts,
  ExtCount,
  FacetCounts,
  Folder,
  FolderPatch,
  ImportProgress,
  Item,
  ItemLite,
  ItemPatch,
  LibraryInfo,
  MenuEntry,
  Query,
  TagCount,
  TelegramStatus,
  ThumbReady
} from '../../shared/types'

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, cb: (...args: any[]) => void): () => void
  pathForFile(file: File): string
}

export interface PinResult {
  id: string
  title: string
  thumb: string
  large: string
  width: number
  height: number
  pinUrl: string
  domain: string
  isVideo: boolean
}

export interface PinPage {
  results: PinResult[]
  bookmark: string | null
}

export interface StoryboardOptions {
  mode: 'interval' | 'count' | 'scenes'
  interval: number
  count: number
  threshold: number
  frames: boolean
  sheet: boolean
  parentFolderId: string | null
}

/** A Stash extension (.stashplugin). */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  active: boolean
  error: string | null
  formats: string[]
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  kind: 'window' | 'service' | 'module'
  logo: string | null
  running: boolean
  enabled: boolean
  description: string
  keywords: string[]
  size: number
  installedAt: number
}

import { openMenu } from './menu'
import type { Settings, SettingsResult, UpdateState } from '../../shared/settings'

const b = (window as unknown as { stash: Bridge }).stash
const call = <T>(channel: string, ...args: unknown[]) => b.invoke(channel, ...args) as Promise<T>

export const api = {
  currentLibrary: () => call<LibraryInfo | null>('lib:current'),
  recentLibraries: () => call<string[]>('lib:recent'),
  openLibrary: (path: string) => call<LibraryInfo | null>('lib:open', path),
  openLibraryDialog: () => call<LibraryInfo | null>('lib:openDialog'),
  createLibrary: () => call<LibraryInfo | null>('lib:create'),
  revealLibrary: () => call<void>('lib:reveal'),

  query: (q: Query) => call<ItemLite[]>('items:query', q),
  facets: (q: Query) => call<FacetCounts>('items:facets', q),
  exts: () => call<ExtCount[]>('items:exts'),
  hasVector: (id: string) => call<boolean>('items:hasVector', id),
  webSearch: (id: string, engine: string) => call<void>('items:webSearch', id, engine),
  captureArea: (folderId: string | null) => call<boolean>('capture:area', folderId),
  getItem: (id: string) => call<Item | null>('items:get', id),
  update: (ids: string[], patch: ItemPatch) => call<void>('items:update', ids, patch),
  addTags: (ids: string[], tags: string[]) => call<void>('items:addTags', ids, tags),
  removeTag: (ids: string[], tag: string) => call<void>('items:removeTag', ids, tag),
  addToFolder: (ids: string[], folderId: string) => call<void>('items:addToFolder', ids, folderId),
  removeFromFolder: (ids: string[], folderId: string) => call<void>('items:removeFromFolder', ids, folderId),
  trash: (ids: string[]) => call<void>('items:trash', ids),
  restore: (ids: string[]) => call<void>('items:restore', ids),
  deleteForever: (ids: string[]) => call<void>('items:deleteForever', ids),
  emptyTrash: () => call<void>('items:emptyTrash'),
  regenThumbs: (ids: string[]) => call<void>('items:regenThumbs', ids),
  retag: (ids: string[]) => call<void>('items:retag', ids),
  aiStatus: () => call<AiStatus>('ai:status'),
  aiEnabled: () => call<boolean>('ai:enabled'),
  telegramStatus: () => call<TelegramStatus>('tg:status'),
  telegramConnect: (token: string) => call<string>('tg:connect', token),
  telegramCloudPair: () => call<void>('tg:cloudPair'),
  telegramDisconnect: () => call<void>('tg:disconnect'),
  telegramRepair: () => call<void>('tg:repair'),
  telegramUpdate: (patch: Pick<TelegramStatus, 'folderId' | 'cookiesFrom'>) => call<void>('tg:update', patch),
  telegramInstallTools: () => call<void>('tg:installTools'),
  onTelegramStatus: (cb: (s: TelegramStatus) => void) => b.on('tg:status', cb),
  onTelegramToolsProgress: (cb: (p: { done: number; total: number }) => void) => b.on('tg:toolsProgress', cb),
  setAiEnabled: (on: boolean) => call<void>('ai:setEnabled', on),
  importPaths: (paths: string[], folderId: string | null) => call<void>('items:import', paths, folderId),
  importDialog: (folderId: string | null) => call<void>('items:importDialog', folderId),
  paste: (folderId: string | null) => call<boolean>('items:paste', folderId),
  openExternal: (id: string) => call<void>('items:openExternal', id),
  showInFolder: (id: string) => call<void>('items:showInFolder', id),
  copyPath: (id: string) => call<void>('items:copyPath', id),
  openUrl: (url: string) => call<void>('openUrl', url),

  folders: () => call<Folder[]>('folders:list'),
  updateFolder: (id: string, patch: FolderPatch) => call<void>('folders:update', id, patch),
  setFolderPassword: (id: string, password: string | null) => call<void>('folders:setPassword', id, password),
  checkFolderPassword: (id: string, password: string) => call<boolean>('folders:checkPassword', id, password),
  duplicateFolder: (id: string) => call<Folder | null>('folders:duplicate', id),
  applyFolderAutoTags: (id: string) => call<void>('folders:applyAutoTags', id),
  exportFolderDir: (id: string) => call<number | null>('folders:exportDir', id),
  exportFolderZip: (id: string) => call<number | null>('folders:exportZip', id),
  copyFolderToLibrary: (id: string, target: string | null) => call<number | null>('folders:copyToLibrary', id, target),
  copyFolderLink: (id: string) => call<void>('folders:copyLink', id),
  createFolder: (name: string, parentId: string | null) => call<Folder>('folders:create', name, parentId),
  renameFolder: (id: string, name: string) => call<void>('folders:rename', id, name),
  deleteFolder: (id: string) => call<void>('folders:delete', id),
  moveFolder: (id: string, parentId: string | null) => call<void>('folders:move', id, parentId),

  tags: () => call<TagCount[]>('tags:list'),
  renameTag: (from: string, to: string) => call<void>('tags:rename', from, to),
  deleteTag: (name: string) => call<void>('tags:delete', name),
  counts: () => call<Counts>('counts'),

  pinterestSearch: (id: string, bookmark: string | null) => call<PinPage>('pinterest:search', id, bookmark),
  pinterestSave: (pin: PinResult, folderId: string | null) => call<string>('pinterest:save', pin, folderId),
  makeStoryboard: (id: string, opts: StoryboardOptions) => call<{ frames: number; folderId: string | null }>('storyboard:make', id, opts),
  grabFrame: (id: string, at: number, folderId: string | null, target: 'library' | 'clipboard' | 'file' = 'library') =>
    call<string | null>('video:grabFrame', id, at, folderId, target),
  bytes: (id: string) => call<Uint8Array>('items:bytes', id),
  videoInfo: (id: string) => call<{ fps: number }>('video:info', id),
  trimVideo: (id: string, start: number, end: number, mode: 'exact' | 'fast' | 'gif', target: 'library' | 'file' = 'library') =>
    call<string | null>('video:trim', id, start, end, mode, target),
  getSettings: () => call<Settings>('settings:get'),
  setSettings: (patch: Partial<Settings>) => call<SettingsResult>('settings:set', patch),
  onSettings: (cb: (s: Settings) => void) => b.on('settings:changed', cb),
  pickAutoImportDir: () => call<string | null>('settings:pickDir'),
  hasLock: () => call<boolean>('lock:has'),
  checkLock: (password: string) => call<boolean>('lock:check', password),
  setLock: (password: string | null, current: string) => call<boolean>('lock:set', password, current),
  appInfo: () => call<{ version: string; electron: string; chrome: string; node: string; userData: string; library: string | null }>('app:info'),
  openUserData: () => call<void>('app:openUserData'),
  openDevTools: () => call<void>('app:devtools'),
  relaunch: () => call<void>('app:relaunch'),
  browserExt: () => call<{ dir: string; version: string | null; browsers: { id: string; name: string; page: string }[]; seenAt: number | null }>('browserExt:info'),
  openExtensionsPage: (id: string) => call<boolean>('browserExt:open', id),
  revealBrowserExt: () => call<void>('browserExt:reveal'),
  updateState: () => call<UpdateState | null>('update:state'),
  checkUpdate: () => call<UpdateState | null>('update:check'),
  installUpdate: () => call<void>('update:install'),
  onUpdateState: (cb: (s: UpdateState) => void) => b.on('update:state', cb),
  onImportAdded: (cb: (ids: string[]) => void) => b.on('import:added', cb),
  convert: (ids: string[], opts: ConvertOptions) => call<{ converted: number; failed: number; cancelled: boolean } | null>('convert:start', ids, opts),
  cancelConvert: () => call<void>('convert:cancel'),
  onConvertProgress: (cb: (p: ConvertProgress) => void) => b.on('convert:progress', cb),
  onStoryboardProgress: (cb: (p: { done: number; total: number }) => void) => b.on('storyboard:progress', cb),
  boards: () => call<BoardInfo[]>('boards:list'),
  getBoard: (id: string) => call<Board | null>('boards:get', id),
  createBoard: (name: string, ids: string[] = []) => call<BoardInfo>('boards:create', name, ids),
  saveBoard: (id: string, data: BoardData) => call<void>('boards:save', id, data),
  renameBoard: (id: string, name: string) => call<void>('boards:rename', id, name),
  deleteBoard: (id: string) => call<void>('boards:delete', id),
  boardAddItems: (id: string, ids: string[], at?: { x: number; y: number }) => call<BoardData>('boards:addItems', id, ids, at),
  boardAddPaths: (id: string, paths: string[], at?: { x: number; y: number }) => call<BoardData>('boards:addPaths', id, paths, at),
  boardPaste: () => call<{ nodes: BoardNode[] } | { id: string } | null>('boards:paste'),
  boardCopyNodes: (id: string, nodes: BoardNode[]) => call<boolean>('boards:copyNodes', id, nodes),
  boardAddFromDialog: (id: string, at?: { x: number; y: number }) => call<BoardData | null>('boards:addFromDialog', id, at),
  exportBoard: (id: string, target: 'file' | 'library' | 'clipboard', only?: string[]) => call<boolean>('boards:export', id, target, only),
  duplicateBoard: (id: string) => call<BoardInfo>('boards:duplicate', id),
  boardSvg: (id: string, target: 'clipboard' | 'file') => call<boolean>('boards:svg', id, target),
  openApp: (name: 'figma' | 'miro' | 'pureref') => call<void>('apps:open', name),
  openInPureRef: (boardId: string) => call<boolean>('apps:pureref', boardId),
  miroFiles: (boardId: string) => call<boolean>('apps:miroFiles', boardId),
  miroArrange: (boardId: string) => call<number>('apps:miroArrange', boardId),
  onBoardChanged: (cb: (id: string) => void) => b.on('boards:changed', cb),
  /** A board copy (Ctrl+C) is fully ready to paste anywhere. */
  onCopyReady: (cb: (info: { count: number; frames: number }) => void) => b.on('boards:copyReady', cb),
  plugins: () => call<PluginInfo[]>('plugins:list'),
  runPlugin: (id: string) => call<void>('plugins:run', id),
  uninstallPlugin: (id: string) => call<void>('plugins:uninstall', id),
  installPluginDialog: () => call<void>('plugins:installDialog'),
  revealPlugins: () => call<void>('plugins:reveal'),
  setPluginEnabled: (id: string, on: boolean) => call<void>('plugins:setEnabled', id, on),
  stopPlugin: (id: string) => call<void>('plugins:stop', id),
  restartPlugin: (id: string) => call<void>('plugins:restart', id),
  pluginDevtools: (id: string) => call<void>('plugins:devtools', id),
  revealPlugin: (id: string) => call<void>('plugins:revealOne', id),
  onPluginsChanged: (cb: () => void) => b.on('plugins:changed', cb),
  pluginFormats: () => call<string[]>('plugins:formats'),
  extensions: () => call<ExtensionInfo[]>('extensions:list'),
  setExtensionEnabled: (id: string, on: boolean) => call<void>('extensions:setEnabled', id, on),
  uninstallExtension: (id: string) => call<void>('extensions:uninstall', id),
  revealExtensions: () => call<void>('extensions:reveal'),
  reportSelection: (ids: string[], folderId: string | null) => b.send('state:selection', ids, folderId),
  onPluginSelect: (cb: (ids: string[]) => void) => b.on('plugin:select', cb),
  onPluginOpenItem: (cb: (id: string) => void) => b.on('plugin:open-item', cb),
  onPluginOpenFolder: (cb: (id: string) => void) => b.on('plugin:open-folder', cb),

  /** In-app context menu (see components/ContextMenu.tsx). */
  menu: (entries: MenuEntry[], opts?: { search?: boolean }) => openMenu(entries, opts),
  confirm: (message: string, detail?: string, okLabel?: string) => call<boolean>('dialog:confirm', message, detail, okLabel),
  startDrag: (ids: string[]) => b.send('drag:start', ids),
  pathForFile: (file: File) => b.pathForFile(file),

  onChanged: (cb: () => void) => b.on('lib:changed', cb),
  onSwitched: (cb: (info: LibraryInfo) => void) => b.on('lib:switched', cb),
  onThumbs: (cb: (batch: ThumbReady[]) => void) => b.on('thumbs:ready', cb),
  onProgress: (cb: (p: ImportProgress) => void) => b.on('import:progress', cb),
  onAiStatus: (cb: (s: AiStatus) => void) => b.on('ai:status', cb)
}

export const fileUrl = (id: string) => `stash://file/${id}`
export const thumbUrl = (id: string, v: number) => `stash://thumb/${id}?v=${v}`

/** Paths of files dropped from the OS (empty for in-page drags). */
export function droppedPaths(dt: DataTransfer): string[] {
  return [...dt.files].map((f) => api.pathForFile(f)).filter(Boolean)
}
