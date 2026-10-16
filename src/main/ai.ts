import fs from 'node:fs'
import sharp from 'sharp'
import type { Library } from './library'
import { colorTag, VOCAB } from './vocab'
import type { AiStatus } from '../shared/types'

export const CLIP_MODEL = 'Xenova/clip-vit-base-patch16'

type Transformers = typeof import('@huggingface/transformers')

function normalize(v: ArrayLike<number>): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  s = Math.sqrt(s) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Lazily loaded CLIP image + text encoders (downloaded once into `cacheDir`). */
export class Clip {
  private loading: Promise<void> | null = null
  private tf!: Transformers
  private processor!: Awaited<ReturnType<Transformers['AutoProcessor']['from_pretrained']>>
  private vision!: Awaited<ReturnType<Transformers['CLIPVisionModelWithProjection']['from_pretrained']>>
  private tokenizer!: Awaited<ReturnType<Transformers['AutoTokenizer']['from_pretrained']>>
  private text!: Awaited<ReturnType<Transformers['CLIPTextModelWithProjection']['from_pretrained']>>

  constructor(
    private cacheDir: string,
    private onProgress: (fraction: number) => void
  ) {}

  load(): Promise<void> {
    this.loading ??= this.doLoad().catch((e) => {
      this.loading = null
      throw e
    })
    return this.loading
  }

  private async doLoad(): Promise<void> {
    this.tf = await import('@huggingface/transformers')
    this.tf.env.cacheDir = this.cacheDir
    // Aggregate download progress over all model files.
    const files = new Map<string, { loaded: number; total: number }>()
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file || !p.total) return
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      this.onProgress(total ? loaded / total : 0)
    }
    const opts = { dtype: 'q8' as const, progress_callback }
    this.processor = await this.tf.AutoProcessor.from_pretrained(CLIP_MODEL, { progress_callback })
    this.tokenizer = await this.tf.AutoTokenizer.from_pretrained(CLIP_MODEL, { progress_callback })
    this.vision = await this.tf.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, opts)
    this.text = await this.tf.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, opts)
  }

  async embedImage(file: string): Promise<Float32Array> {
    const { data, info } = await sharp(file).removeAlpha().resize(224, 224, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true })
    const image = new this.tf.RawImage(new Uint8ClampedArray(data), info.width, info.height, 3)
    const { image_embeds } = await this.vision(await this.processor(image))
    return normalize(image_embeds.data as Float32Array)
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const inputs = this.tokenizer(texts, { padding: true, truncation: true })
    const { text_embeds } = await this.text(inputs)
    const dim = text_embeds.dims[1] as number
    const data = text_embeds.data as Float32Array
    return texts.map((_, i) => normalize(data.subarray(i * dim, (i + 1) * dim)))
  }
}

interface GroupVectors {
  min: number
  ratio: number
  max: number
  tags: (string | null)[]
  vecs: Float32Array[]
}

/** The average of several unit vectors, back on the unit sphere. */
function mean(vecs: Float32Array[]): Float32Array {
  const sum = new Float32Array(vecs[0].length)
  for (const v of vecs) for (let i = 0; i < v.length; i++) sum[i] += v[i]
  return normalize(sum)
}

/** Background queue: embeds each thumbnail with CLIP and assigns tags from the vocabulary. */
export class AutoTagger {
  private queue: string[] = []
  private queued = new Set<string>()
  private running = false
  private stopped = false
  private groups: GroupVectors[] | null = null
  private done = 0
  private tagged: string[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private lib: Library,
    private clip: Clip,
    private ev: { onStatus(s: AiStatus): void; onTagged(ids: string[]): void },
    public enabled: boolean
  ) {}

  stop(): void {
    this.stopped = true
    this.queue = []
  }

  enqueuePending(): void {
    this.enqueue(this.lib.pendingAutotagIds())
  }

  enqueue(ids: string[]): void {
    for (const id of ids) {
      if (this.queued.has(id)) continue
      this.queued.add(id)
      this.queue.push(id)
    }
    void this.run()
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (on) this.enqueuePending()
    else this.ev.onStatus({ phase: 'idle' })
  }

  private async run(): Promise<void> {
    if (this.running || !this.enabled || this.stopped || !this.queue.length) return
    this.running = true
    try {
      this.ev.onStatus({ phase: 'loading', progress: 0 })
      await this.clip.load()
      this.groups ??= await this.embedVocab()
      this.done = 0
      while (this.queue.length && this.enabled && !this.stopped) {
        this.ev.onStatus({ phase: 'working', done: this.done, total: this.done + this.queue.length })
        const id = this.queue.shift()!
        this.queued.delete(id)
        await this.tagOne(id)
        this.done++
      }
      if (!this.stopped) this.ev.onStatus({ phase: 'idle' })
    } catch (err) {
      console.error('[ai] failed', err)
      this.ev.onStatus({ phase: 'error', message: (err as Error).message })
    } finally {
      this.running = false
      this.flush()
    }
  }

  private async embedVocab(): Promise<GroupVectors[]> {
    const out: GroupVectors[] = []
    for (const g of VOCAB) {
      const vecs: Float32Array[] = []
      for (const l of g.labels) {
        const prompts = l.d.flatMap((d) => g.templates.map((t) => t.replace('{}', d)))
        vecs.push(mean(await this.clip.embedTexts(prompts)))
      }
      out.push({ min: g.min, ratio: g.ratio, max: g.max, tags: g.labels.map((l) => l.tag), vecs })
    }
    return out
  }

  private async tagOne(id: string): Promise<void> {
    const job = this.lib.autotagJob(id)
    if (!job || !fs.existsSync(job.thumb)) return
    try {
      const vec = await this.clip.embedImage(job.thumb)
      if (this.stopped) return
      const tags = this.classify(vec)
      const color = colorTag(job.palette)
      if (color) tags.push(color)
      this.lib.setAutoTags(id, tags, vec, CLIP_MODEL)
      this.tagged.push(id)
      this.timer ??= setTimeout(() => this.flush(), 400)
    } catch (err) {
      if (this.stopped) return
      console.warn('[ai] tagging failed', id, (err as Error).message)
      this.lib.setAutotagFailed(id)
    }
  }

  private classify(vec: Float32Array): string[] {
    const tags: string[] = []
    for (const g of this.groups!) {
      // CLIP logit scale is 100; softmax within the group.
      const logits = g.vecs.map((v) => 100 * dot(v, vec))
      const m = Math.max(...logits)
      const ex = logits.map((l) => Math.exp(l - m))
      const z = ex.reduce((a, b) => a + b, 0)
      const ranked = ex.map((e, i) => ({ tag: g.tags[i], p: e / z })).sort((a, b) => b.p - a.p)
      // A sink on top means the image is outside this group's vocabulary.
      const top = ranked[0]
      if (!top.tag || top.p < g.min) continue
      ranked
        .filter((x): x is { tag: string; p: number } => x.tag !== null && x.p >= g.min && x.p >= g.ratio * top.p)
        .slice(0, g.max)
        .forEach((x) => tags.push(x.tag))
    }
    return [...new Set(tags)]
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.tagged.length) this.ev.onTagged(this.tagged.splice(0))
  }
}
