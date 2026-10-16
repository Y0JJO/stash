/**
 * Auto-tag vocabulary. CLIP understands English, so each Russian tag has English descriptions; each
 * description goes through the group's templates and the tag's text vector is the average of them all
 * (prompt ensembling — much steadier than a single phrase).
 *
 * Within a group the tags compete (softmax), so a group always has a "winner": `tag: null` entries are
 * generic "none of the above" sinks that win for images the vocabulary doesn't cover, so nothing is tagged.
 * The thresholds were tuned on a real library — keep them strict: a missing tag costs little, a wrong one
 * makes the tag useless for search. After changing them, add a Library migration that resets
 * autotag_state so existing items are re-tagged.
 */
export interface VocabLabel {
  tag: string | null
  /** English descriptions; `{}` in a template is replaced by each of them. */
  d: string[]
}

export interface VocabGroup {
  name: string
  templates: string[]
  /** Minimum softmax probability for a tag. */
  min: number
  /** Besides the winner, other tags must reach this share of the winner's probability. */
  ratio: number
  /** Maximum number of tags taken from the group. */
  max: number
  labels: VocabLabel[]
}

const S = (tag: string | null, ...d: string[]): VocabLabel => ({ tag, d })

const PHOTO = ['a photo of {}.', 'a picture of {}.', 'an image showing {}.', 'a close-up of {}.']
const LOOK = ['{}.', 'an image in the style of {}.']

export const VOCAB: VocabGroup[] = [
  {
    name: 'subject',
    templates: PHOTO,
    min: 0.15,
    ratio: 0.6,
    max: 2,
    labels: [
      S('портрет', 'a person\'s face', 'a portrait of a person', 'a human face'),
      S('люди', 'people', 'a person', 'a group of people'),
      S('ребёнок', 'a child', 'a little kid'),
      S('руки', 'human hands', 'a hand holding something'),
      S('кошка', 'a cat', 'a kitten'),
      S('собака', 'a dog', 'a puppy'),
      S('птица', 'a bird'),
      S('лошадь', 'a horse'),
      S('насекомое', 'an insect', 'a butterfly', 'a bug'),
      S('рыба', 'a fish', 'fish swimming underwater'),
      S('животное', 'a wild animal', 'an animal'),
      S('еда', 'food', 'a dish of food', 'a meal on a plate'),
      S('напиток', 'a drink', 'a cup of coffee', 'a cocktail glass'),
      S('цветы', 'flowers', 'a bouquet of flowers'),
      S('растения', 'plants', 'green leaves'),
      S('лес', 'a forest', 'trees in a forest'),
      S('горы', 'mountains', 'a mountain range'),
      S('море', 'the sea', 'ocean waves', 'a surfer on a wave'),
      S('пляж', 'a sandy beach'),
      S('озеро', 'a lake', 'a river'),
      S('небо', 'the sky with clouds'),
      S('закат', 'a sunset', 'a sunrise sky'),
      S('снег', 'snow', 'a snowy landscape'),
      S('пустыня', 'a desert', 'sand dunes'),
      S('поле', 'a field', 'a meadow'),
      S('город', 'a city', 'a cityscape', 'skyscrapers'),
      S('улица', 'a street', 'a city street'),
      S('архитектура', 'architecture', 'a building facade'),
      S('интерьер', 'an interior of a room', 'an indoor space'),
      S('мебель', 'furniture', 'a chair', 'a sofa'),
      S('автомобиль', 'a car', 'a sports car', 'a car wheel'),
      S('мотоцикл', 'a motorcycle', 'a motorbike', 'a motorcycle fuel tank'),
      S('велосипед', 'a bicycle'),
      S('самолёт', 'an airplane', 'an aircraft'),
      S('корабль', 'a ship', 'a boat'),
      S('поезд', 'a train'),
      S('гаджет', 'an electronic gadget', 'a device with buttons', 'a camera'),
      S('компьютер', 'a computer', 'a laptop', 'a keyboard'),
      S('часы', 'a wristwatch', 'watch parts'),
      S('одежда', 'clothing', 'a fashion outfit', 'fabric'),
      S('обувь', 'shoes', 'a sneaker'),
      S('украшения', 'jewelry', 'a ring', 'a necklace'),
      S('косметика', 'cosmetics', 'makeup products'),
      S('книга', 'a book'),
      S('типографика', 'typography', 'large lettering', 'text in a bold font'),
      S('логотип', 'a logo', 'a brand logo'),
      S('иконки', 'a set of app icons'),
      S('интерфейс', 'a user interface on a screen', 'an app interface with buttons and menus'),
      S('веб-сайт', 'a website page in a browser'),
      S('инфографика', 'an infographic with charts'),
      S('постер', 'a poster', 'a graphic poster design'),
      S('карта', 'a map'),
      S('персонаж', 'a cartoon character', 'a game character'),
      S('робот', 'a robot', 'a humanoid robot'),
      S('оружие', 'a weapon', 'a gun', 'a sword'),
      S('космос', 'outer space', 'planets and stars'),
      S('огонь', 'fire', 'flames'),
      S('абстракция', 'abstract art', 'abstract shapes'),
      S('узор', 'a seamless repeating pattern'),
      S('текстура', 'a texture', 'a surface texture close-up'),
      S('градиент', 'a smooth color gradient background'),
      // sinks: generic content that is not worth a tag
      S(null, 'something'), S(null, 'an object'), S(null, 'a scene'), S(null, 'a thing'), S(null, 'stuff'),
      S(null, 'a random image'), S(null, 'a blurry image'), S(null, 'a dark image'), S(null, 'a colorful image')
    ]
  },
  {
    name: 'style',
    templates: LOOK,
    min: 0.7,
    ratio: 1,
    max: 1,
    labels: [
      S('фото', 'a real photograph', 'a camera photo'),
      S('иллюстрация', 'a digital illustration', 'a drawing'),
      S('3D', 'a 3D render', 'computer generated 3D graphics', 'CGI'),
      S('аниме', 'anime art'),
      S('пиксель-арт', 'pixel art', '8-bit pixel graphics'),
      S('скетч', 'a pencil sketch'),
      S('акварель', 'a watercolor painting'),
      S('живопись', 'an oil painting'),
      S('вектор', 'flat vector graphics'),
      S('скриншот', 'a screenshot of a computer screen', 'a screen capture of software'),
      S('концепт-арт', 'concept art'),
      S('коллаж', 'a collage of several pictures'),
      S('low-poly', 'low poly geometric 3D art'),
      S('чертёж', 'a technical blueprint drawing')
    ]
  },
  {
    name: 'mood',
    templates: LOOK,
    min: 0.6,
    ratio: 1,
    max: 1,
    labels: [
      S('ночь', 'a scene at night'),
      S('неон', 'glowing neon lights'),
      S('тёмное', 'a very dark low-key image'),
      S('светлое', 'a bright white high-key image'),
      S('чёрно-белое', 'a black and white image'),
      S('пастель', 'soft pastel colors'),
      S('минимализм', 'a minimalist composition with lots of empty space'),
      S('винтаж', 'a vintage retro photo'),
      S(null, 'an ordinary image'), S(null, 'a colorful image'), S(null, 'a normal photo in daylight'), S(null, 'an image')
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
