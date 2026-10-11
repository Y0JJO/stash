import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { EMPTY_BOARD } from '../shared/types'
import type {
  Board,
  BoardData,
  BoardInfo,
  Counts,
  ExtCount,
  Folder,
  FolderPatch,
  Item,
  ItemLite,
  ItemPatch,
  Kind,
  LibraryInfo,
  PaletteColor,
  Query,
  SortKey,
  TagCount
} from '../shared/types'

type Param = string | number | null | Uint8Array

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SCHEMA = `
CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  duration    REAL,
  hash        TEXT,
  url         TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  rating      INTEGER NOT NULL DEFAULT 0,
  palette     TEXT NOT NULL DEFAULT '[]',
  thumb_state INTEGER NOT NULL DEFAULT 0,
  thumb_v     INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX items_hash ON items(hash);
CREATE INDEX items_added ON items(added_at);
CREATE INDEX items_deleted ON items(deleted_at);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE item_folders (
  item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, folder_id)
);
CREATE INDEX item_folders_folder ON item_folders(folder_id);

CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX item_tags_tag ON item_tags(tag);
`

const LITE = `i.id, i.name, i.ext, i.kind, i.width, i.height, i.duration, i.rating, i.size,
  i.thumb_state AS thumb, i.thumb_v AS thumbV, i.added_at AS addedAt`

const SORT: Record<Exclude<SortKey, 'random'>, string> = {
  added: 'i.added_at',
  name: 'i.name COLLATE NOCASE',
  size: 'i.size',
  rating: 'i.rating',
  duration: 'i.duration'
}

/** How close (cosine) an item must be to count as "similar". */
const SIMILAR_MIN = 0.75
const SIMILAR_MAX = 300

export interface NewItem {
  id: string
  name: string
  ext: string
  kind: Kind
  file: string
  size: number
  hash: string
  width: number | null
  height: number | null
  duration: number | null
}

function chunks<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const marks = (n: number) => new Array(n).fill('?').join(',')

export function normalizeTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim().slice(0, 64)
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  // "Redmean" approximation of perceptual distance — cheap and good enough for filtering.
  const rm = (a[0] + b[0]) / 2
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export class Library {
  readonly db: DatabaseSync

  constructor(readonly root: string) {
    fs.mkdirSync(path.join(root, 'files'), { recursive: true })
    fs.mkdirSync(path.join(root, 'thumbs'), { recursive: true })
    this.db = new DatabaseSync(path.join(root, 'stash.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  static isLibrary(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'stash.db'))
  }

  get info(): LibraryInfo {
    return { path: this.root, name: path.basename(this.root).replace(/\.stash$/i, '') }
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const { user_version: version } = this.get<{ user_version: number }>('PRAGMA user_version')!
    if (version < 1) {
      this.tx(() => {
        this.db.exec(SCHEMA)
        this.db.exec('PRAGMA user_version = 1')
      })
    }
    if (version < 2) {
      // v2: auto-tagging — tag origin, per-item state and CLIP image vectors.
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE item_tags ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE items ADD COLUMN autotag_state INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE item_vectors (
            item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
            model   TEXT NOT NULL,
            vec     BLOB NOT NULL
          );
          PRAGMA user_version = 2;
        `)
      })
    }
    if (version < 3) {
      // v3: moodboards — free-form canvases; layout is stored as JSON (BoardData).
      this.tx(() => {
        this.db.exec(`
          CREATE TABLE boards (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            data       TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 3;
        `)
      })
    }
    if (version < 4) {
      // v4: folder appearance and behaviour (the folder menu).
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE folders ADD COLUMN color TEXT;
          ALTER TABLE folders ADD COLUMN icon TEXT;
          ALTER TABLE folders ADD COLUMN auto_tags TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE folders ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE folders ADD COLUMN sort_key TEXT;
          ALTER TABLE folders ADD COLUMN sort_desc INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE folders ADD COLUMN show_sub INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE folders ADD COLUMN password TEXT;
          PRAGMA user_version = 4;
        `)
      })
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  private get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  private run(sql: string, ...params: Param[]): void {
    this.db.prepare(sql).run(...params)
  }

  /** Runs `sql` (containing a single `(%IDS%)` placeholder) for every chunk of ids. */
  private eachIds(ids: string[], sql: string, ...pre: Param[]): void {
    for (const part of chunks(ids)) this.run(sql.replace('%IDS%', marks(part.length)), ...pre, ...part)
  }

  // ---------- paths ----------

  contains(p: string): boolean {
    const rel = path.relative(this.root, path.resolve(p))
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /** If `p` points at a file stored inside this library, returns its item id. */
  idFromPath(p: string): string | null {
    const rel = path.relative(path.join(this.root, 'files'), path.resolve(p))
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    const id = rel.split(path.sep)[0]
    return ID_RE.test(id) ? id : null
  }

  filePath(id: string): string | null {
    if (!ID_RE.test(id)) return null
    const row = this.get<{ file: string }>('SELECT file FROM items WHERE id = ?', id)
    return row ? path.join(this.root, 'files', row.file) : null
  }

  thumbPath(id: string): string | null {
    return ID_RE.test(id) ? path.join(this.root, 'thumbs', `${id}.webp`) : null
  }

  // ---------- items ----------

  query(q: Query): ItemLite[] {
    const where: string[] = [q.scope.type === 'trash' ? 'i.deleted_at IS NOT NULL' : 'i.deleted_at IS NULL']
    const params: Param[] = []

    switch (q.scope.type) {
      case 'uncategorized':
        where.push('NOT EXISTS (SELECT 1 FROM item_folders x WHERE x.item_id = i.id)')
        break
      case 'untagged':
        where.push('NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)')
        break
      case 'folder': {
        // By default a folder shows its own items plus everything in its subfolders.
        const showSub = this.get<{ s: number }>('SELECT show_sub AS s FROM folders WHERE id = ?', q.scope.id)?.s ?? 1
        if (showSub) {
          where.push(`i.id IN (SELECT x.item_id FROM item_folders x WHERE x.folder_id IN (
            WITH RECURSIVE sub(id) AS (
              SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
            ) SELECT id FROM sub))`)
        } else where.push('i.id IN (SELECT x.item_id FROM item_folders x WHERE x.folder_id = ?)')
        params.push(q.scope.id)
        break
      }
      case 'tag':
        where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)')
        params.push(q.scope.name)
        break
      case 'board': {
        const ids = this.boardItemIds(q.scope.id)
        where.push(ids.length ? `i.id IN (${marks(ids.length)})` : '0')
        params.push(...ids)
        break
      }
    }

    if (q.kind !== 'all') {
      where.push('i.kind = ?')
      params.push(q.kind)
    }

    const f = q.filters
    if (f) {
      const shapes: Record<string, string> = {
        landscape: 'i.width > i.height * 1.1',
        portrait: 'i.height > i.width * 1.1',
        square: 'i.width BETWEEN i.height * 0.9 AND i.height * 1.1',
        panorama: '(i.width >= i.height * 2 OR i.height >= i.width * 2)'
      }
      if (shapes[f.shape]) where.push(`i.width > 0 AND i.height > 0 AND ${shapes[f.shape]}`)
      if (f.minRating > 0) {
        where.push('i.rating >= ?')
        params.push(f.minRating)
      }
      if (f.exts.length) {
        where.push(`i.ext IN (${marks(f.exts.length)})`)
        params.push(...f.exts)
      }
      if (f.minWidth > 0) {
        where.push('i.width >= ?')
        params.push(f.minWidth)
      }
      if (f.minHeight > 0) {
        where.push('i.height >= ?')
        params.push(f.minHeight)
      }
      for (const tag of f.tags) {
        where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)')
        params.push(tag)
      }
    }

    for (const term of q.search.trim().split(/\s+/).filter(Boolean)) {
      const like = `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`
      where.push(`(i.name LIKE ? ESCAPE '\\' OR i.ext LIKE ? ESCAPE '\\' OR i.notes LIKE ? ESCAPE '\\'
        OR i.url LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE ? ESCAPE '\\'))`)
      params.push(like, like, like, like, like)
    }

    let order: string
    if (q.sort === 'random') {
      // Deterministic shuffle: rowid × multiplier modulo a prime. The multiplier must be large (≥ 1e9) so
      // that consecutive rowids wrap around the modulus; each seed yields a different permutation.
      order = '((i.rowid * ?) % 2147483629)'
      // Knuth multiplicative hash spreads nearby seeds across the whole range.
      const spread = Number((BigInt(Math.floor(Math.abs(q.seed))) * 2654435761n) % 1_000_000_000n)
      params.push(1_000_000_007 + spread)
    } else order = `${SORT[q.sort] ?? SORT.added} ${q.desc ? 'DESC' : 'ASC'}, i.added_at DESC`

    let rows = this.all<ItemLite & { palette?: string }>(
      `SELECT ${LITE}${q.color ? ', i.palette' : ''} FROM items i WHERE ${where.join(' AND ')} ORDER BY ${order}`,
      ...params
    )

    if (q.color) {
      const target = hexToRgb(q.color)
      rows = rows
        .filter((r) => {
          const palette = JSON.parse(r.palette || '[]') as PaletteColor[]
          return palette.some((c) => c.ratio >= 0.05 && colorDistance(hexToRgb(c.hex), target) < 90)
        })
        .map(({ palette: _palette, ...r }) => r)
    }

    if (q.scope.type === 'similar') {
      const sims = this.similarity(q.scope.id)
      rows = rows.filter((r) => sims.has(r.id)).sort((a, b) => sims.get(b.id)! - sims.get(a.id)!)
    }
    return rows
  }

  /** Cosine similarity of every vectorised item to `id` (only the close ones). */
  private similarity(id: string): Map<string, number> {
    const out = new Map<string, number>()
    // slice() copies into a fresh, 4-byte-aligned buffer.
    const toVec = (b: Uint8Array) => new Float32Array(b.slice().buffer)
    const target = this.get<{ vec: Uint8Array }>('SELECT vec FROM item_vectors WHERE item_id = ?', id)
    if (!target) return out
    const t = toVec(target.vec)
    const scored: [string, number][] = []
    for (const row of this.db.prepare('SELECT item_id AS id, vec FROM item_vectors').iterate() as Iterable<{ id: string; vec: Uint8Array }>) {
      const v = toVec(row.vec)
      if (v.length !== t.length) continue
      let s = 0
      for (let i = 0; i < t.length; i++) s += t[i] * v[i]
      if (s >= SIMILAR_MIN || row.id === id) scored.push([row.id, row.id === id ? 2 : s])
    }
    scored.sort((a, b) => b[1] - a[1])
    for (const [k, v] of scored.slice(0, SIMILAR_MAX)) out.set(k, v)
    return out
  }

  hasVector(id: string): boolean {
    return !!this.get('SELECT 1 FROM item_vectors WHERE item_id = ?', id)
  }

  exts(): ExtCount[] {
    return this.all<ExtCount>(
      'SELECT ext, COUNT(*) AS count FROM items WHERE deleted_at IS NULL GROUP BY ext ORDER BY count DESC'
    )
  }

  getItem(id: string): Item | null {
    const row = this.get<ItemLite & { url: string; notes: string; palette: string; file: string; modifiedAt: number; deletedAt: number | null }>(
      `SELECT ${LITE}, i.url, i.notes, i.palette, i.file, i.modified_at AS modifiedAt, i.deleted_at AS deletedAt
       FROM items i WHERE i.id = ?`,
      id
    )
    if (!row) return null
    const { file, palette, ...rest } = row
    const tags = this.all<{ tag: string; auto: number }>('SELECT tag, auto FROM item_tags WHERE item_id = ? ORDER BY auto, tag COLLATE NOCASE', id)
    return {
      ...rest,
      palette: JSON.parse(palette) as PaletteColor[],
      path: path.join(this.root, 'files', file),
      tags: tags.map((t) => t.tag),
      autoTags: tags.filter((t) => t.auto).map((t) => t.tag),
      folderIds: this.all<{ folder_id: string }>('SELECT folder_id FROM item_folders WHERE item_id = ?', id).map((f) => f.folder_id)
    }
  }

  findByHash(hash: string): { id: string; deleted: boolean } | null {
    const row = this.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM items WHERE hash = ? LIMIT 1', hash)
    return row ? { id: row.id, deleted: row.deleted_at !== null } : null
  }

  insertItem(it: NewItem): void {
    const now = Date.now()
    this.run(
      `INSERT INTO items (id, name, ext, kind, file, size, width, height, duration, hash, thumb_state, added_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      it.id, it.name, it.ext, it.kind, it.file, it.size, it.width, it.height, it.duration, it.hash,
      it.kind === 'other' ? 2 : 0, now, now
    )
  }

  updateItems(ids: string[], patch: ItemPatch): void {
    const sets: string[] = []
    const params: Param[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name.trim() || 'Без имени')
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?')
      params.push(patch.notes)
    }
    if (patch.url !== undefined) {
      sets.push('url = ?')
      params.push(patch.url.trim())
    }
    if (patch.rating !== undefined) {
      sets.push('rating = ?')
      params.push(Math.max(0, Math.min(5, Math.round(patch.rating))))
    }
    if (!sets.length) return
    this.tx(() => this.eachIds(ids, `UPDATE items SET ${sets.join(', ')}, modified_at = ? WHERE id IN (%IDS%)`, ...params, Date.now()))
  }

  addTags(ids: string[], tags: string[]): void {
    const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))]
    // Adding a tag by hand "confirms" an existing auto tag.
    const stmt = this.db.prepare('INSERT INTO item_tags (item_id, tag, auto) VALUES (?, ?, 0) ON CONFLICT DO UPDATE SET auto = 0')
    this.tx(() => {
      for (const id of ids) for (const tag of clean) stmt.run(id, tag)
    })
  }

  removeTag(ids: string[], tag: string): void {
    this.tx(() => this.eachIds(ids, 'DELETE FROM item_tags WHERE tag = ? AND item_id IN (%IDS%)', tag))
  }

  trash(ids: string[]): void {
    this.tx(() => this.eachIds(ids, 'UPDATE items SET deleted_at = ? WHERE id IN (%IDS%)', Date.now()))
  }

  restore(ids: string[]): void {
    this.tx(() => this.eachIds(ids, 'UPDATE items SET deleted_at = NULL WHERE id IN (%IDS%)'))
  }

  /** Removes items from the database and deletes their files and thumbnails from disk. */
  deleteForever(ids: string[]): void {
    this.tx(() => this.eachIds(ids, 'DELETE FROM items WHERE id IN (%IDS%)'))
    for (const id of ids) {
      if (!ID_RE.test(id)) continue
      fs.rmSync(path.join(this.root, 'files', id), { recursive: true, force: true })
      fs.rmSync(path.join(this.root, 'thumbs', `${id}.webp`), { force: true })
    }
  }

  trashedIds(): string[] {
    return this.all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NOT NULL').map((r) => r.id)
  }

  // ---------- thumbnails ----------

  pendingThumbIds(): string[] {
    return this.all<{ id: string }>('SELECT id FROM items WHERE thumb_state = 0 ORDER BY added_at DESC').map((r) => r.id)
  }

  thumbJob(id: string): { path: string; kind: Kind; duration: number | null } | null {
    const row = this.get<{ file: string; kind: Kind; duration: number | null }>('SELECT file, kind, duration FROM items WHERE id = ?', id)
    return row ? { path: path.join(this.root, 'files', row.file), kind: row.kind, duration: row.duration } : null
  }

  setThumbDone(id: string, palette: PaletteColor[]): number {
    this.run('UPDATE items SET thumb_state = 1, thumb_v = thumb_v + 1, palette = ? WHERE id = ?', JSON.stringify(palette), id)
    return this.get<{ v: number }>('SELECT thumb_v AS v FROM items WHERE id = ?', id)?.v ?? 0
  }

  setThumbFailed(id: string): void {
    this.run('UPDATE items SET thumb_state = 2 WHERE id = ?', id)
  }

  resetThumbs(ids: string[]): void {
    this.tx(() => this.eachIds(ids, "UPDATE items SET thumb_state = 0 WHERE kind != 'other' AND id IN (%IDS%)"))
  }

  /** Points an item at a new file (plugins' replaceFile) and queues fresh thumbnail + tags. */
  replaceItemFile(id: string, it: Omit<NewItem, 'id' | 'name'>): void {
    this.run(
      `UPDATE items SET file = ?, ext = ?, kind = ?, size = ?, hash = ?, width = ?, height = ?, duration = ?,
         thumb_state = ?, autotag_state = 0, modified_at = ? WHERE id = ?`,
      it.file, it.ext, it.kind, it.size, it.hash, it.width, it.height, it.duration, it.kind === 'other' ? 2 : 0, Date.now(), id
    )
  }

  /** Replaces the item's tag list exactly (all become manual tags). */
  setItemTags(id: string, tags: string[]): void {
    const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))]
    this.tx(() => {
      this.run('DELETE FROM item_tags WHERE item_id = ?', id)
      const ins = this.db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag, auto) VALUES (?, ?, 0)')
      for (const t of clean) ins.run(id, t)
    })
  }

  /** Replaces the item's folder membership exactly (unknown folder ids are ignored). */
  setItemFolders(id: string, folderIds: string[]): void {
    const known = new Set(this.all<{ id: string }>('SELECT id FROM folders').map((f) => f.id))
    this.tx(() => {
      this.run('DELETE FROM item_folders WHERE item_id = ?', id)
      const ins = this.db.prepare('INSERT OR IGNORE INTO item_folders (item_id, folder_id) VALUES (?, ?)')
      for (const f of folderIds) if (known.has(f)) ins.run(id, f)
    })
  }

  folderCreatedAt(id: string): number {
    return this.get<{ c: number }>('SELECT created_at AS c FROM folders WHERE id = ?', id)?.c ?? 0
  }

  // ---------- auto tags ----------

  pendingAutotagIds(): string[] {
    return this.all<{ id: string }>(
      'SELECT id FROM items WHERE autotag_state = 0 AND thumb_state = 1 AND deleted_at IS NULL ORDER BY added_at DESC'
    ).map((r) => r.id)
  }

  autotagJob(id: string): { thumb: string; palette: PaletteColor[] } | null {
    const row = this.get<{ palette: string }>('SELECT palette FROM items WHERE id = ? AND thumb_state = 1', id)
    const thumb = this.thumbPath(id)
    return row && thumb ? { thumb, palette: JSON.parse(row.palette) as PaletteColor[] } : null
  }

  /** Replaces the item's auto tags (manual tags are kept) and stores its image vector. */
  setAutoTags(id: string, tags: string[], vec: Float32Array, model: string): void {
    this.tx(() => {
      this.run('DELETE FROM item_tags WHERE item_id = ? AND auto = 1', id)
      const ins = this.db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag, auto) VALUES (?, ?, 1)')
      for (const tag of tags) ins.run(id, normalizeTag(tag))
      this.run(
        'INSERT INTO item_vectors (item_id, model, vec) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET model = excluded.model, vec = excluded.vec',
        id, model, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
      )
      this.run('UPDATE items SET autotag_state = 1 WHERE id = ?', id)
    })
  }

  setAutotagFailed(id: string): void {
    this.run('UPDATE items SET autotag_state = 2 WHERE id = ?', id)
  }

  resetAutotags(ids: string[]): void {
    this.tx(() => this.eachIds(ids, 'UPDATE items SET autotag_state = 0 WHERE id IN (%IDS%)'))
  }

  // ---------- boards ----------

  boards(): BoardInfo[] {
    return this.all<{ id: string; name: string; data: string; updatedAt: number }>(
      'SELECT id, name, data, updated_at AS updatedAt FROM boards ORDER BY updated_at DESC'
    ).map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt, count: (JSON.parse(b.data) as BoardData).nodes.filter((n) => n.type === 'item').length }))
  }

  getBoard(id: string): Board | null {
    const b = this.get<{ id: string; name: string; data: string }>('SELECT id, name, data FROM boards WHERE id = ?', id)
    if (!b) return null
    const data = { ...EMPTY_BOARD, ...(JSON.parse(b.data) as BoardData) }
    const ids = [...new Set(data.nodes.filter((n) => n.itemId).map((n) => n.itemId!))]
    return { id: b.id, name: b.name, data, items: this.itemsLite(ids) }
  }

  createBoard(name: string, data: BoardData = EMPTY_BOARD): BoardInfo {
    const id = randomUUID()
    const now = Date.now()
    this.run('INSERT INTO boards (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, name.trim() || 'Новый мудборд', JSON.stringify(data), now, now)
    return { id, name, count: data.nodes.length, updatedAt: now }
  }

  saveBoard(id: string, data: BoardData): void {
    this.run('UPDATE boards SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), Date.now(), id)
  }

  renameBoard(id: string, name: string): void {
    if (name.trim()) this.run('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?', name.trim(), Date.now(), id)
  }

  deleteBoard(id: string): void {
    this.run('DELETE FROM boards WHERE id = ?', id)
  }

  boardItemIds(id: string): string[] {
    const b = this.get<{ data: string }>('SELECT data FROM boards WHERE id = ?', id)
    if (!b) return []
    return [...new Set((JSON.parse(b.data) as BoardData).nodes.filter((n) => n.itemId).map((n) => n.itemId!))]
  }

  itemsLite(ids: string[]): ItemLite[] {
    const out: ItemLite[] = []
    for (const part of chunks(ids)) {
      if (part.length) out.push(...this.all<ItemLite>(`SELECT ${LITE} FROM items i WHERE i.id IN (${marks(part.length)})`, ...part))
    }
    return out
  }

  // ---------- folders ----------

  folders(): Folder[] {
    return this.all<Omit<Folder, 'autoTags' | 'pinned' | 'sortDesc' | 'showSub' | 'locked'> & {
      autoTags: string
      pinned: number
      sortDesc: number
      showSub: number
      locked: number
    }>(
      `SELECT f.id, f.name, f.parent_id AS parentId, f.sort, f.color, f.icon, f.auto_tags AS autoTags,
        f.pinned, f.sort_key AS sortKey, f.sort_desc AS sortDesc, f.show_sub AS showSub,
        (f.password IS NOT NULL) AS locked,
        (SELECT COUNT(*) FROM item_folders x JOIN items i ON i.id = x.item_id
         WHERE x.folder_id = f.id AND i.deleted_at IS NULL) AS count
       FROM folders f ORDER BY f.sort, f.name COLLATE NOCASE`
    ).map((f) => ({
      ...f,
      autoTags: JSON.parse(f.autoTags) as string[],
      pinned: !!f.pinned,
      sortDesc: !!f.sortDesc,
      showSub: !!f.showSub,
      locked: !!f.locked
    }))
  }

  updateFolder(id: string, p: FolderPatch): void {
    const sets: string[] = []
    const params: Param[] = []
    const put = (col: string, v: Param) => {
      sets.push(`${col} = ?`)
      params.push(v)
    }
    if (p.color !== undefined) put('color', p.color)
    if (p.icon !== undefined) put('icon', p.icon)
    if (p.autoTags !== undefined) put('auto_tags', JSON.stringify([...new Set(p.autoTags.map(normalizeTag).filter(Boolean))]))
    if (p.pinned !== undefined) put('pinned', p.pinned ? 1 : 0)
    if (p.sortKey !== undefined) put('sort_key', p.sortKey)
    if (p.sortDesc !== undefined) put('sort_desc', p.sortDesc ? 1 : 0)
    if (p.showSub !== undefined) put('show_sub', p.showSub ? 1 : 0)
    if (sets.length) this.run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
  }

  /** Stores a salted SHA-256 of the password (null removes it). */
  setFolderPassword(id: string, password: string | null): void {
    if (!password) return this.run('UPDATE folders SET password = NULL WHERE id = ?', id)
    const salt = randomUUID()
    const hash = createHash('sha256').update(salt + password).digest('hex')
    this.run('UPDATE folders SET password = ? WHERE id = ?', `${salt}:${hash}`, id)
  }

  checkFolderPassword(id: string, password: string): boolean {
    const row = this.get<{ password: string | null }>('SELECT password FROM folders WHERE id = ?', id)
    if (!row?.password) return true
    const [salt, hash] = row.password.split(':')
    return createHash('sha256').update(salt + password).digest('hex') === hash
  }

  /** The folder plus all of its descendants, parents before children. */
  folderTree(id: string): Folder[] {
    const all = this.folders()
    const out: Folder[] = []
    const walk = (fid: string) => {
      const f = all.find((x) => x.id === fid)
      if (!f) return
      out.push(f)
      all.filter((c) => c.parentId === fid).forEach((c) => walk(c.id))
    }
    walk(id)
    return out
  }

  folderItemIds(folderId: string): string[] {
    return this.all<{ id: string }>(
      `SELECT x.item_id AS id FROM item_folders x JOIN items i ON i.id = x.item_id
       WHERE x.folder_id = ? AND i.deleted_at IS NULL`,
      folderId
    ).map((r) => r.id)
  }

  /** Copies a folder subtree (structure, appearance, item membership — not the files themselves). */
  duplicateFolder(id: string): Folder | null {
    const tree = this.folderTree(id)
    if (!tree.length) return null
    const map = new Map<string, string>()
    this.tx(() => {
      for (const f of tree) {
        const parent = f.id === id ? f.parentId : map.get(f.parentId!)!
        const created = this.createFolder(f.id === id ? `${f.name} (копия)` : f.name, parent ?? null)
        map.set(f.id, created.id)
        this.updateFolder(created.id, { color: f.color, icon: f.icon, autoTags: f.autoTags, sortKey: f.sortKey, sortDesc: f.sortDesc, showSub: f.showSub })
        const ins = this.db.prepare('INSERT OR IGNORE INTO item_folders (item_id, folder_id) VALUES (?, ?)')
        for (const item of this.folderItemIds(f.id)) ins.run(item, created.id)
      }
    })
    return this.folders().find((f) => f.id === map.get(id)) ?? null
  }

  /** Raw rows for copying items into another library. */
  itemRows(ids: string[]): Record<string, Param>[] {
    const out: Record<string, Param>[] = []
    for (const part of chunks(ids)) if (part.length) out.push(...this.all<Record<string, Param>>(`SELECT * FROM items WHERE id IN (${marks(part.length)})`, ...part))
    return out
  }

  insertRawItem(row: Record<string, Param>, tags: string[], vec: Uint8Array | null): void {
    const cols = Object.keys(row)
    this.run(`INSERT INTO items (${cols.join(', ')}) VALUES (${marks(cols.length)})`, ...cols.map((c) => row[c]))
    const ins = this.db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag, auto) VALUES (?, ?, 0)')
    for (const t of tags) ins.run(row.id as string, t)
    if (vec) this.run('INSERT OR REPLACE INTO item_vectors (item_id, model, vec) VALUES (?, ?, ?)', row.id as string, 'copied', vec)
  }

  itemVector(id: string): Uint8Array | null {
    return this.get<{ vec: Uint8Array }>('SELECT vec FROM item_vectors WHERE item_id = ?', id)?.vec ?? null
  }

  itemTagNames(id: string): string[] {
    return this.all<{ tag: string }>('SELECT tag FROM item_tags WHERE item_id = ?', id).map((t) => t.tag)
  }

  createFolder(name: string, parentId: string | null): Folder {
    const id = randomUUID()
    const { s } = this.get<{ s: number }>(
      'SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM folders WHERE parent_id IS ?',
      parentId
    )!
    this.run(
      'INSERT INTO folders (id, name, parent_id, sort, created_at) VALUES (?, ?, ?, ?, ?)',
      id, name.trim() || 'Новая папка', parentId, s, Date.now()
    )
    return { id, name, parentId, sort: s, count: 0, color: null, icon: null, autoTags: [], pinned: false, sortKey: null, sortDesc: true, showSub: true, locked: false }
  }

  renameFolder(id: string, name: string): void {
    if (name.trim()) this.run('UPDATE folders SET name = ? WHERE id = ?', name.trim(), id)
  }

  deleteFolder(id: string): void {
    this.run('DELETE FROM folders WHERE id = ?', id)
  }

  moveFolder(id: string, parentId: string | null): void {
    if (id === parentId) return
    // Refuse to move a folder into one of its own descendants.
    let cur = parentId
    while (cur) {
      if (cur === id) return
      cur = this.get<{ parent_id: string | null }>('SELECT parent_id FROM folders WHERE id = ?', cur)?.parent_id ?? null
    }
    this.run('UPDATE folders SET parent_id = ? WHERE id = ?', parentId, id)
  }

  addToFolder(ids: string[], folderId: string): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO item_folders (item_id, folder_id) VALUES (?, ?)')
    this.tx(() => {
      for (const id of ids) stmt.run(id, folderId)
    })
    const auto = this.get<{ t: string }>('SELECT auto_tags AS t FROM folders WHERE id = ?', folderId)
    const tags = auto ? (JSON.parse(auto.t) as string[]) : []
    if (tags.length) this.addTags(ids, tags)
  }

  removeFromFolder(ids: string[], folderId: string): void {
    this.tx(() => this.eachIds(ids, 'DELETE FROM item_folders WHERE folder_id = ? AND item_id IN (%IDS%)', folderId))
  }

  // ---------- tags ----------

  tags(): TagCount[] {
    return this.all<TagCount>(
      `SELECT t.tag AS name, COUNT(*) AS count FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE i.deleted_at IS NULL GROUP BY t.tag ORDER BY t.tag COLLATE NOCASE`
    )
  }

  renameTag(from: string, to: string): void {
    const target = normalizeTag(to)
    if (!target || target === from) return
    this.tx(() => {
      this.run('UPDATE OR IGNORE item_tags SET tag = ? WHERE tag = ?', target, from)
      // Only a case change keeps the same key, so leftovers exist only when merging into another tag.
      if (target.toLowerCase() !== from.toLowerCase()) this.run('DELETE FROM item_tags WHERE tag = ?', from)
    })
  }

  deleteTag(name: string): void {
    this.run('DELETE FROM item_tags WHERE tag = ?', name)
  }

  counts(): Counts {
    // SUM() over an empty table yields NULL, hence the `?? 0` below.
    const c = this.get<Partial<Record<keyof Counts, number | null>>>(
      `SELECT
        SUM(deleted_at IS NULL) AS "all",
        SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_folders x WHERE x.item_id = items.id)) AS uncategorized,
        SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)) AS untagged,
        SUM(deleted_at IS NOT NULL) AS trash
       FROM items`
    )
    return { all: c?.all ?? 0, uncategorized: c?.uncategorized ?? 0, untagged: c?.untagged ?? 0, trash: c?.trash ?? 0 }
  }
}
