/**
 * One icon set for the whole app: Lucide (ISC licence). Shared so the UI and the board exporter
 * draw exactly the same glyphs.
 */
import { icons } from 'lucide'

export type IconNode = [string, Record<string, string | number>][]

/** Stash's own icon names → Lucide icons. Any other name is looked up in Lucide directly (kebab-case). */
const ALIAS: Record<string, string> = {
  folder: 'Folder',
  'folder-plus': 'FolderPlus',
  'folder-sub': 'FolderTree',
  'folder-open': 'FolderOpen',
  move: 'FolderInput',
  rename: 'PencilLine',
  sort: 'ArrowUpDown',
  'sort-asc': 'ArrowUpNarrowWide',
  'sort-desc': 'ArrowDownWideNarrow',
  'expand-one': 'ListCollapse',
  'expand-same': 'ListTree',
  'expand-all': 'ChevronsUpDown',
  export: 'Upload',
  library: 'Layers',
  layers: 'Layers2',
  trash: 'Trash2',
  open: 'Play',
  external: 'ExternalLink',
  board: 'LayoutDashboard',
  refresh: 'RefreshCw',
  restore: 'RotateCcw',
  retry: 'RotateCw',
  path: 'Clipboard',
  sparkle: 'Sparkles',
  pinterest: 'ScanSearch',
  minus2: 'Minus',
  cursor: 'MousePointer2',
  marker: 'Highlighter',
  line: 'Slash',
  arrow: 'ArrowUpRight',
  home: 'House',
  undo: 'Undo2',
  redo: 'Redo2',
  fullscreen: 'Maximize',
  'flip-h': 'FlipHorizontal2',
  'flip-v': 'FlipVertical2',
  unlock: 'LockOpen',
  'to-top': 'ArrowUpToLine',
  'to-bottom': 'ArrowDownToLine',
  id: 'IdCard',
  dice: 'Dices',
  close: 'X',
  filter: 'ListFilter',
  peek: 'ZoomIn',
  capture: 'SquareDashedMousePointer',
  plugins: 'Puzzle',
  telegram: 'Send',
  sound: 'Volume2',
  mute: 'VolumeX',
  'align-left': 'TextAlignStart',
  'align-center': 'TextAlignCenter',
  'align-right': 'TextAlignEnd',
  hidden: 'EyeOff',
  all: 'Images',
  'no-folder': 'Inbox',
  'no-tag': 'Tags',
  ok: 'CircleCheck',
  error: 'CircleX',
  warn: 'TriangleAlert',
  help: 'CircleHelp',
  chat: 'MessageCircle'
}

const pascal = (s: string) => s.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase())
const lib = icons as unknown as Record<string, IconNode>

export function iconNode(name: string | undefined): IconNode | null {
  if (!name) return null
  return lib[ALIAS[name] ?? pascal(name)] ?? null
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Inner SVG markup of an icon in its native 24×24 box. */
export function iconInner(name: string | undefined): string {
  const node = iconNode(name)
  if (!node) return ''
  return node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(String(v))}"`).join(' ')}/>`)
    .join('')
}

/**
 * Icons offered for folders and for canvas stickers. Stored as "i:<name>" so that older data
 * holding an emoji keeps working.
 */
export const PICKABLE: [string, string][] = [
  ['star', 'Звезда'],
  ['heart', 'Сердце'],
  ['flame', 'Огонь'],
  ['lightbulb', 'Идея'],
  ['pin', 'Булавка'],
  ['bookmark', 'Закладка'],
  ['flag', 'Флаг'],
  ['zap', 'Молния'],
  ['target', 'Цель'],
  ['rocket', 'Ракета'],
  ['gem', 'Кристалл'],
  ['clapperboard', 'Видео'],
  ['camera', 'Фото'],
  ['palette', 'Палитра'],
  ['brush', 'Кисть'],
  ['pencil', 'Карандаш'],
  ['box', '3D'],
  ['shapes', 'Формы'],
  ['leaf', 'Природа'],
  ['waves', 'Вода'],
  ['sunset', 'Закат'],
  ['moon', 'Ночь'],
  ['building-2', 'Город'],
  ['car', 'Транспорт'],
  ['user', 'Люди'],
  ['paw-print', 'Животные'],
  ['utensils', 'Еда'],
  ['music', 'Музыка'],
  ['gamepad-2', 'Игры'],
  ['wrench', 'Инструменты'],
  ['package', 'Продукт'],
  ['flask-conical', 'Эксперименты'],
  ['archive', 'Архив'],
  ['clock', 'Позже']
]

/** Stickers for the canvas: marks you put on top of references. */
export const STICKER_ICONS: [string, string][] = [
  ['star', '#e8c547'],
  ['heart', '#e5534b'],
  ['flame', '#e8963a'],
  ['ok', '#57b05b'],
  ['error', '#e5534b'],
  ['warn', '#e8963a'],
  ['lightbulb', '#e8c547'],
  ['pin', '#e86fa6'],
  ['thumbs-up', '#4d8fe8'],
  ['thumbs-down', '#9e9e9e'],
  ['target', '#e5534b'],
  ['rocket', '#a97be8'],
  ['sparkle', '#e8c547'],
  ['zap', '#e8c547'],
  ['flag', '#57b05b'],
  ['bookmark', '#4d8fe8'],
  ['palette', '#a97be8'],
  ['camera', '#4fb6c8'],
  ['clapperboard', '#4fb6c8'],
  ['sound', '#4d8fe8'],
  ['chat', '#57b05b'],
  ['help', '#9e9e9e'],
  ['clock', '#9e9e9e'],
  ['eye', '#4d8fe8']
]
