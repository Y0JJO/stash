/** App preferences. Stored by the main process in config.json; the renderer mirrors them. */
export interface Settings {
  // ----- general -----
  theme: 'glass' | 'dark' | 'black' | 'gray' | 'blue' | 'purple'
  /** UI scale, 0.8 … 1.5. */
  zoom: number
  sidebarCounts: boolean
  launchAtLogin: boolean
  /** Hardware acceleration; applied on the next start. */
  gpu: boolean
  selectAfterImport: boolean

  // ----- sidebar -----
  folderDoubleClick: 'rename' | 'toggle'
  showUncategorized: boolean
  showUntagged: boolean
  showQuickAccess: boolean
  showFolders: boolean
  showBoards: boolean
  showTags: boolean

  // ----- controls -----
  /** Wheel over an image in the viewer. */
  imageWheel: 'zoom' | 'navigate'
  itemDoubleClick: 'view' | 'external'
  middleClick: 'external' | 'view' | 'none'
  spacePreview: boolean

  // ----- preview -----
  imageSmoothing: 'smooth' | 'pixelated'
  imageDefaultSize: 'fit' | 'original'
  transparentGrid: boolean
  /** Wheel over a video in the player. */
  videoWheel: 'seek' | 'volume'
  /** Seconds per wheel notch when seeking. */
  videoWheelStep: number
  videoHoverPreview: boolean
  videoAutoplay: boolean
  videoRememberPosition: boolean
  /** Loop only clips shorter than 30 s (otherwise the player's own loop button decides). */
  videoLoopShort: boolean

  // ----- screenshot -----
  shotFormat: 'png' | 'jpg' | 'webp'
  shotShortcutEnabled: boolean
  /** Electron accelerator, e.g. "Alt+Shift+S". */
  shotShortcut: string
  /** Global shortcut that brings Stash to the front ('' = none). */
  showShortcut: string
  shotNotify: boolean
  shotTag: boolean
  shotCopy: boolean

  // ----- notifications -----
  notifyExtension: boolean
  notifyDuplicates: boolean
  notifyAutoImport: boolean

  // ----- auto-import -----
  autoImportEnabled: boolean
  autoImportDir: string
  autoImportFolderId: string | null
  /** Check for new versions in the background. */
  autoUpdate: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'glass',
  zoom: 1,
  sidebarCounts: true,
  launchAtLogin: false,
  gpu: true,
  selectAfterImport: true,

  folderDoubleClick: 'rename',
  showUncategorized: true,
  showUntagged: true,
  showQuickAccess: true,
  showFolders: true,
  showBoards: true,
  showTags: true,

  imageWheel: 'zoom',
  itemDoubleClick: 'view',
  middleClick: 'external',
  spacePreview: true,

  imageSmoothing: 'smooth',
  imageDefaultSize: 'fit',
  transparentGrid: false,
  videoWheel: 'seek',
  videoWheelStep: 1,
  videoHoverPreview: true,
  videoAutoplay: true,
  videoRememberPosition: false,
  videoLoopShort: false,

  shotFormat: 'png',
  shotShortcutEnabled: true,
  shotShortcut: 'Alt+Shift+S',
  showShortcut: '',
  shotNotify: false,
  shotTag: true,
  shotCopy: false,

  notifyExtension: false,
  notifyDuplicates: true,
  notifyAutoImport: true,

  autoImportEnabled: false,
  autoImportDir: '',
  autoImportFolderId: null,
  autoUpdate: true
}

/** What the main process reports back after applying a change. */
export interface SettingsResult {
  settings: Settings
  /** Human-readable problems, e.g. a global shortcut that is already taken. */
  warnings: string[]
}

/** Where the auto-updater is at. "unsupported" = running from source, not from the installer; "available" = install by hand. */
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  /** Installed version. */
  current: string
  /** Version being downloaded / ready to install. */
  version?: string
  percent?: number
  message?: string
  /** Download page, when the new version has to be installed by hand (macOS). */
  url?: string
}
