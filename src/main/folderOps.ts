import fs from 'node:fs'
import path from 'node:path'
import { zip, type Zippable } from 'fflate'
import { Library } from './library'

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || '_'

/** Relative path ("Parent/Child") of every folder in the subtree, rooted at the folder itself. */
function treePaths(lib: Library, rootId: string): Map<string, string> {
  const tree = lib.folderTree(rootId)
  const out = new Map<string, string>()
  for (const f of tree) out.set(f.id, f.id === rootId ? safe(f.name) : path.join(out.get(f.parentId!)!, safe(f.name)))
  return out
}

/** Unique file name inside a directory listing we keep in memory. */
function unique(used: Set<string>, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

/** Every file of the subtree with the relative path it should get in an export. */
function exportPlan(lib: Library, rootId: string): { src: string; rel: string }[] {
  const plan: { src: string; rel: string }[] = []
  for (const [fid, rel] of treePaths(lib, rootId)) {
    const used = new Set<string>()
    for (const id of lib.folderItemIds(fid)) {
      const it = lib.getItem(id)
      if (!it || !fs.existsSync(it.path)) continue
      plan.push({ src: it.path, rel: path.join(rel, unique(used, `${safe(it.name)}.${it.ext}`)) })
    }
  }
  return plan
}

export async function exportFolderToDir(lib: Library, folderId: string, destDir: string): Promise<{ files: number; dir: string }> {
  const plan = exportPlan(lib, folderId)
  for (const p of plan) {
    const dest = path.join(destDir, p.rel)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.copyFile(p.src, dest)
  }
  return { files: plan.length, dir: path.join(destDir, treePaths(lib, folderId).get(folderId)!) }
}

export async function exportFolderToZip(lib: Library, folderId: string, zipFile: string): Promise<number> {
  const plan = exportPlan(lib, folderId)
  const files: Zippable = {}
  // Media is already compressed — store it (level 0) to keep exports fast.
  for (const p of plan) files[p.rel.split(path.sep).join('/')] = [new Uint8Array(await fs.promises.readFile(p.src)), { level: 0 }]
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(files, (err, out) => (err ? reject(err) : resolve(out))))
  await fs.promises.writeFile(zipFile, data)
  return plan.length
}

/**
 * Copies a folder subtree into another Stash library: folders (with their look), files, thumbnails,
 * tags, notes, ratings and image vectors. Items that already exist there (same content hash) are reused.
 */
export async function copyFolderToLibrary(lib: Library, folderId: string, otherRoot: string): Promise<number> {
  if (path.resolve(otherRoot) === path.resolve(lib.root)) throw new Error('Это та же библиотека')
  const other = new Library(otherRoot)
  try {
    const tree = lib.folderTree(folderId)
    const map = new Map<string, string>()
    let copied = 0
    for (const f of tree) {
      const created = other.createFolder(f.name, f.id === folderId ? null : map.get(f.parentId!)!)
      map.set(f.id, created.id)
      other.updateFolder(created.id, { color: f.color, icon: f.icon, autoTags: f.autoTags, sortKey: f.sortKey, sortDesc: f.sortDesc, showSub: f.showSub })

      for (const row of lib.itemRows(lib.folderItemIds(f.id))) {
        const id = row.id as string
        const existing = row.hash ? other.findByHash(row.hash as string) : null
        if (existing) {
          other.addToFolder([existing.id], created.id)
          continue
        }
        const src = path.join(lib.root, 'files', row.file as string)
        if (!fs.existsSync(src)) continue
        const dest = path.join(other.root, 'files', row.file as string)
        await fs.promises.mkdir(path.dirname(dest), { recursive: true })
        await fs.promises.copyFile(src, dest)
        const thumb = lib.thumbPath(id)
        if (thumb && fs.existsSync(thumb)) await fs.promises.copyFile(thumb, other.thumbPath(id)!)
        else row.thumb_state = 0
        other.insertRawItem({ ...row, deleted_at: null }, lib.itemTagNames(id), lib.itemVector(id))
        other.addToFolder([id], created.id)
        copied++
      }
    }
    return copied
  } finally {
    other.close()
  }
}
