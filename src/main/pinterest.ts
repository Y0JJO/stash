import sharp from 'sharp'

/**
 * Pinterest visual search ("find similar"). Uses the same public endpoint as Pinterest's own browser
 * extension: upload an image, get similar pins back. Works without logging in.
 */
const ENDPOINT = 'https://api.pinterest.com/v3/visual_search/extension/image/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export interface PinResult {
  id: string
  title: string
  /** ~474px wide preview for the grid. */
  thumb: string
  /** Largest size the API reports (originals are tried first when saving). */
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

interface RawPin {
  id?: string
  title?: string
  description?: string
  grid_title?: string
  domain?: string
  is_video?: boolean
  image_medium_url?: string
  image_large_url?: string
  image_medium_size_pixels?: { width: number; height: number }
  image_large_size_pixels?: { width: number; height: number }
}

export async function pinterestSearch(file: string, bookmark?: string | null): Promise<PinPage> {
  // Pinterest only needs a modest image; smaller uploads are much faster.
  const jpeg = await sharp(file, { animated: false, limitInputPixels: false })
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer()

  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'image.jpg')
  for (const [k, v] of Object.entries({ x: '0', y: '0', w: '1', h: '1', page_size: '60' })) form.append(k, v)

  const url = bookmark ? `${ENDPOINT}?bookmark=${encodeURIComponent(bookmark)}` : ENDPOINT
  const res = await fetch(url, { method: 'PUT', body: form, headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Pinterest ответил ${res.status}`)
  const body = (await res.json()) as { status?: string; data?: RawPin[]; bookmark?: string }
  if (body.status !== 'success') throw new Error('Pinterest вернул ошибку')

  const results = (body.data ?? [])
    .filter((p) => p.id && (p.image_medium_url || p.image_large_url))
    .map((p) => {
      const size = p.image_large_size_pixels ?? p.image_medium_size_pixels ?? { width: 0, height: 0 }
      const title = [p.title, p.grid_title, p.description].map((s) => s?.trim()).find(Boolean) ?? ''
      return {
        id: p.id!,
        title,
        thumb: p.image_medium_url ?? p.image_large_url!,
        large: p.image_large_url ?? p.image_medium_url!,
        width: size.width,
        height: size.height,
        pinUrl: `https://www.pinterest.com/pin/${p.id}/`,
        domain: p.domain && p.domain !== 'Uploaded by user' ? p.domain : '',
        isVideo: !!p.is_video
      }
    })
  return { results, bookmark: body.bookmark && body.bookmark !== '-end-' ? body.bookmark : null }
}

/** Download candidates for a pin, best first: /originals/ (jpg or png), then the large preview. */
export function pinCandidates(pin: Pick<PinResult, 'large' | 'thumb'>): string[] {
  const orig = pin.large.replace(/\/\d+x\//, '/originals/')
  const swap = orig.endsWith('.jpg') ? orig.replace(/\.jpg$/, '.png') : orig.replace(/\.png$/, '.jpg')
  return [...new Set([orig, swap, pin.large, pin.thumb])]
}
