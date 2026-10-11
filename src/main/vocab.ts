/**
 * Auto-tag vocabulary. CLIP understands English, so each Russian tag has an English prompt.
 * Within a group labels compete (softmax), so every group needs enough alternatives —
 * `tag: null` entries are "none of the above" sinks that absorb probability without producing a tag.
 */
export interface VocabLabel {
  tag: string | null
  prompt: string
}

export interface VocabGroup {
  name: string
  /** Maximum number of tags taken from the group. */
  max: number
  /** Minimum softmax probability for a label to become a tag. */
  min: number
  labels: VocabLabel[]
}

const L = (tag: string | null, prompt: string): VocabLabel => ({ tag, prompt })

export const VOCAB: VocabGroup[] = [
  {
    name: 'subject',
    max: 3,
    min: 0.12,
    labels: [
      L('портрет', 'a portrait of a person'),
      L('люди', 'a group of people'),
      L('ребёнок', 'a photo of a child'),
      L('руки', 'a close-up of hands'),
      L('кошка', 'a photo of a cat'),
      L('собака', 'a photo of a dog'),
      L('птица', 'a photo of a bird'),
      L('лошадь', 'a photo of a horse'),
      L('насекомое', 'a photo of an insect'),
      L('рыба', 'a photo of fish underwater'),
      L('животное', 'a photo of a wild animal'),
      L('еда', 'a photo of food'),
      L('напиток', 'a photo of a drink'),
      L('цветы', 'a photo of flowers'),
      L('растения', 'a photo of plants and leaves'),
      L('лес', 'a photo of a forest'),
      L('горы', 'a photo of mountains'),
      L('море', 'a photo of the sea or ocean'),
      L('пляж', 'a photo of a beach'),
      L('озеро', 'a photo of a lake or river'),
      L('небо', 'a photo of the sky and clouds'),
      L('закат', 'a photo of a sunset'),
      L('снег', 'a snowy winter landscape'),
      L('пустыня', 'a photo of a desert'),
      L('поле', 'a photo of a field or meadow'),
      L('пейзаж', 'a landscape photo'),
      L('город', 'a photo of a city'),
      L('улица', 'a photo of a street'),
      L('архитектура', 'a photo of architecture'),
      L('здание', 'a photo of a building'),
      L('интерьер', 'a photo of an interior room'),
      L('мебель', 'a photo of furniture'),
      L('автомобиль', 'a photo of a car'),
      L('мотоцикл', 'a photo of a motorcycle'),
      L('самолёт', 'a photo of an airplane'),
      L('корабль', 'a photo of a ship or boat'),
      L('поезд', 'a photo of a train'),
      L('гаджет', 'a photo of an electronic device'),
      L('компьютер', 'a photo of a computer'),
      L('одежда', 'a fashion photo of clothing'),
      L('обувь', 'a photo of shoes'),
      L('украшения', 'a photo of jewelry'),
      L('косметика', 'a photo of cosmetics'),
      L('продукт', 'a product photo on a plain background'),
      L('книга', 'a photo of a book'),
      L('типографика', 'typography and lettering'),
      L('логотип', 'a logo design'),
      L('иконки', 'a set of icons'),
      L('интерфейс', 'a screenshot of a user interface'),
      L('веб-сайт', 'a screenshot of a website'),
      L('мобильное приложение', 'a screenshot of a mobile app'),
      L('инфографика', 'an infographic with charts'),
      L('постер', 'a poster design'),
      L('карта', 'a map'),
      L('персонаж', 'a character design'),
      L('робот', 'a robot'),
      L('оружие', 'a weapon'),
      L('космос', 'outer space with planets and stars'),
      L('огонь', 'fire and flames'),
      L('вода', 'water'),
      L('абстракция', 'abstract art'),
      L('узор', 'a seamless pattern'),
      L('текстура', 'a close-up texture'),
      L('градиент', 'a smooth color gradient'),
      L(null, 'an image'),
      L(null, 'a photo')
    ]
  },
  {
    name: 'style',
    max: 1,
    min: 0.3,
    labels: [
      L('фото', 'a photograph'),
      L('иллюстрация', 'a digital illustration'),
      L('3D', 'a 3D render'),
      L('аниме', 'an anime drawing'),
      L('пиксель-арт', 'pixel art'),
      L('скетч', 'a pencil sketch'),
      L('акварель', 'a watercolor painting'),
      L('живопись', 'an oil painting'),
      L('вектор', 'flat vector graphics'),
      L('скриншот', 'a screenshot'),
      L('концепт-арт', 'concept art'),
      L('коллаж', 'a collage'),
      L('low-poly', 'low poly 3D art'),
      L('чертёж', 'a technical drawing or blueprint')
    ]
  },
  {
    name: 'mood',
    max: 1,
    min: 0.35,
    labels: [
      L('ночь', 'a photo taken at night'),
      L('неон', 'neon lights'),
      L('тёмное', 'a dark, low-key image'),
      L('светлое', 'a bright, high-key image'),
      L('чёрно-белое', 'a black and white image'),
      L('пастель', 'soft pastel colors'),
      L('минимализм', 'a minimalist composition'),
      L('винтаж', 'a vintage retro image'),
      L(null, 'an ordinary image'),
      L(null, 'a colorful image'),
      L(null, 'a normal photo in daylight')
    ]
  }
]

/** Colour tag from the extracted palette: the dominant saturated colour, if any. */
export function colorTag(palette: { hex: string; ratio: number }[]): string | null {
  for (const c of palette) {
    if (c.ratio < 0.25) continue
    const n = parseInt(c.hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    if (s < 0.25 || l < 0.12 || l > 0.92) continue
    let h = 0
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
    if (h >= 15 && h < 45 && l < 0.4) return 'коричневый'
    if (h < 15 || h >= 340) return 'красный'
    if (h < 40) return 'оранжевый'
    if (h < 65) return 'жёлтый'
    if (h < 160) return 'зелёный'
    if (h < 195) return 'бирюзовый'
    if (h < 255) return 'синий'
    if (h < 290) return 'фиолетовый'
    return 'розовый'
  }
  return null
}
