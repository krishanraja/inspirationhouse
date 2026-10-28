// The fixed vocabularies of the Rejections engine: what a rejection is about (theme), which maker it is for (format),
// and how strongly he said it. Like the signals vocabulary (src/signal/vocab.ts), a slug is always called the same
// thing, so the floor can be counted, and a new slug arrives by pull request, never from a model at run time.
//
// The format is the unit a session works in (Krish, 2026-10-27: "I want a modular engine that has a full raft of
// creative strategy, branding and content production experts in there for every possible format"): a session making a
// short video reads the short video's floor. Changing what a slug means, or how a record is mapped to one, is a new
// RULES_REV, which files every record again as a new version.

export const RULES_REV = 'rules-v1'

export type RuleKind = 'form' | 'subject' | 'workflow'

export interface Theme {
  label: string
  /** The taste layer (content-engine taste_layers) a standard of this theme sits in, when one fits. */
  layer: string | null
  kind: RuleKind
  /** content-engine config/media-standard.json known_failure_classes, where this theme is one of them. */
  failureClass: string | null
  /** Matches the dump's theme text (data/themes.md), which names each theme in words. */
  match: RegExp
}

export const THEMES = {
  decorative_motion: { label: 'Motion that decorates, not explains', layer: 'editing', kind: 'form', failureClass: 'decorative_motion', match: /^motion that decorates/i },
  clipart_generic: { label: 'Clipart, generic and boring visuals', layer: 'graphics', kind: 'form', failureClass: 'generic_clipart', match: /^clipart|generic.*visuals/i },
  words_on_screen: { label: 'Words on screen', layer: 'graphics', kind: 'form', failureClass: 'narration_duplication', match: /^words on screen/i },
  layout: { label: 'Layout, composition and alignment', layer: 'graphics', kind: 'form', failureClass: 'tiny_labels', match: /^layout|composition/i },
  brand: { label: 'Brand applied wrong', layer: 'graphics', kind: 'form', failureClass: 'missing_brand', match: /^brand applied/i },
  edit_av: { label: 'Edit and A/V defects', layer: 'editing', kind: 'form', failureClass: 'clipped_speech', match: /^edit and a\/v/i },
  camera: { label: 'Camera and footage treatment', layer: 'camerawork', kind: 'form', failureClass: null, match: /^camera|footage treatment/i },
  packaging: { label: 'Packaging and titles', layer: 'packaging', kind: 'form', failureClass: null, match: /^packaging and titles/i },
  unclear_copy: { label: "Copy a stranger can't follow", layer: 'breakdown', kind: 'form', failureClass: null, match: /^copy a stranger/i },
  predictions_framing: { label: 'Predictions and framing', layer: 'close', kind: 'form', failureClass: null, match: /^predictions and framing/i },
  structure: { label: 'Structure: intros, outros, duplicate sequences', layer: 'structure', kind: 'form', failureClass: null, match: /^structure/i },
  whole_cut: { label: 'Whole cut rejected', layer: 'production', kind: 'form', failureClass: null, match: /^whole cut/i },
  voice_tone: { label: 'Voice and tone', layer: 'tone', kind: 'form', failureClass: null, match: /^voice and tone/i },
  // What a piece is about. Kept as records; never a standard and never used to judge (anti-echo).
  story_angle: { label: 'Story angle and takeaways', layer: null, kind: 'subject', failureClass: null, match: /^story angle/i },
  // How a session worked with him: the workflow floor, never mixed into production counts.
  process: { label: 'How sessions work with him', layer: null, kind: 'workflow', failureClass: null, match: /^process$/i },
  // What he liked in the same breath: the boundary a maker must not cross back over.
  liked: { label: 'Liked nearby', layer: null, kind: 'form', failureClass: null, match: /^liked$/i },
  other: { label: 'Not yet placed', layer: null, kind: 'form', failureClass: null, match: /$^/ },
} as const satisfies Record<string, Theme>

export type ThemeSlug = keyof typeof THEMES

export function themeOf(text: unknown): ThemeSlug {
  const t = typeof text === 'string' ? text.trim() : ''
  for (const [slug, theme] of Object.entries(THEMES) as Array<[ThemeSlug, Theme]>) {
    if (theme.match.test(t)) return slug
  }
  return 'other'
}

// Each maker a session can be. A record can be for several; 'all' means every production format.
export const FORMATS = {
  short_video: 'The 9:16 short cut (Shorts, Reels, TikTok, LinkedIn), camera or voiceover',
  long_video: 'The 16:9 long cut (YouTube, Substack): the deep cut and the 5-minute cut',
  captions: 'Burned-in captions and subtitles',
  motion: 'Motion design and animation inside a video',
  card: 'On-screen cards, title cards, chapter cards and comparison graphics',
  intro_outro: 'The intro sting, the outro, the end card and the brand mark on them',
  audio: 'Music, loudness, voice and the joins between takes',
  cover: 'Substack covers, share images and channel art',
  thumbnail: 'Video thumbnails, wide and vertical',
  title: 'Titles, headlines and the words on covers and thumbnails',
  carousel: 'LinkedIn and Instagram carousels',
  article: 'The article and its images',
  script: 'Recording scripts, lines and what is said',
  prediction: 'The prediction and the verdict a piece closes on',
  site: 'The makeyourmindup site',
  board: 'The publish board, the workroom and Control Center surfaces he uses',
  session: 'How a session works with him: asking, finishing, cost, approvals',
  pipeline: 'The production pipeline, its tools and its checks',
  all: 'Every production format',
  other: 'Not yet placed',
} as const

export type FormatSlug = keyof typeof FORMATS

// The dump's format text is free (about 100 shapes for 191 records). Each rule adds a format when it matches; the
// order does not matter. Nothing that matches no rule is guessed: it is 'other', counted, and the next rule arrives by
// pull request.
const FORMAT_RULES: Array<[RegExp, FormatSlug[]]> = [
  [/\b(short|9\s*[:x]\s*16|tall|vertical|reel|shorts|90[- ]?s(ec(ond)?)?)\b/i, ['short_video']],
  [/\b(long|16\s*[:x]\s*9|wide|deep[- ]cut|5[- ]minute|13[- ]minute|3[- ]minute|youtube video)\b/i, ['long_video']],
  [/\bvoice[- ]?over|\bvo\b|faceless/i, ['short_video', 'long_video']],
  [/\bcaption|subtitle|\bsrt\b/i, ['captions']],
  [/\bmotion\b|animat/i, ['motion']],
  [/\bcards?\b|graphic|chapter|heading|on-screen text|key frames?|still plates?|style frame|stills?\b|pictures?|visuals|imagery/i, ['card']],
  [/\bsting\b|\bintro\b|\boutro\b|end card|brand mark|wordmark/i, ['intro_outro']],
  [/\bmusic\b|audio|loudness|\bsound\b|\bjoin/i, ['audio']],
  [/\bcover/i, ['cover']],
  [/thumbnail/i, ['thumbnail']],
  [/\btitles?\b|headline/i, ['title']],
  [/carousel/i, ['carousel']],
  [/article|substack post/i, ['article']],
  [/script|teleprompter|recording|\blines?\b|narration/i, ['script']],
  [/prediction|verdict/i, ['prediction']],
  [/\bsite\b|website|homepage/i, ['site']],
  [/board|workroom|ideas tab|control center|web board|idea card/i, ['board']],
  [/session|claude code|reply|question|cost|working files|post-mortem|test design|packaging round/i, ['session']],
  [/pipeline|engine|\bve\b|speech-edit|production process|method/i, ['pipeline']],
  [/^\s*(all|all video formats|video|videos|n\/a)\s*$/i, ['all']],
  [/\bvideo\b|edit style/i, ['short_video', 'long_video']],
  [/narrative|story-first/i, ['script']],
  [/visual-first|\bstudy\b/i, ['card']],
  [/publish manager|sign-off sheet/i, ['board']],
]

// The specialists a defect belongs to even when the format text names only the cut: a garbled caption is the captions'
// floor, a chopped word the audio's, wherever it showed. Read from the record's item (the compiler's description).
const ITEM_RULES: Array<[RegExp, FormatSlug]> = [
  [/\bcaption|subtitle/i, 'captions'],
  [/\bmusic\b|loudness|lufs|chopped|clipped speech|clipping|\bjoins?\b|lip[- ]?sync|a\/v sync|\baudio\b/i, 'audio'],
  [/\bmotion\b|animat/i, 'motion'],
  [/\bsting\b|\boutro\b|\bintro\b|end card|end mark|brand mark|wordmark/i, 'intro_outro'],
]

// The craft his own words can name. FORMAT_RULES read the compiler's format field, where "short" or "story-first" is a
// format; in a sentence of his, "video", "story", "line", "question" or "cost" names nothing a maker owns. So his words
// count as naming a craft only by these, and a card is a made card, never the inspiration card a report is about.
const CRAFT_RULES: Array<[RegExp, FormatSlug]> = [
  [/\bcaptions?\b|subtitles?/i, 'captions'],
  [/\bmusic\b|loudness|\blufs\b|\bsound\b|\baudio\b|\bjoins?\b|lip[- ]?sync|chopped|clipped|voice[- ]?over|\bvo\b/i, 'audio'],
  [/\bmotion\b|animat/i, 'motion'],
  [/\bsting\b|\bintro\b|\boutro\b|end card|wordmark|brand mark/i, 'intro_outro'],
  [/thumbnail/i, 'thumbnail'],
  [/\b(?:the|a|this|that) cover\b|\bcover (?:image|art|frame|photo|design)/i, 'cover'],
  [/carousel/i, 'carousel'],
  [/\bgraphics?\b|title card|chapter card|on-screen text|\bfont\b|typeface|lower third/i, 'card'],
  [/\bscript\b|teleprompter/i, 'script'],
  [/\bheadline\b/i, 'title'],
]

/** The crafts his own words name, if any: a short, closed list, never a format inferred from what he talks about. */
export function craftNamed(words: unknown): FormatSlug[] {
  const text = typeof words === 'string' ? words : ''
  return [...new Set(CRAFT_RULES.filter(([re]) => re.test(text)).map(([, slug]) => slug))].sort()
}

/** The formats a record is for, from its format text, and failing that from what it is about. Never empty. */
export function formatsOf(format: unknown, fallback: { category?: unknown; theme?: ThemeSlug; item?: unknown } = {}): FormatSlug[] {
  const text = typeof format === 'string' ? format : ''
  const found = new Set<FormatSlug>()
  for (const [rule, slugs] of FORMAT_RULES) if (rule.test(text)) slugs.forEach(s => found.add(s))
  const item = typeof fallback.item === 'string' ? fallback.item : ''
  if (fallback.theme !== 'process' && fallback.theme !== 'story_angle') {
    for (const [rule, slug] of ITEM_RULES) if (rule.test(item)) found.add(slug)
  }
  if (!found.size) {
    // Nothing in the format text: what the record is about decides, and only where it is unambiguous.
    const theme = fallback.theme
    if (theme === 'packaging') found.add('title')
    else if (theme === 'predictions_framing') found.add('prediction')
    else if (theme === 'voice_tone' || theme === 'unclear_copy') found.add('script')
    else if (theme === 'process') found.add('session')
  }
  if (found.size > 1) found.delete('all')
  return found.size ? [...found].sort() : ['other']
}

export type Strength = 'hated' | 'disliked' | 'rejected' | 'ruled_out' | 'endorsed' | 'liked' | 'unstated'

export function strengthOf(text: unknown): Strength {
  const t = typeof text === 'string' ? text.trim().toLowerCase() : ''
  if (t === 'hated') return 'hated'
  if (t === 'disliked') return 'disliked'
  if (t === 'rejected') return 'rejected'
  if (t === 'ruled out') return 'ruled_out'
  if (t.startsWith('endorsed')) return 'endorsed'
  if (t === 'liked') return 'liked'
  return 'unstated'
}

/**
 * The groups a standard is drafted in: one model call each, so the standards for a maker are read together. A record
 * joins every group one of its formats is in.
 */
export const FORMAT_GROUPS: Record<string, readonly FormatSlug[]> = {
  video_edit: ['short_video', 'long_video', 'captions', 'audio'],
  motion_and_cards: ['motion', 'card', 'intro_outro'],
  packaging: ['cover', 'thumbnail', 'title'],
  words: ['script', 'article', 'prediction', 'carousel'],
  surfaces: ['site', 'board'],
  workflow: ['session', 'pipeline'],
  everything: ['all', 'other'],
}
