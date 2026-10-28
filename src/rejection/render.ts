import type { Db } from '../db.ts'
import { contentHash, stableJson } from '../hash.ts'
import { FORMATS, THEMES, type FormatSlug } from './vocab.ts'

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

export async function loadFloor(db: Db): Promise<{ standards: StandardRow[]; records: RecordViewRow[]; quotes: QuoteViewRow[]; media: MediaViewRow[] }> {
  const standards = await db.query<StandardRow>(
    `select id::text, fingerprint, formats, theme, layer, kind, standing, statement, how_to_check, krish, support_n, action_n,
            quote_ids::text[] as quote_ids, record_refs, boundary_quote_ids::text[] as boundary_quote_ids, decided_at::text
     from public.taste_floor order by fingerprint`,
  )
  const records = await db.query<RecordViewRow>(
    `select source, source_ref, kind, rejected_at::text, theme, formats, rule_kind, capture, piece, item, wanted_instead, strength,
            quote_ids::text[] as quote_ids, near, media_sha256, (master_drive_id is not null) as pointed, moment_ms
     from public.taste_rejections
     where withdrawn_at is null and rule_kind in ('form', 'workflow')
     order by rejected_at, source, source_ref`,
  )
  const quotes = await db.query<QuoteViewRow>(
    `select q.id::text, q.text, q.attribution, q.said_at::text from public.taste_rejection_quotes q
     where exists (select 1 from public.taste_rejections r where r.withdrawn_at is null and r.rule_kind in ('form', 'workflow')
                   and (q.id = any(r.quote_ids) or r.near @> jsonb_build_array(jsonb_build_object('quote_id', q.id::text))))`,
  )
  const media = await db.query<MediaViewRow>(
    `select m.sha256, m.role, m.mime, octet_length(m.bytes)::int as bytes, m.at_ms, m.derived_from
     from public.taste_rejection_media m
     where exists (select 1 from public.taste_rejections r where r.withdrawn_at is null and m.sha256 = any(r.media_sha256))`,
  )
  return { standards, records, quotes, media }
}

// Windows and Drive-for-desktop paths, Drive and Docs links, Drive-id-shaped tokens, session ids and emails.
const PATH = /\b[A-Z]:\\[^\n"<>|]*?(?=[,;)\]"']|\s{2}|$|\s\(|\s-\s)/g
const LINK = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s"')]+|https?:\/\/claude\.ai\/[^\s"')]+/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const SESSION = /\b(?:cse|session)_[A-Za-z0-9]{8,}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const DRIVE_ID = /\b1[A-Za-z0-9_-]{24,43}\b/g

/** The compiler's text, with anything that is not for a public file taken out. Pure. */
export function scrub(text: string | null): string | null {
  if (text === null) return null
  return text.replace(LINK, '[link]').replace(PATH, '[path]').replace(UUID, '[id]').replace(SESSION, '[session]')
    .replace(EMAIL, '[email]').replace(DRIVE_ID, '[id]')
}

/** Throws when the rendered file still holds a path, a Drive link, an id or an email. Never publish past this. */
export function assertPublic(text: string): void {
  for (const [name, re] of [['path', /\b[A-Z]:\\/], ['link', /(?:drive|docs)\.google\.com|\bclaude\.ai\//], ['id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ['session', /\b(?:cse|session)_[A-Za-z0-9]{8,}/],
    // A Drive id is mixed case with - or _; the floor's own lowercase hex (its version) is not one.
    ['drive id', /\b1(?=[A-Za-z0-9_-]*[A-Z_-])[A-Za-z0-9_-]{24,43}\b/],
    ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/]] as const) {
    if (re.test(text)) throw new Error(`floor render: the file would hold a ${name}`)
  }
}

const day = (iso: string) => iso.slice(0, 10)
const shortRef = (source: string, ref: string) => `r${contentHash(`${source}:${ref}`).slice(0, 10)}`
const WORDS_LABEL: Record<string, string> = { krish_words: 'his words', krish_action: 'his approval', observation: 'a paraphrase, not his words' }

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

  const standards: Record<string, unknown> = {}
  for (const s of input.standards) {
    standards[`s${s.fingerprint.slice(0, 10)}`] = {
      standing: s.standing,
      ...(s.decided_at ? { decided_on: day(s.decided_at) } : {}),
      // The model wrote these (or he reworded them) from records it read unscrubbed, so they are scrubbed too.
      never_beneath: scrub(s.statement),
      check_before_delivery: scrub(s.how_to_check),
      formats: s.formats, theme: s.theme, layer: s.layer, kind: s.kind,
      support: s.support_n,
      ...(s.krish ? { in_his_words: scrub(s.krish) } : {}),
      his_words: words(s.quote_ids).filter(w => w.is === 'his words').slice(0, 6),
      records: s.record_refs.map(r => refOf.get(r)).filter((x): x is string => Boolean(x)).sort(),
      boundary: words(s.boundary_quote_ids).map(w => ({ said: w.said, on: w.on })),
    }
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
      rejected: recs,
    }
  }

  const latest = [...input.records.map(r => r.rejected_at), ...input.standards.map(s => s.decided_at ?? '')].sort().pop() ?? ''
  const body = {
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label])),
    formats: byFormat, standards, records,
  }
  const doc = {
    _about: [
      'The rejection floor: what Krish rejected in production work, with his reasons, and the standards no finished piece may fall beneath.',
      'Written only by the Rejections engine (krishanraja/inspirationhouse, src/rejection/) and changed only by a pull request he merges. Never edit it by hand.',
      'Read it for the format you are making (python3 scripts/floor.py --format <format>) before the brief, and check the finished file against it before delivery.',
      "his_words are his, verbatim, except that a link, path, id or email inside them is shown as [link], [path], [id] or [email]; the floor database keeps them whole. what, piece and wanted_instead are a session's description, never his words.",
      'A standard is approved or reworded by him, or a draft the engine read into his rejections. Reviewers and pre-delivery checks may test work against approved and reworded standards and his words, for craft and process only, never subject (Ruling, Krish, 2026-10-28).',
      'Media are kept in the floor database (content-engine taste_rejection_media) by sha256: a still, a six-frame strip or a 4 s clip, never a master.',
    ],
    version: contentHash(stableJson(body)),
    as_of: day(latest || '1970-01-01T00:00:00Z'),
    counts: {
      standards: input.standards.length,
      approved: input.standards.filter(s => s.standing !== 'draft').length,
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
