import type { Db } from '../db.ts'
import { contentHash, stableJson } from '../hash.ts'
import { FLOOR_VENTURE, type Venture } from '../venture.ts'
import { FORMATS, THEMES, type FormatSlug } from './vocab.ts'
import { NEVERS, SORT_REV, sortStandard } from './layers.ts'

// The floor as one file, config/rejection-floor.json in content-engine, where every production session reads it
// (scripts/floor.py prints it by format). Krish, 2026-10-28: "The text records alone are under 1 MB, small enough to
// sit in the repo where every session reads them." Deterministic: the same floor always renders the same bytes, and
// its version is their hash, so a review receipt can bind to the floor it checked against.
//
// content-engine is public. The file carries his words (as config/learnings.json already does) and nothing else of
// his: no PC path, no Drive path or id, no session id, no email (content-engine NOW.md never_publish). Media are
// named by sha256 only. scrub() takes them out of the compiler's text, and
// assertPublic() refuses to render a file that still holds one.

export const FLOOR_FILE = 'config/rejection-floor.json'

export interface StandardRow {
  id: string; fingerprint: string; formats: string[]; theme: string; layer: string | null; kind: string
  standing: 'approved' | 'reworded' | 'draft'; statement: string; how_to_check: string; krish: string | null
  support_n: number; action_n: number; quote_ids: string[]; record_refs: string[]; boundary_quote_ids: string[]
  decided_at: string | null
}
export interface RecordViewRow {
  source: string; source_ref: string; kind: string; rejected_at: string; theme: string; formats: string[]
  rule_kind: string; capture: string; piece: string | null; item: string | null; wanted_instead: string | null
  strength: string; quote_ids: string[]; near: Array<{ quote_id: string; basis: string }>; media_sha256: string[]
  pointed: boolean; moment_ms: number | null
}
export interface QuoteViewRow { id: string; text: string; attribution: string; said_at: string }
export interface MediaViewRow { sha256: string; role: string; mime: string; bytes: number; at_ms: number | null; derived_from: string | null }

/** One venture's floor (FLOOR_VENTURE): its standards, its records, and only the quotes and media its records hold. */
export async function loadFloor(db: Db, venture: Venture = FLOOR_VENTURE): Promise<{ standards: StandardRow[]; records: RecordViewRow[]; quotes: QuoteViewRow[]; media: MediaViewRow[] }> {
  const standards = await db.query<StandardRow>(
    `select id::text, fingerprint, formats, theme, layer, kind, standing, statement, how_to_check, krish, support_n, action_n,
            quote_ids::text[] as quote_ids, record_refs, boundary_quote_ids::text[] as boundary_quote_ids, decided_at::text
     from public.taste_floor where venture = $1 order by fingerprint`,
    [venture],
  )
  const records = await db.query<RecordViewRow>(
    `select source, source_ref, kind, rejected_at::text, theme, formats, rule_kind, capture, piece, item, wanted_instead, strength,
            quote_ids::text[] as quote_ids, near, media_sha256, (master_drive_id is not null) as pointed, moment_ms
     from public.taste_rejections
     where venture = $1 and withdrawn_at is null and rule_kind in ('form', 'workflow')
     order by rejected_at, source, source_ref`,
    [venture],
  )
  const quotes = await db.query<QuoteViewRow>(
    `select q.id::text, q.text, q.attribution, q.said_at::text from public.taste_rejection_quotes q
     where exists (select 1 from public.taste_rejections r where r.venture = $1 and r.withdrawn_at is null and r.rule_kind in ('form', 'workflow')
                   and (q.id = any(r.quote_ids) or r.near @> jsonb_build_array(jsonb_build_object('quote_id', q.id::text))))`,
    [venture],
  )
  const media = await db.query<MediaViewRow>(
    `select m.sha256, m.role, m.mime, octet_length(m.bytes)::int as bytes, m.at_ms, m.derived_from
     from public.taste_rejection_media m
     where exists (select 1 from public.taste_rejections r where r.venture = $1 and r.withdrawn_at is null and m.sha256 = any(r.media_sha256))`,
    [venture],
  )
  return { standards, records, quotes, media }
}

// Paths on his machines and in Drive for desktop, Drive and Docs links, Drive-id-shaped tokens, session ids and emails.
// A path may hold spaces ("H:\My Drive\..."), so it runs to the end of its line, a quote or bracket, a comma or
// semicolon, two spaces, " (" or " - ", or the space after a file extension; whichever comes first. Either slash, any
// drive letter's case. Overreach is safe: only what is shown is cut (AGENTS.md rule 9), never what is stored.
const PATH_END = String.raw`(?=[,;)\]"'\n<>|]|\s{2}|$|\s\(|\s-\s|(?<=\.[A-Za-z0-9]{2,5})\s)`
const WIN_PATH = new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\n"<>|]*?${PATH_END}`, 'gm')
const DRIVE_PATH = new RegExp(String.raw`\bMy Drive[\\/][^\n"<>|]*?${PATH_END}`, 'gmi')
const HOME_PATH = /(?<![\w.:/~-])\/(?:Users|home|Volumes|mnt|media)\/[^\s"'<>|),;]*/gi
const LINK = /(?:https?:\/\/)?(?:drive|docs)\.google\.com[^\s"')]*|(?:https?:\/\/)?\bclaude\.ai\/[^\s"')]*/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SESSION = /\b(?:cse|session)_[A-Za-z0-9]{8,}[A-Za-z0-9_-]*/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// Drive ids: today's start with 1; a file from before 2015 with 0B, a shared drive with 0A.
const DRIVE_ID = /\b(?:1[A-Za-z0-9_-]{24,43}|0[AB][A-Za-z0-9_-]{15,42})\b/g

// What a public floor file may never hold, by name: the last check before publishing, and scrub's last pass.
const PUBLIC_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\bMy Drive[\\/]|(?<![\w.:/~-])\/(?:Users|home|Volumes|mnt|media)\//i],
  ['link', /(?:drive|docs)\.google\.com|\bclaude\.ai\//],
  ['id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['session', /\b(?:cse|session)_[A-Za-z0-9]{8,}/],
  // A Drive id is mixed case with - or _; the floor's own lowercase hex (its version) is not one.
  ['drive id', /\b(?:1(?=[A-Za-z0-9_-]*[A-Z_-])[A-Za-z0-9_-]{24,43}|0[AB][A-Za-z0-9_-]{15,42})\b/],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
]
const LAST_PASS = PUBLIC_CHECKS.map(([name, re]) =>
  [new RegExp(String.raw`\S*(?:${re.source})\S*`, re.flags.includes('i') ? 'gi' : 'g'), `[${name === 'drive id' ? 'id' : name}]`] as const)

/**
 * The compiler's text, with anything that is not for a public file taken out. Pure. It takes out at least everything
 * assertPublic refuses, since a quote and a proposed standard never change: a miss here would block every render. The
 * patterns above cut a path or link and keep the sentence around it; the last pass cuts whatever word still holds
 * anything the last check refuses.
 */
export function scrub(text: string | null): string | null {
  if (text === null) return null
  let out = text.replace(LINK, '[link]').replace(WIN_PATH, '[path]').replace(DRIVE_PATH, '[path]').replace(HOME_PATH, '[path]')
    .replace(UUID, '[id]').replace(SESSION, '[session]').replace(EMAIL, '[email]').replace(DRIVE_ID, '[id]')
  for (const [re, mark] of LAST_PASS) out = out.replace(re, mark)
  return out
}

/** Throws when the rendered file still holds a path, a Drive link, an id or an email. Never publish past this. */
export function assertPublic(text: string): void {
  for (const [name, re] of PUBLIC_CHECKS) {
    if (re.test(text)) throw new Error(`floor render: the file would hold a ${name}`)
  }
}

const day = (iso: string) => iso.slice(0, 10)
const shortRef = (source: string, ref: string) => `r${contentHash(`${source}:${ref}`).slice(0, 10)}`
const CHECK_BY: Record<string, string> = {
  approved: 'the engine, approved by him with the statement',
  reworded: 'the engine, a draft: he reworded the statement, not this check',
  draft: 'the engine, a draft he has not seen',
}
const WORDS_LABEL: Record<string, string> = { krish_words: 'his words', krish_action: 'his approval', observation: 'a paraphrase, not his words' }

/**
 * A pattern is a complaint he made about more than one production; a one-off is about one. Krish, 2026-10-28: "find
 * patterns, so we can cement certain rejections as much being more critical to follow than a one off complaint about
 * one production." A production is a record's piece, or its day when it names none. Patterns come first everywhere the
 * floor is read, and only patterns are put to him (src/rejection/propose.ts, which counts productions the same way).
 */
export const FLOOR_PATTERN_MIN = 2

/** The production a record is about: its piece, case and spacing aside, or its day when it names none. */
export function productionOf(r: { piece: string | null; rejected_at: string }): string {
  const piece = (r.piece ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return piece || `day:${r.rejected_at.slice(0, 10)}`
}

export interface RenderInput {
  standards: StandardRow[]; records: RecordViewRow[]; quotes: QuoteViewRow[]; media: MediaViewRow[]
}

/** The whole floor, rendered. Pure and deterministic. */
export function renderFloor(input: RenderInput): string {
  const quotes = new Map(input.quotes.map(q => [q.id, q]))
  const media = new Map(input.media.map(m => [m.sha256, m]))
  const words = (ids: string[]) => ids.map(id => quotes.get(id)).filter((q): q is QuoteViewRow => Boolean(q))
    .sort((a, b) => a.said_at.localeCompare(b.said_at) || a.id.localeCompare(b.id))
    // Shown, not stored: a link, path, id or email inside his words is shown as [link] and the like (AGENTS.md rule 9:
    // cut only what is shown). The database keeps his words whole.
    .map(q => ({ said: scrub(q.text) ?? '', on: day(q.said_at), is: WORDS_LABEL[q.attribution] ?? q.attribution }))
  const refOf = new Map(input.records.map(r => [`${r.source}:${r.source_ref}`, shortRef(r.source, r.source_ref)]))

  const records: Record<string, unknown> = {}
  for (const r of input.records) {
    records[shortRef(r.source, r.source_ref)] = {
      on: day(r.rejected_at), kind: r.kind, theme: r.theme, formats: r.formats, kept_as: r.capture, strength: r.strength,
      piece: scrub(r.piece),
      his_words: words(r.quote_ids),
      what: scrub(r.item),
      wanted_instead: scrub(r.wanted_instead),
      liked_nearby: words(r.near.map(n => n.quote_id)).map(w => ({ said: w.said, on: w.on })),
      media: r.media_sha256.map(sha => media.get(sha)).filter((m): m is MediaViewRow => Boolean(m)).map(m => ({
        role: m.role, sha256: m.sha256, bytes: m.bytes,
        ...(m.at_ms !== null ? { at_s: Math.round(m.at_ms / 100) / 10 } : {}),
      })).sort((a, b) => a.role.localeCompare(b.role) || a.sha256.localeCompare(b.sha256)),
      ...(r.pointed ? { master: 'held in the floor database by its Drive id; never copied' } : {}),
    }
  }

  // A standard's records are the standing rejections and process records that carry the words it rests on, found by
  // its quotes (the stable unit), with any it named still standing: a merge pass that re-files a record under a new
  // identity never leaves a standard he was shown pointing at nothing.
  const byQuote = new Map<string, string[]>()
  for (const r of input.records) {
    if (r.kind === 'liked') continue
    for (const q of r.quote_ids) byQuote.set(q, [...(byQuote.get(q) ?? []), shortRef(r.source, r.source_ref)])
  }
  const recordsOf = (s: StandardRow) => [...new Set([
    ...s.record_refs.map(r => refOf.get(r)).filter((x): x is string => Boolean(x)),
    ...s.quote_ids.flatMap(q => byQuote.get(q) ?? []),
  ])].sort()

  const recordByRef = new Map(input.records.map(r => [shortRef(r.source, r.source_ref), r]))
  const productionsOf = (s: StandardRow) => new Set(recordsOf(s).map(ref => recordByRef.get(ref))
    .filter((r): r is RecordViewRow => Boolean(r) && r!.kind !== 'liked').map(productionOf)).size
  // Patterns first, then by how many productions and how many things he said, then by key: deterministic.
  const ordered = input.standards.map(s => ({ s, n: productionsOf(s) }))
    .sort((a, b) => b.n - a.n || b.s.support_n - a.s.support_n || a.s.fingerprint.localeCompare(b.s.fingerprint))

  // Each standard in his three layers (src/rejection/layers.ts): the floor (one of his eight nevers), an aim, or a dated
  // example. Only a floor standard he approved or reworded may refuse work.
  const standards: Record<string, unknown> = {}
  const layerOf = new Map<string, { layer: string; never: string | null; blocks: boolean }>()
  for (const { s, n } of ordered) {
    const key = `s${s.fingerprint.slice(0, 10)}`
    const sorted = sortStandard(s)
    const blocks = sorted.layer === 'floor' && s.standing !== 'draft'
    layerOf.set(key, { layer: sorted.layer, never: sorted.never, blocks })
    const recs = recordsOf(s)
    const lastDay = recs.map(ref => recordByRef.get(ref)?.rejected_at ?? '').sort().pop() ?? ''
    standards[key] = {
      // Which of his three layers it sits in; layer, below, is the craft layer it is about.
      taste_layer: sorted.layer,
      ...(sorted.never ? { never: sorted.never } : {}),
      blocks,
      ...(sorted.layer === 'example' && lastDay ? { on: day(lastDay) } : {}),
      weight: n >= FLOOR_PATTERN_MIN ? 'pattern' : 'one_off',
      productions: n,
      standing: s.standing,
      ...(s.decided_at ? { decided_on: day(s.decided_at) } : {}),
      // The model wrote these (or he reworded them) from records it read unscrubbed, so they are scrubbed too.
      never_beneath: scrub(s.statement),
      check_before_delivery: scrub(s.how_to_check),
      // The engine wrote every check. He approved it with the statement, or he reworded the statement and not the check,
      // or he has not seen it yet (AGENTS.md rule 3: model output is always labelled).
      check_by: CHECK_BY[s.standing] ?? CHECK_BY.draft,
      formats: s.formats, theme: s.theme, layer: s.layer, kind: s.kind,
      support: s.support_n,
      ...(s.krish ? { in_his_words: scrub(s.krish) } : {}),
      his_words: words(s.quote_ids).filter(w => w.is === 'his words').slice(0, 6),
      records: recs,
      boundary: words(s.boundary_quote_ids).map(w => ({ said: w.said, on: w.on })),
    }
  }
  const keysIn = (layer: string) => [...layerOf].filter(([, l]) => l.layer === layer).map(([k]) => k)
  const floor = {
    sort_rev: SORT_REV,
    sorted_by: 'the engine, by fixed rules on each standard\'s theme, layer and words: a proposal he confirms in one sitting with this file\'s pull request',
    nevers: NEVERS.map(nv => ({
      id: nv.id, listed: nv.listed,
      standards: [...layerOf].filter(([, l]) => l.never === nv.id).map(([k]) => k),
      blocking: [...layerOf].filter(([, l]) => l.never === nv.id && l.blocks).map(([k]) => k),
    })),
  }

  const byFormat: Record<string, unknown> = {}
  for (const f of Object.keys(FORMATS) as FormatSlug[]) {
    // A standard or record for every format belongs to each production maker; never to the workflow ones, or 'other'.
    const mine = (formats: string[]) => formats.includes(f) || (formats.includes('all') && !['all', 'other', 'session', 'pipeline', 'board'].includes(f))
    const own = Object.entries(standards).filter(([, s]) => mine((s as { formats: string[] }).formats))
    const recs = input.records.filter(r => r.kind !== 'liked' && mine(r.formats)).map(r => shortRef(r.source, r.source_ref))
    if (!own.length && !recs.length) continue
    byFormat[f] = {
      maker: FORMATS[f],
      approved: own.filter(([, s]) => (s as { standing: string }).standing !== 'draft').map(([k]) => k),
      draft: own.filter(([, s]) => (s as { standing: string }).standing === 'draft').map(([k]) => k),
      blocking: own.filter(([k]) => layerOf.get(k)?.blocks).map(([k]) => k),
      floor: own.filter(([k]) => layerOf.get(k)?.layer === 'floor').map(([k]) => k),
      aims: own.filter(([k]) => layerOf.get(k)?.layer === 'aim').map(([k]) => k),
      examples: own.filter(([k]) => layerOf.get(k)?.layer === 'example').map(([k]) => k),
      rejected: recs,
    }
  }

  const latest = [...input.records.map(r => r.rejected_at), ...input.standards.map(s => s.decided_at ?? '')].sort().pop() ?? ''
  const body = {
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label])),
    floor, aims: keysIn('aim'), examples: keysIn('example'),
    formats: byFormat, standards, records,
  }
  const doc = {
    _about: [
      'The rejection floor: what Krish rejected in production work, with his reasons, and the standards no finished piece may fall beneath.',
      'Written only by the Rejections engine (krishanraja/inspirationhouse, src/rejection/) and changed only by a pull request he merges. Never edit it by hand.',
      'Read it for the format you are making (python3 scripts/floor.py --format <format>) before the brief, and check the finished file against it before delivery.',
      "his_words are his, verbatim, except that a link, path, id or email inside them is shown as [link], [path], [id] or [email]; the floor database keeps them whole. what, piece and wanted_instead are a session's description, never his words.",
      'A standard is approved or reworded by him, or a draft the engine read into his rejections. Reviewers and pre-delivery checks may test work against approved and reworded standards and his words, for craft and process only, never subject (Ruling, Krish, 2026-10-28).',
      "Every standard sits in one of his three layers, its taste_layer (Krish, 2026-10-29: \"I would much rather the engine know what kind of thing doesn't fly with me, rather than implement incredibly specific rules everywhere\"): floor, one of the eight nevers he confirmed that day, listed under floor.nevers by the ids of content-engine's config/reference-cuts.json; aim, what great looks like, which guides and never blocks; or example, a dated example of the kind of thing that does not fly, never a new rule. Only a standard with blocks true may refuse work: a floor standard he approved or reworded. The engine sorted them (floor.sorted_by); he confirms the sort.",
      'The engine wrote every check_before_delivery; check_by says whether he approved it with the statement, or it is still a draft.',
      `weight is pattern when he raised it about ${FLOOR_PATTERN_MIN} or more productions (productions says how many), one_off when about one. A pattern is more critical to follow than a one-off, and comes first (Krish, 2026-10-28).`,
      'Media are kept in the floor database (content-engine taste_rejection_media) by sha256: a still, a six-frame strip or a 4 s clip, never a master.',
    ],
    version: contentHash(stableJson(body)),
    as_of: day(latest || '1970-01-01T00:00:00Z'),
    counts: {
      standards: input.standards.length,
      approved: input.standards.filter(s => s.standing !== 'draft').length,
      patterns: ordered.filter(o => o.n >= FLOOR_PATTERN_MIN).length,
      floor: keysIn('floor').length,
      aims: keysIn('aim').length,
      examples: keysIn('example').length,
      blocking: [...layerOf.values()].filter(l => l.blocks).length,
      records: input.records.filter(r => r.kind !== 'liked').length,
      liked_nearby: input.records.filter(r => r.kind === 'liked').length,
    },
    ...body,
  }
  // Checked on the values, not the JSON text, where a quote or a line break after "B:" is written B:\" or B:\n.
  const values: string[] = []
  const text = `${JSON.stringify(doc, (_k, v: unknown) => { if (typeof v === 'string') values.push(v); return v }, 2)}\n`
  assertPublic(values.join('\n'))
  return text
}
