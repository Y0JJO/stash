export type Kind = 'image' | 'video' | 'other'

/** Thumbnail state: 0 = pending, 1 = ready, 2 = failed / not applicable. */
export type ThumbState = 0 | 1 | 2

export interface ItemLite {
  id: string
  name: string
  ext: string
  kind: Kind
  width: number | null
  height: number | null
  duration: number | null
  rating: number
  size: number
  thumb: ThumbState
  thumbV: number
  addedAt: number
}

export interface PaletteColor {
  hex: string
  ratio: number
}

export interface Item extends ItemLite {
  url: string
  notes: string
  palette: PaletteColor[]
  tags: string[]
  /** Subset of `tags` assigned by the auto-tagger rather than by hand. */
  autoTags: string[]
  folderIds: string[]
  path: string
  modifiedAt: number
  deletedAt: number | null
}

export interface ItemPatch {
  name?: string
  notes?: string
  url?: string
  rating?: number
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  sort: number
  count: number
  /** Accent colour of the folder icon (one of FOLDER_COLORS) or null. */
  color: string | null
  /** Emoji used instead of the folder icon. */
  icon: string | null
  /** Tags given to everything that lands in this folder. */
  autoTags: string[]
  /** Shown under "Быстрый доступ". */
  pinned: boolean
  /** Per-folder sort override. */
  sortKey: SortKey | null
  sortDesc: boolean
  /** Whether the folder view includes items from subfolders. */
  showSub: boolean
  /** Has a password. */
  locked: boolean
}

export interface FolderPatch {
  color?: string | null
  icon?: string | null
  autoTags?: string[]
  pinned?: boolean
  sortKey?: SortKey | null
  sortDesc?: boolean
  showSub?: boolean
}

export const FOLDER_COLORS = ['#9e9e9e', '#e5534b', '#e8963a', '#e8c547', '#57b05b', '#4fb6c8', '#4d8fe8', '#a97be8', '#e86fa6']

export interface TagCount {
  name: string
  count: number
}

export interface Counts {
  all: number
  uncategorized: number
  untagged: number
  trash: number
}

export type Scope =
  | { type: 'all' }
  | { type: 'uncategorized' }
  | { type: 'untagged' }
  | { type: 'trash' }
  | { type: 'folder'; id: string }
  | { type: 'tag'; name: string }
  /** Items visually similar to `id` (CLIP vectors), most similar first. */
  | { type: 'similar'; id: string }
  /** A moodboard canvas (the grid is replaced by the board view). */
  | { type: 'board'; id: string }

export type SortKey = 'added' | 'name' | 'size' | 'rating' | 'duration' | 'random'

export type Shape = 'landscape' | 'portrait' | 'square' | 'panorama'

/** One multi-value filter: an item must match `inc` (if any are picked) and none of `exc`. */
export interface Facet<T> {
  inc: T[]
  exc: T[]
}

/** For tags and folders: picked values combine as "any of them" or "all of them". */
export type FacetRule = 'any' | 'all'

/** '' stands for "no tags" / "no folder" in the tag and folder facets. */
export interface Filters {
  tags: Facet<string> & { rule: FacetRule }
  folders: Facet<string> & { rule: FacetRule }
  shapes: Facet<Shape>
  ratings: Facet<number>
  exts: Facet<string>
  minWidth: number
  minHeight: number
}

export type FacetKey = 'tags' | 'folders' | 'shapes' | 'ratings' | 'exts'

export const NO_FILTERS: Filters = {
  tags: { inc: [], exc: [], rule: 'any' },
  folders: { inc: [], exc: [], rule: 'any' },
  shapes: { inc: [], exc: [] },
  ratings: { inc: [], exc: [] },
  exts: { inc: [], exc: [] },
  minWidth: 0,
  minHeight: 0
}

export interface FacetValue {
  key: string
  count: number
}

/** How many items of the current view (scope, search and the other filters) each filter value would leave. */
export type FacetCounts = Record<FacetKey, FacetValue[]>

export interface Query {
  scope: Scope
  search: string
  kind: 'all' | 'image' | 'video'
  sort: SortKey
  desc: boolean
  color: string | null
  filters: Filters
  /** Seed for the "random" sort, so the order is stable until reshuffled. */
  seed: number
}

export interface ExtCount {
  ext: string
  count: number
}

export interface LibraryInfo {
  path: string
  name: string
}

export interface ImportProgress {
  total: number
  done: number
  skipped: number
  failed: number
  running: boolean
}

export interface ThumbReady {
  id: string
  thumb: ThumbState
  thumbV: number
}

export interface AiStatus {
  phase: 'idle' | 'loading' | 'working' | 'error'
  /** Model download progress, 0..1 (phase "loading"). */
  progress?: number
  done?: number
  total?: number
  message?: string
}

export interface MenuEntry {
  id?: string
  label?: string
  /** 'swatches' renders a row of colour dots (each dot resolves to its own id). */
  type?: 'separator' | 'swatches'
  enabled?: boolean
  submenu?: MenuEntry[]
  /** Icon name from the renderer's icon set. */
  icon?: string
  shortcut?: string
  checked?: boolean
  danger?: boolean
  swatches?: { id: string; color: string; active?: boolean }[]
}

// ---------- moodboards ----------

export type BoardNodeType = 'item' | 'text' | 'shape' | 'path' | 'palette' | 'sticker' | 'frame'

/** A piece of a text node with its own style (unset fields use the node's). */
export interface TextRun {
  text: string
  color?: string
  font?: string
  fontSize?: number
  weight?: number
}

export interface BoardNode {
  id: string
  type: BoardNodeType
  itemId?: string
  x: number
  y: number
  /** Width in board units (1 unit = 1px at 100% zoom). */
  w: number
  /** Height; for text nodes it is recomputed from the content. */
  h: number
  z: number
  /** Degrees, clockwise, around the node centre. */
  rotation?: number
  flipX?: boolean
  flipY?: boolean
  locked?: boolean
  hidden?: boolean
  opacity?: number
  // text
  text?: string
  fontSize?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  /** 400 regular, 600 semibold (default), 700 bold. */
  weight?: number
  /** Font family name (an installed font); unset = the app's default. */
  font?: string
  /**
   * Parts of the text styled on their own (Figma-like mixed styles); joined, they equal `text`.
   * A field left out falls back to the node's own style. Unset = the whole text in one style.
   */
  runs?: TextRun[]
  /** Width follows the text (lines break only at Enter), as Figma's "auto width". Off = fixed width, wrapping. */
  autoWidth?: boolean
  // shape / path
  shape?: 'rect' | 'ellipse' | 'line' | 'arrow'
  stroke?: string
  fill?: string | null
  strokeWidth?: number
  /** Path / line points relative to the node, in a (vw × vh) box that is scaled to w × h. */
  points?: [number, number][]
  vw?: number
  vh?: number
  // palette card
  colors?: string[]
  // sticker
  emoji?: string
  // frame
  name?: string
}

export interface BoardData {
  nodes: BoardNode[]
  bg: string
  view?: { x: number; y: number; zoom: number }
  /** Dotted grid in the background. */
  grid?: boolean
  /** Snap moves/creation to a 10px grid. */
  snap?: boolean
}

export const EMPTY_BOARD: BoardData = { nodes: [], bg: '#1a1b1f' }

export interface BoardInfo {
  id: string
  name: string
  count: number
  updatedAt: number
}

export interface Board {
  id: string
  name: string
  data: BoardData
  items: ItemLite[]
}

export interface TelegramStatus {
  state: 'off' | 'online' | 'error'
  message?: string
  botName?: string
  ownerName?: string
  /** "cloud" — the shared Stash bot via the relay; "token" — the user's own bot. */
  mode?: 'cloud' | 'token'
  /** Whether the one-click shared bot is offered at all. */
  cloudAvailable?: boolean
  /** Code the owner sends the bot to pair it; present until paired. */
  pairCode?: string
  /** Cloud mode: the t.me link that pairs this Stash; present until paired. */
  pairUrl?: string
  folderId?: string | null
  cookiesFrom?: 'none' | 'firefox' | 'chrome' | 'edge'
  toolsInstalled?: boolean
}

// ---------- converter ----------

export type ImageFormat = 'jpg' | 'png' | 'webp' | 'avif' | 'tiff' | 'gif'
export type VideoFormat = 'mp4' | 'mp4-h265' | 'webm' | 'mov' | 'gif' | 'mp3' | 'wav'

export interface ConvertOptions {
  /** Settings for the images in the selection (null = leave images alone). */
  image: { format: ImageFormat; quality: number; /** Longest side in px; 0 keeps the size. */ maxSide: number } | null
  /** Settings for the videos in the selection (null = leave videos alone). */
  video: {
    format: VideoFormat
    quality: 'high' | 'medium' | 'low'
    /** Target height in px; 0 keeps the size. */
    height: number
    /** Target frame rate; 0 keeps it. */
    fps: number
    mute: boolean
  } | null
  /** new: add next to the original · replace: swap the original · folder: write to a folder on disk. */
  output: 'new' | 'replace' | 'folder'
}

export interface ConvertProgress {
  index: number
  total: number
  name: string
  /** 0..1 within the current file. */
  percent: number
  failed: number
  done: boolean
}
