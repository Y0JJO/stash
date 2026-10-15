/**
 * Miro's own clipboard format: an HTML `<span data-meta="<--(miro-data-v1)…(/miro-data-v1)-->">`
 * whose payload is base64 of UTF-8 JSON with every byte shifted by +59. Image widgets only
 * reference pictures already uploaded to Miro (`resource.id`), so we can't create new ones —
 * but we can move and resize the ones the user copied in Miro and hand them back.
 */

const SHIFT = 59
const RE = /\(miro-data-v1\)([A-Za-z0-9+/=]+)\(\/miro-data-v1\)/

export interface MiroImage {
  widgetData: {
    json: {
      _position: { offsetPx: { x: number; y: number }; schema?: string; containerType?: string }
      _parent?: { index: number } | null
      scale: { scale: number }
      relativeScale?: number
      relativeRotation?: number
      rotation?: { rotation: number }
      crop?: { width: number; height: number }
      resource?: { name?: string; width: number; height: number }
    }
    type: string
  }
}

export interface MiroClip {
  boardId?: string
  data: { objects: MiroImage[] }
  [k: string]: unknown
}

export function decodeMiroHtml(html: string): MiroClip | null {
  const m = RE.exec(html)
  if (!m) return null
  const bytes = Buffer.from(m[1], 'base64').map((b) => (b - SHIFT + 256) % 256)
  return JSON.parse(Buffer.from(bytes).toString('utf8'))
}

export function encodeMiroHtml(clip: MiroClip): string {
  const bytes = Buffer.from(JSON.stringify(clip), 'utf8').map((b) => (b + SHIFT) % 256)
  return `<span data-meta="<--(miro-data-v1)${Buffer.from(bytes).toString('base64')}(/miro-data-v1)-->"></span>`
}

export interface LayoutEntry {
  /** 1-based number the file name starts with ("007 name.png"). */
  n: number
  cx: number
  cy: number
  w: number
  h: number
  /** Index into the frames list of the frame holding this picture. */
  frame?: number
}

/** A frame to create in Miro (centre and size in the same pixels as the layout). */
export interface FrameEntry {
  name: string
  fill?: string | null
  cx: number
  cy: number
  w: number
  h: number
}

/** Moves one Miro image widget to a layer's place and size (rotation is baked into the picture). */
function place(j: MiroImage['widgetData']['json'], l: LayoutEntry, frames: FrameEntry[] = []) {
  const scale = l.w / (j.crop?.width ?? j.resource!.width)
  const f = l.frame !== undefined ? frames[l.frame] : undefined
  if (f) {
    // Inside a frame: offsets are from the frame's top-left corner and point at it by index
    // (frames are put first in the object list).
    j._parent = { index: l.frame! }
    j._position = { offsetPx: { x: l.cx - (f.cx - f.w / 2), y: l.cy - (f.cy - f.h / 2) }, schema: 'parentOffsetPx', containerType: 'FRAME' }
  } else {
    j._parent = null
    j._position = { offsetPx: { x: l.cx, y: l.cy }, schema: 'canvasOffsetPx' }
  }
  j.scale = { scale }
  if (!j._parent) j.relativeScale = scale
  j.rotation = { rotation: 0 }
  j.relativeRotation = 0
}

/**
 * Puts every copied image whose file name starts with a layer number at that layer's place and
 * size (Miro offsets are centres relative to the selection's centre). Returns how many matched.
 */
export function arrangeMiroClip(clip: MiroClip, layout: LayoutEntry[]): number {
  const byN = new Map(layout.map((l) => [l.n, l]))
  let matched = 0
  for (const o of clip.data.objects) {
    const j = o.widgetData?.json
    const num = /^(\d{3}) /.exec(j?.resource?.name ?? '')
    const l = num && byN.get(Number(num[1]))
    if (!j || !l) continue
    place(j, l)
    matched++
  }
  return matched
}

/**
 * Images pasted into Miro from our HTML lose their names ("image.jpg"), but keep the order and
 * proportions. Matches them to the layout by aspect ratio (ties go by clipboard order) and
 * arranges them — only when the set is exactly ours: same count, every ratio within 2%.
 */
export function arrangeMiroClipByShape(clip: MiroClip, layout: LayoutEntry[], frames: FrameEntry[] = []): boolean {
  const objs = clip.data.objects.filter((o) => o.widgetData?.type === 'image' && o.widgetData.json?.resource)
  if (!layout.length || objs.length !== clip.data.objects.length || objs.length !== layout.length) return false
  const ratio = (w: number, h: number) => Math.log(w / h)
  const free = objs.map((o) => {
    const j = o.widgetData.json
    return { j, r: ratio(j.crop?.width ?? j.resource!.width, j.crop?.height ?? j.resource!.height) }
  })
  const pairs: [MiroImage['widgetData']['json'], LayoutEntry][] = []
  for (const l of layout) {
    const r = ratio(l.w, l.h)
    let best = -1
    for (let i = 0; i < free.length; i++) if (best < 0 || Math.abs(free[i].r - r) < Math.abs(free[best].r - r) - 1e-9) best = i
    if (Math.abs(free[best].r - r) > 0.02) return false
    pairs.push([free[best].j, l])
    free.splice(best, 1)
  }
  for (const [j, l] of pairs) place(j, l, frames)
  if (frames.length) {
    const meta = (clip.data.objects[0] as unknown as { meta?: unknown }).meta
    const frameObjs = frames.map((f, i) => frameObject(f, i, clip.boardId, meta))
    clip.data.objects = [...frameObjs, ...clip.data.objects]
    clip.data.objects.forEach((o, i) => ((o as unknown as { id: number }).id = i))
  }
  return true
}

/** "#rrggbb" → Miro's colour int; anything else (our translucent default) → white like Miro's own frames. */
const colorInt = (c?: string | null) => (c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : 0xffffff)

/** A Miro frame widget in the shape Miro itself puts on the clipboard. */
function frameObject(f: FrameEntry, i: number, boardId: string | undefined, meta: unknown): MiroImage {
  const json = {
    type: 12,
    prevFrameIndex: -1,
    x: 0,
    y: 0,
    width: f.w,
    height: f.h,
    style: JSON.stringify({ fs: 14, tc: 6052956, ta: 'l', ff: 5, ss: 4, sc: 16777215, bc: colorInt(f.fill), fo: 2, fd: 0 }),
    text: f.name || 'Frame',
    boardId,
    isClusteringContainer: false,
    speakerNotes: null,
    coldStartType: null,
    _parent: null,
    _position: { offsetPx: { x: f.cx, y: f.cy }, schema: 'canvasOffsetPx' },
    rotation: { rotation: 0 },
    scale: { scale: 1 },
    relativeRotation: 0,
    relativeScale: 1,
    size: { width: f.w, height: f.h }
  }
  return { widgetData: { json, type: 'frame' }, type: 14, id: i, meta } as unknown as MiroImage
}
