import type { FetchJson } from '../collect/gitTaste.ts'

// content-engine's own style vocabulary, so a card's reading names what the engine picks from (tag-v4, Krish,
// 2026-11-17: "auto-tag that in a sophisticated manner in a way that the rest of the engine will later pick up on").
// The ids are content-engine's, read at run time through the GitHub API and never edited here (AGENTS.md rule 6):
//   - caption theme ids: the keys of config/caption-themes.json;
//   - motion style ids: the `motion` layer of config/style-references.json's bank;
//   - narrative and production formats: config/style-references.json formats.script and formats.production.
// Transitions, camera and energy live in the renderer's code (apps/renderer kit/ingredients.ts, docs/ve/INGREDIENTS.md),
// not in a config file, so they are pinned here. The series and the roles a card teaches are pinned too: the roles are
// the ones content-engine's /api/inspiration/candidates ranks by, `thumbnail` among them since content-engine's
// migration 20261205090000 (TEACHES_DB_ROLES).
// A pick is a reading of the model's, labelled `engine_read`; an id not in its list is dropped, never stored.

export const CAPTION_THEMES_FILE = 'config/caption-themes.json'
export const STYLE_REFERENCES_FILE = 'config/style-references.json'

export const SERIES = ['follow_the_money', 'mind_the_gap', 'under_the_hood', 'none'] as const
export const TEACHES_ROLES = ['look', 'motion', 'captions', 'hook', 'pacing', 'layout', 'thumbnail'] as const
/**
 * The roles content-engine's `inspiration_items.teaches` takes (its check constraint, migrations
 * 20261122090000_inspiration_teaches_and_card_uses.sql and 20261205090000_inspiration_teaches_thumbnail.sql, which added
 * `thumbnail` for his thumbnail study set; applied 2026-11-17).
 */
export const TEACHES_DB_ROLES = ['look', 'motion', 'captions', 'hook', 'pacing', 'layout', 'thumbnail'] as const

export interface StyleVocab {
  captions: readonly string[]
  motion: readonly string[]
  transitions: readonly string[]
  camera: readonly string[]
  energy: readonly string[]
  script_formats: readonly string[]
  production_formats: readonly string[]
  series: readonly string[]
  teaches: readonly string[]
}

/**
 * The lists as content-engine held them on 2026-11-17 (main 18357d4), for tests and for a run whose read fails. A run
 * on the pinned lists says so in its counts (`style_vocab_pinned`).
 */
export const PINNED_VOCAB: StyleVocab = {
  captions: ['pop', 'karaoke', 'kinetic-01', 'kinetic-02', 'hustle', 'grape', 'beast', 'poppin', 'aarit', 'soft-ai', 'gaming-stream',
    'simple-one-word', 'podcast', 'art-directed', 'cinematic', 'slam', 'georgia-build', 'stair-flash', 'tuck-stack', 'anchor-quote',
    'rack-focus', 'flip-hinge', 'slice', 'slot-roll', 'receipt-chip', 'ink-block', 'mint-word'],
  motion: ['swiss-kinetic-type', 'flat-vector-explainer', 'shape-morph', 'single-line-drawing', 'data-story', 'isometric-world',
    'dark-keynote', 'living-ui', 'ladder', 'living-screen', 'hud-terminal', 'watercolour-ink', 'riso-halftone', 'paper-cutout',
    'line-boil', 'pixel-retro', 'film-crt', 'toy-3d', 'vertical-captions', 'full-visual', 'character-ai-receipts',
    'eating-jobs-ladder', 'ai-music-slam'],
  transitions: ['cut', 'whip', 'push', 'zoom-through', 'flash', 'punch', 'crossfade'],
  camera: ['none', 'drift', 'phased', 'punch'],
  energy: ['calm', 'medium', 'high'],
  script_formats: ['head-to-head', 'fry-explainer', 'follow-the-receipt', 'random-headline', 'everyday-debate', 'the-usable-rule',
    'dated-prediction', 'from-my-own-fleet'],
  production_formats: ['face-with-proof', 'voice-led-pictures', 'data-story', 'fry-talking-head', 'scoreboard-test',
    'kinetic-movement', 'receipt-animation'],
  series: SERIES,
  teaches: TEACHES_ROLES,
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ids = (xs: unknown[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string' && ID.test(x)))]
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The caption theme ids in content-engine's file: its keys, `_about` and any other underscore key aside. */
export function captionIds(raw: unknown): string[] {
  return isObj(raw) ? ids(Object.keys(raw).filter(k => !k.startsWith('_'))) : []
}

/** Motion style ids (the bank's `motion` layer) and the two format lists in content-engine's style references. */
export function styleRefIds(raw: unknown): Pick<StyleVocab, 'motion' | 'script_formats' | 'production_formats'> {
  if (!isObj(raw)) return { motion: [], script_formats: [], production_formats: [] }
  const bank = Array.isArray(raw.bank) ? raw.bank.filter(isObj) : []
  const formats = isObj(raw.formats) ? raw.formats : {}
  const listIds = (v: unknown) => (Array.isArray(v) ? ids(v.map(x => (isObj(x) ? x.id : x))) : isObj(v) ? ids(Object.keys(v)) : [])
  return {
    motion: ids(bank.filter(b => b.layer === 'motion').map(b => b.id)),
    script_formats: listIds(formats.script),
    production_formats: listIds(formats.production),
  }
}

export interface VocabRead { vocab: StyleVocab; live: boolean; pinned: string[] }

/**
 * The vocabulary for this run: each list read from content-engine, and a list whose read fails or comes back empty
 * replaced by its pinned copy, named in `pinned` so the run's counts say so. Never throws.
 */
export async function readStyleVocab(fetchJson: FetchJson): Promise<VocabRead> {
  const [cap, refs] = await Promise.all([
    fetchJson(CAPTION_THEMES_FILE).catch(() => null),
    fetchJson(STYLE_REFERENCES_FILE).catch(() => null),
  ])
  const pinned: string[] = []
  const pick = (name: keyof StyleVocab, live: readonly string[]): readonly string[] => {
    if (live.length) return live
    pinned.push(name)
    return PINNED_VOCAB[name]
  }
  const r = styleRefIds(refs)
  const vocab: StyleVocab = {
    ...PINNED_VOCAB,
    captions: pick('captions', captionIds(cap)),
    motion: pick('motion', r.motion),
    script_formats: pick('script_formats', r.script_formats),
    production_formats: pick('production_formats', r.production_formats),
  }
  return { vocab, live: pinned.length === 0, pinned }
}

/** The style picks as the model returns them: ids only, checked against the run's lists after the answer. */
export interface RawStyle {
  captions: string[]; motion: string[]; transitions: string[]; camera: string[]; energy: string | null
  script_formats: string[]; production_formats: string[]; series: string | null; teaches: string[]
}

export interface StylePicks {
  captions: string[]; motion: string[]; transitions: string[]; camera: string[]; energy: string | null
  script_formats: string[]; production_formats: string[]; series: string | null; teaches: string[]
  origin: 'engine_read'
  /** Which of his words on the card the reading had in front of it; empty for a bare read. */
  grounded_in: string[]
}

/** The model's picks with every id outside its list dropped, and how many were dropped. */
export function stylePicks(raw: Partial<RawStyle> | null | undefined, vocab: StyleVocab, groundedIn: string[]): { picks: StylePicks; dropped: number } {
  let dropped = 0
  const keep = (xs: unknown, allowed: readonly string[], max: number): string[] => {
    const list = Array.isArray(xs) ? xs : []
    const ok = [...new Set(list.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => allowed.includes(x)))]
    dropped += list.length - ok.length
    return ok.slice(0, max)
  }
  const one = (x: unknown, allowed: readonly string[]): string | null => {
    if (x == null) return null
    if (typeof x === 'string' && allowed.includes(x.trim())) return x.trim()
    dropped++
    return null
  }
  const s = raw ?? {}
  return {
    picks: {
      captions: keep(s.captions, vocab.captions, 3),
      motion: keep(s.motion, vocab.motion, 3),
      transitions: keep(s.transitions, vocab.transitions, 3),
      camera: keep(s.camera, vocab.camera, 2),
      energy: one(s.energy, vocab.energy),
      script_formats: keep(s.script_formats, vocab.script_formats, 3),
      production_formats: keep(s.production_formats, vocab.production_formats, 3),
      series: one(s.series, vocab.series),
      teaches: keep(s.teaches, vocab.teaches, TEACHES_ROLES.length),
      origin: 'engine_read',
      grounded_in: groundedIn,
    },
    dropped,
  }
}

/** The roles content-engine's `teaches` column takes, from a card's picks. */
export function dbTeaches(teaches: readonly string[]): string[] {
  return teaches.filter(t => (TEACHES_DB_ROLES as readonly string[]).includes(t))
}

/** The vocabulary as the system prompt lists it. */
export function vocabPrompt(v: StyleVocab): string {
  return [
    'style: what the engine that makes Krish\'s videos could take from it, picked ONLY from these ids (any other word is thrown away). Pick only what the item plainly shows; an empty list or null when nothing fits.',
    `- captions (caption themes, up to 3): ${v.captions.join(', ')}`,
    `- motion (motion styles, up to 3): ${v.motion.join(', ')}`,
    `- transitions (up to 3): ${v.transitions.join(', ')}`,
    `- camera (up to 2): ${v.camera.join(', ')}`,
    `- energy (one, or null): ${v.energy.join(', ')}`,
    `- script_formats (narrative formats, up to 3): ${v.script_formats.join(', ')}`,
    `- production_formats (up to 3): ${v.production_formats.join(', ')}`,
    `- series (one, or null): ${v.series.join(', ')}. follow_the_money is where the money goes, mind_the_gap the gap between the story and what is true, under_the_hood how a thing works.`,
    `- teaches (the roles a cut could learn from it): ${v.teaches.join(', ')}. look is the overall visual style, motion how things move, captions the on-screen words, hook the opening, pacing the rhythm, layout where things sit, thumbnail how a cover or thumbnail is made.`,
  ].join('\n')
}
