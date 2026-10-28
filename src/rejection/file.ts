import { DRIVE } from '../config.ts'
import { contentHash } from '../hash.ts'
import { clip } from '../evidence.ts'
import { folderVenture, type Venture } from '../venture.ts'
import type { DumpRecord } from './dump.ts'
import {
  RULES_REV, THEMES, formatsOf, strengthOf, themeOf, type FormatSlug, type RuleKind, type Strength, type ThemeSlug,
} from './vocab.ts'

// Pure: a dump record in, his quotes and one record version out. Nothing here reads a file, a database or a model.
//
// The stable unit is his words. A quote is keyed by its normalised text and the day he said it, so the same thing he
// said is one quote however many records quote it, and a dump renumbered by a later merge pass files nothing twice. A
// record is keyed by the quotes it rests on (and its category), never by the dump's R id; a record with no quote of
// his is keyed by its date, piece and item, and is never his words.

export type Attribution = 'krish_words' | 'krish_action' | 'observation'
export type Kind = 'rejected' | 'liked' | 'process'
export type Capture = 'still' | 'moment' | 'whole_cut' | 'words'
export type QuoteSource = 'cloud' | 'codex' | 'local' | 'repo' | 'other_account' | 'session_report' | 'capture' | 'unknown'

export interface QuoteRow {
  key: string
  text: string
  saidAt: string
  precision: 'day' | 'second'
  saidWhere: string
  source: QuoteSource
  attribution: Attribution
}

export interface MasterRef {
  /** folder: a copy inside the Rejections folder (path). drive_path: a Drive-for-desktop path (H:\My Drive\...).
   *  drive_id: a master a capture named by its Drive id. */
  where: 'folder' | 'drive_path' | 'drive_id' | 'local' | 'gone'
  ref: string
}

export interface MediaPlan {
  /** Paths inside the Rejections folder: stills of the rejected thing (screenshots, covers, cards). */
  stills: string[]
  /** Paths inside the Rejections folder: six-frame strips already made of a video. */
  strips: string[]
  masters: MasterRef[]
  /** Files the manifest names that are not media (a rejected script in git, a receipt). */
  texts: number
}

export interface Moment { ms: number | null; anchor: 'start' | 'end' | null; origin: 'krish' | 'record' | 'anchor' }

export interface RecordRow {
  source: 'drive_dump' | 'inbox' | 'session_report'
  sourceRef: string
  version: string
  kind: Kind
  rejectedAt: string
  quoteKeys: string[]
  attribution: Attribution
  item: string | null
  reason: string | null
  wantedInstead: string | null
  strength: Strength
  theme: ThemeSlug
  formats: FormatSlug[]
  ruleKind: RuleKind
  capture: Capture
  piece: string | null
  media: MediaPlan
  moment: Moment | null
  meta: Record<string, unknown>
  /** Whose floor this record is for (src/venture.ts), kept out of its version: a dump record is its folder's, a capture
   *  its inbox row's, a report its report's. */
  venture: Venture
}

/** The text a quote is keyed and matched by: the same words, whatever their quote marks, spacing or case. */
export function normaliseWords(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function quoteKey(text: string, day: string): string {
  return contentHash(`${normaliseWords(text)}|${day}`)
}

const SOURCE_LABEL: Record<QuoteSource, string> = {
  cloud: 'a Claude Code cloud session',
  codex: 'a Codex session',
  local: 'a Claude Code session on his computer',
  repo: 'a content-engine repository record of his words',
  other_account: 'a Claude Code cloud session on his other account',
  session_report: 'a session report',
  capture: 'a session capture',
  unknown: 'a session',
}

export function quoteSourceOf(source: unknown): QuoteSource {
  const s = typeof source === 'string' ? source.trim().toLowerCase() : ''
  if (s === 'cloud') return 'cloud'
  if (s === 'codex') return 'codex'
  if (s === 'local') return 'local'
  if (s === 'repo') return 'repo'
  if (s.startsWith('other-account') || s.startsWith('other_account')) return 'other_account'
  return 'unknown'
}

/** When he said it: a moment to the second where the record gives one, else the day, at noon UTC. */
export function saidAtOf(when: unknown, fallbackDay: string): { at: string; day: string; precision: 'day' | 'second' } | null {
  const w = typeof when === 'string' ? when.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}T/.test(w) && realDay(w.slice(0, 10))) {
    const d = new Date(w)
    if (!Number.isNaN(d.getTime())) return { at: d.toISOString(), day: d.toISOString().slice(0, 10), precision: 'second' }
  }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : /^\d{4}-\d{2}-\d{2}/.exec(fallbackDay)?.[0] ?? null
  if (!day || !realDay(day)) return null
  return { at: `${day}T12:00:00.000Z`, day, precision: 'day' }
}

// V8 reads 2026-02-30 as 2 March rather than refusing it, and Postgres refuses it: a day must survive the round trip.
function realDay(day: string): boolean {
  const d = new Date(`${day}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day
}

// An approval of a session's own critique (a short yes, "all recommended", picking an option a session marked
// Recommended) is his action, not his words about what was wrong: the reason is the session's.
const APPROVAL = /^(yes\b|yep\b|all recommended|signed\b|confirmed\b|approved?\b|agreed\b|ok\b|okay\b|go\b)|\(recommended\)\s*\.?$/i

/**
 * Whether the record holds his words verbatim. The compiler marked each record's confidence: 'krish verbatim' and
 * 'direct quote' are his words as typed (as a learning's `krish` field is, src/collect/gitTaste.ts); a record that is
 * only a 'paraphrased ruling', a 'compaction summary' or an 'endorsed critique' holds no words of his.
 */
export function verbatimRecord(confidence: unknown): boolean {
  return typeof confidence === 'string' && /krish verbatim|direct quote/i.test(confidence)
}

export function quoteAttribution(text: string, verbatim: boolean): Attribution {
  if (!verbatim) return 'observation'
  return text.trim().length <= 40 && APPROVAL.test(text.trim()) ? 'krish_action' : 'krish_words'
}

export function quotesOf(r: DumpRecord): QuoteRow[] {
  const verbatim = verbatimRecord(r.confidence)
  const out: QuoteRow[] = []
  const seen = new Set<string>()
  for (const q of r.quotes) {
    const text = q.text.trim()
    if (!text) continue
    const said = saidAtOf(q.when, r.date)
    if (!said) continue
    const key = quoteKey(text, said.day)
    if (seen.has(key)) continue
    seen.add(key)
    const source = quoteSourceOf(q.source)
    const piece = clip(r.piece, 200)
    out.push({
      key, text, saidAt: said.at, precision: said.precision,
      saidWhere: clip(`${SOURCE_LABEL[source]}${piece ? `, on ${piece}` : ''}`, 300) ?? SOURCE_LABEL[source],
      source, attribution: quoteAttribution(text, verbatim),
    })
  }
  return out
}

export function attributionOf(quotes: QuoteRow[]): Attribution {
  if (quotes.some(q => q.attribution === 'krish_words')) return 'krish_words'
  if (quotes.some(q => q.attribution === 'krish_action')) return 'krish_action'
  return 'observation'
}

// A fault that holds across a whole cut, with no single moment to cut a clip around: an absence, a length, a style
// everywhere. Never a bare "all" or "every", which a quoted line can hold ("answered all the").
const WHOLE_CUT = /\b(all (four|three|two|the) (cuts|videos)|every (video|cut|frame)|whole|throughout|too few|not enough|nowhere near|almost no|no visible|no (burned-in )?captions|(no|without) (licensed )?music|missing|absent|loudness|lufs|house (edit )?style|in (absolutely )?everything|as a whole|as produced|scrapped|killed|tropes|cuts? running \d+|\d+ to \d+ s\b)/i
// A ruling on how things are made (a proposal, a rule, a format, something not delivered) has no frame to keep: his
// words are the record.
const RULING = /\b(proposal|proposed|instead of a carousel|delivered|first-person)\b|\brule\b(?! that)|^(the (weekly )?\d+[- ]minute|cutting|applying|empty comment|bog-standard)\b/i
// A caption is a still when what is wrong is what it says or how it looks; when it lags it is a moment.
const CAPTION_SEEN = /\bcaptions?\b/i
const CAPTION_TIMED = /\b(sync|lag|timing|drift|late|early)\b/i

/**
 * How the defect is kept (rules-v1). The words are the asset for copy; a still shows a visual, a brand, a layout, a
 * framing or the words on screen; a fault in time (a join, sync, a flash, motion, an outro) needs a clip around its
 * moment; and a fault across the whole cut points at the master.
 */
export function captureOf(r: DumpRecord, kind: Kind, theme: ThemeSlug, media: MediaPlan): Capture {
  if (kind === 'process') return 'words'
  const category = (r.category ?? '').toLowerCase()
  const item = r.item ?? ''
  const where = `${item} ${r.format ?? ''}`
  if (kind === 'liked') return media.stills.length || media.strips.length ? 'still' : 'words'
  if (theme === 'whole_cut') return 'whole_cut'
  if (theme === 'words_on_screen') return category.startsWith('copy') && !/on-screen|screen|image|visual|microcopy|card|carousel/i.test(where) ? 'words' : 'still'
  if (category.startsWith('copy')) return 'words'
  if (category.startsWith('visual') || category.startsWith('brand')) {
    return WHOLE_CUT.test(item) && /\b(videos?|cuts?|pieces?|everything)\b/i.test(where) ? 'whole_cut' : 'still'
  }
  if (RULING.test(item)) return 'words'
  if (WHOLE_CUT.test(item) && (category.startsWith('motion') || category.startsWith('audio') || /\b(videos?|cuts?|pieces?|everything)\b/i.test(where))) return 'whole_cut'
  if (CAPTION_SEEN.test(item) && !CAPTION_TIMED.test(item)) return 'still'
  if (theme === 'camera') return /\b(shak|stabili|wobbl)/i.test(item) ? 'moment' : 'still'
  if (category.startsWith('component')) {
    if (theme === 'edit_av' || theme === 'decorative_motion') return 'moment'
    if (theme === 'structure' && /\b(too short|last frame|sequences?|sting|duplicate|chaotic|(two|three) .{0,20}(intros?|outros?|screens?))\b/i.test(item)) return 'moment'
    return 'still'
  }
  if (category.startsWith('motion') || category.startsWith('audio')) return 'moment'
  return 'words'
}

const IMAGE = /\.(jpe?g|png|webp)$/i
const VIDEO = /\.(mp4|mov|mkv|m4v)$/i

/** What the manifest and the record's own asset list say is kept, and where each master is. */
export function mediaOf(r: DumpRecord, manifestFiles: string[]): MediaPlan {
  const plan: MediaPlan = { stills: [], strips: [], masters: [], texts: 0 }
  const masters = new Map<string, MasterRef>()
  const addMaster = (m: MasterRef) => { if (!masters.has(m.ref)) masters.set(m.ref, m) }
  const fromPath = (p: string): MasterRef =>
    /^[A-Z]:\\My Drive\\/i.test(p) ? { where: 'drive_path', ref: p } : { where: 'local', ref: p }
  for (const raw of manifestFiles) {
    const entry = raw.trim()
    const placed = /^(VIDEO KEPT IN PLACE|LEFT IN PLACE|OVERWRITTEN|CLOUD-ONLY):\s*(.*)$/i.exec(entry)
    if (placed) {
      const what = placed[1]!.toUpperCase()
      const path = placed[2]!.trim()
      if (what === 'VIDEO KEPT IN PLACE' && VIDEO.test(path)) addMaster(fromPath(path))
      else if (what === 'OVERWRITTEN' || what === 'CLOUD-ONLY') addMaster({ where: 'gone', ref: path })
      continue
    }
    if (IMAGE.test(entry)) {
      if (/ - frames\.jpe?g$/i.test(entry)) { if (!plan.strips.includes(entry)) plan.strips.push(entry) }
      else if (!plan.stills.includes(entry)) plan.stills.push(entry)
    } else if (VIDEO.test(entry)) addMaster({ where: 'folder', ref: entry })
    else plan.texts++
  }
  for (const a of r.asset_paths) {
    const p = a.path?.trim()
    if (!p || !VIDEO.test(p)) continue
    if (/overwritten|missing/i.test(a.status ?? '')) addMaster({ where: 'gone', ref: p })
    else addMaster(fromPath(p))
  }
  plan.masters = [...masters.values()]
  return plan
}

/**
 * Where in the cut the defect is, when the record says. His own words first ("between 3 and 4 seconds"), then a
 * moment the record names ("at 04:36"), then where he points ("the last frame", "the opening"). Clock times
 * ("8:41 pm") are never moments. Null when nothing says.
 */
export function momentOf(r: DumpRecord, quotes: QuoteRow[]): Moment | null {
  for (const q of quotes) {
    if (q.attribution !== 'krish_words') continue
    const s = secondsIn(q.text)
    if (s !== null) return { ms: s, anchor: null, origin: 'krish' }
  }
  const itemSeconds = secondsIn(r.item ?? '')
  if (itemSeconds !== null) return { ms: itemSeconds, anchor: null, origin: 'record' }
  const said = [...quotes.map(q => q.text), r.item ?? ''].join(' ')
  if (/\b(last frame|final frame|at the end|the ending|end of the (video|cut|short))\b/i.test(said)) return { ms: null, anchor: 'end', origin: 'anchor' }
  if (/\b(first frame|at the start|the opening|opening frame|first seconds?)\b/i.test(said)) return { ms: null, anchor: 'start', origin: 'anchor' }
  return null
}

function secondsIn(text: string): number | null {
  const between = /\bbetween (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?) seconds?\b/i.exec(text)
  if (between) return Math.round(((Number(between[1]) + Number(between[2])) / 2) * 1000)
  const at = /\bat (\d+(?:\.\d+)?) ?(?:s|secs?|seconds?)\b/i.exec(text)
  if (at) return Math.round(Number(at[1]) * 1000)
  const code = /\b(?:at|around|from)\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\b(?!\s*(?:am|pm|a\.m|p\.m))/i.exec(text)
  if (code) return (Number(code[1]) * 60 + Number(code[2])) * 1000 + Number((code[3] ?? '0').padEnd(3, '0'))
  return null
}

function kindOfRecord(kind: Kind, theme: ThemeSlug, category: string | null | undefined): RuleKind {
  if (kind === 'process') return 'workflow'
  // What he liked in copy or a script is what a piece says (its landing, its takeaway, its angle), so it is kept and
  // never served: the floor is form and workflow, never subject (anti-echo). What he liked in a frame, a motion or a
  // sound is form.
  if (kind === 'liked' && /copy|script/i.test(category ?? '')) return 'subject'
  return THEMES[theme].kind
}

const RANK: Record<Attribution, number> = { krish_words: 3, krish_action: 2, observation: 1 }

/**
 * Hold one quote in a read's set, keyed by his words and the day. Where the same quote is classed two ways (by two
 * records, or by the dump and a session's report or capture), his words win over his action, and either over an
 * observation; at the same rank, the one that knows the second wins. So no record of his words ever cites his words
 * through a paraphrase.
 */
export function holdQuote(quotes: Map<string, QuoteRow>, q: QuoteRow): void {
  const held = quotes.get(q.key)
  if (!held || RANK[q.attribution] > RANK[held.attribution]
    || (held.precision === 'day' && q.precision === 'second' && RANK[q.attribution] === RANK[held.attribution])) quotes.set(q.key, q)
}

/**
 * One dump record as quotes and a record version. `collides` says this record's quotes and category are shared with
 * another record in the same read, so its item joins its identity.
 */
export function fileRecord(r: DumpRecord, kind: Kind, manifestFiles: string[], collides = false): { quotes: QuoteRow[]; record: RecordRow } {
  const quotes = quotesOf(r)
  const theme: ThemeSlug = kind === 'liked' ? 'liked' : kind === 'process' ? 'process' : themeOf(r.theme)
  const media = mediaOf(r, manifestFiles)
  const formats = formatsOf(r.format, { category: r.category, theme, item: r.item })
  const capture = captureOf(r, kind, theme, media)
  const quoteKeys = quotes.map(q => q.key).sort()
  const piece = clip(r.piece, 300)
  const item = clip(r.item, 4000)
  const sourceRef = identityOf(kind, r, quoteKeys, collides)
  const day = saidAtOf(null, r.date)?.day
  const earliest = quotes.map(q => q.saidAt).sort()[0]
  const rejectedAt = day ? `${day}T12:00:00.000Z` : earliest ?? new Date(0).toISOString()
  // Whose words it holds is part of the version: a later merge pass that marks his words a paraphrase, or a paraphrase
  // his words, files a new version under the new label and withdraws the old one, so no record keeps a stale label.
  const attribution = attributionOf(quotes)
  const content = {
    k: kind, q: quoteKeys, i: item, r: clip(r.reason, 4000), w: clip(r.wanted_instead, 4000), s: strengthOf(r.strength),
    t: theme, f: formats, c: capture, p: piece, a: rejectedAt, by: attribution, rules: RULES_REV,
  }
  return {
    quotes,
    record: {
      source: 'drive_dump', sourceRef, version: contentHash(content), kind, rejectedAt, quoteKeys,
      attribution, item, reason: content.r, wantedInstead: content.w, strength: content.s,
      theme, formats, ruleKind: kindOfRecord(kind, theme, r.category), capture, piece, media,
      moment: capture === 'moment' ? momentOf(r, quotes) : null,
      meta: {
        dump_id: r.id, category: r.category ?? null, format_text: r.format ?? null, confidence: r.confidence ?? null,
        sources: r.sources, evidence: r.evidence.slice(0, 40), screenshot_files: r.screenshot_files.length,
        asset_paths: r.asset_paths.length,
      },
      venture: folderVenture(DRIVE.rejections),
    },
  }
}

function identityOf(kind: Kind, r: DumpRecord, quoteKeys: string[], collides: boolean): string {
  if (!quoteKeys.length) {
    return `dump:${contentHash({ k: kind, d: r.date.slice(0, 10), p: normaliseWords(r.piece ?? ''), i: normaliseWords(r.item ?? '') }).slice(0, 24)}`
  }
  const base: Record<string, unknown> = { k: kind, q: quoteKeys, c: normaliseWords(r.category ?? '') }
  if (collides) base.i = normaliseWords(r.item ?? '')
  return `dump:${contentHash(base).slice(0, 24)}`
}

export interface Filed {
  quotes: Map<string, QuoteRow>
  records: RecordRow[]
  /** Records whose quotes and item were both shared with another: kept apart by their date and piece. */
  collisions: number
}

/**
 * The whole dump, filed. Two records that rest on the same quotes and category are told apart by their item; a quote
 * shared by several records is one quote. Where the same quote is classed two ways, his words win over his action,
 * and either over an observation.
 */
export function fileDump(dump: { rejected: DumpRecord[]; liked: DumpRecord[]; process: DumpRecord[]; manifest: Map<string, string[]> }): Filed {
  const all: Array<{ r: DumpRecord; kind: Kind }> = [
    ...dump.rejected.map(r => ({ r, kind: 'rejected' as const })),
    ...dump.liked.map(r => ({ r, kind: 'liked' as const })),
    ...dump.process.map(r => ({ r, kind: 'process' as const })),
  ]
  const baseOf = (x: { r: DumpRecord; kind: Kind }) => identityOf(x.kind, x.r, quotesOf(x.r).map(q => q.key).sort(), false)
  const counts = new Map<string, number>()
  for (const x of all) counts.set(baseOf(x), (counts.get(baseOf(x)) ?? 0) + 1)
  const collides = (x: { r: DumpRecord; kind: Kind }) => (counts.get(baseOf(x)) ?? 0) > 1
  // The identity each record gets before ties are broken: its quotes and category, and its item where those collide.
  const filedRefs = all.map(x => identityOf(x.kind, x.r, quotesOf(x.r).map(q => q.key).sort(), collides(x)))
  const shared = new Map<string, number>()
  for (const ref of filedRefs) shared.set(ref, (shared.get(ref) ?? 0) + 1)
  const quotes = new Map<string, QuoteRow>()
  const records: RecordRow[] = []
  const twins = new Map<string, number>()
  let collisions = 0
  for (const x of all) {
    const filed = fileRecord(x.r, x.kind, dump.manifest.get(x.r.id) ?? [], collides(x))
    for (const q of filed.quotes) holdQuote(quotes, q)
    // Records that share their quotes, category and item are told apart by their own content (the day, the piece, the
    // reason and what he wanted instead), so which one a merge pass happens to write first never decides which is which.
    // Only records the same in all of that are numbered, and those are the same record twice.
    let ref = filed.record.sourceRef
    if ((shared.get(ref) ?? 0) > 1) {
      const own = contentHash({ d: x.r.date, p: normaliseWords(x.r.piece ?? ''), r: normaliseWords(x.r.reason ?? ''), w: normaliseWords(x.r.wanted_instead ?? '') }).slice(0, 8)
      const twin = `${ref}:${own}`
      const n = twins.get(twin) ?? 0
      twins.set(twin, n + 1)
      ref = n ? `${twin}:${n}` : twin
      collisions++
    }
    records.push({ ...filed.record, sourceRef: ref })
  }
  return { quotes, records, collisions }
}

/**
 * What he liked nearby (the boundary), for each rejected or process record: a liked quote from the very same message
 * (the same moment, to the second, from the same source), else one about the same piece on the same day.
 */
export function nearOf(records: RecordRow[], quotes: Map<string, QuoteRow>): Map<string, Array<{ key: string; basis: 'same_message' | 'same_piece' }>> {
  // A liked record about what a piece says is never anyone's boundary.
  const liked = records.filter(r => r.kind === 'liked' && r.ruleKind !== 'subject')
  const out = new Map<string, Array<{ key: string; basis: 'same_message' | 'same_piece' }>>()
  for (const r of records) {
    if (r.kind === 'liked') continue
    const moments = new Set(r.quoteKeys.map(k => quotes.get(k)).filter(q => q && q.precision === 'second').map(q => `${q!.source}|${q!.saidAt}`))
    const found = new Map<string, 'same_message' | 'same_piece'>()
    for (const l of liked) {
      for (const k of l.quoteKeys) {
        const q = quotes.get(k)
        if (!q) continue
        if (q.precision === 'second' && moments.has(`${q.source}|${q.saidAt}`)) found.set(k, 'same_message')
        else if (!found.has(k) && r.piece && l.piece && normaliseWords(r.piece) === normaliseWords(l.piece)
          && r.rejectedAt.slice(0, 10) === l.rejectedAt.slice(0, 10)) found.set(k, 'same_piece')
      }
    }
    if (found.size) out.set(r.sourceRef, [...found].map(([key, basis]) => ({ key, basis })).sort((a, b) => a.key.localeCompare(b.key)))
  }
  return out
}
