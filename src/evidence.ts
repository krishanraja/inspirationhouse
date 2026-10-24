import type { Db } from './db.ts'
import { contentHash } from './hash.ts'

export type Lane = 'strategy' | 'production' | 'visibility' | 'voice'
export type Polarity = 'likes' | 'dislikes' | 'neutral'
// Only krish_words and krish_action count toward a claim (the database
// recounts them). An observation or a machine inference is context, never proof.
export type Attribution = 'krish_words' | 'krish_action' | 'observation' | 'machine_inference'

export type Source =
  | 'learnings_json' | 'title_verdicts' | 'golden_examples' | 'rejected_lines'
  | 'style_references' | 'style_bank' | 'drive_cold' | 'drive_video'
  | 'what_i_like_sheet' | 'idea_triage' | 'feedback_hist' | 'creator_move'
  | 'visibility_target' | 'drive_artifact' | 'inspiration_page'

export interface Evidence {
  source: Source
  sourceRef: string
  occurredAt: string
  attribution: Attribution
  polarity: Polarity
  lane: Lane
  layer: string | null
  title: string | null
  // Krish's own words when attribution is krish_words; otherwise a short
  // recorded reason. Cut to excerptMax(source) characters (the column holds 2000).
  excerpt: string | null
  meta: Record<string, unknown>
}

const LAYERS = new Set([
  'opening', 'structure', 'breakdown', 'proof', 'tone', 'close', 'packaging',
  'length', 'editing', 'camerawork', 'graphics', 'production', 'stage_format',
])

// Counted and cut by character (code point), as Postgres's char_length counts, never by UTF-16 unit: a cut through an
// emoji leaves half of it, which JSON carries as a lone \ud83d that Postgres refuses, failing the whole batch.
export function clip(text: unknown, max: number): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return null
  const chars = Array.from(t)
  if (chars.length <= max) return t
  const cut = chars.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).join('')
}

export function asLayer(value: unknown): string | null {
  return typeof value === 'string' && LAYERS.has(value) ? value : null
}

export function isoOr(value: unknown, fallback: string): string {
  if (typeof value === 'string' || value instanceof Date) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return fallback
}

/**
 * Parts of an Inspiration page answer's meta that are not his answer: the card's kind (a reading of the file) and how he
 * said to read it (read_as, note_for_claude), which are instructions to the tagger. They stay in meta for the readers,
 * but out of the version, so only a change to his answer makes a new version. A new version withdraws the old one, and
 * a kind settled again or a note added later is no reason to.
 */
export const PAGE_META_UNVERSIONED: readonly string[] = ['kind', 'read_as', 'note_for_claude']

// The version is a hash of the entry's own content: an edited entry is a new
// row, an unchanged one is never inserted twice.
export function versionOf(e: Evidence): string {
  const m = e.source === 'inspiration_page'
    ? Object.fromEntries(Object.entries(e.meta).filter(([k]) => !PAGE_META_UNVERSIONED.includes(k)))
    : e.meta
  return contentHash({
    a: e.attribution, p: e.polarity, l: e.lane, y: e.layer, t: e.title, x: e.excerpt, m,
  })
}

/**
 * How long an excerpt may be. His answers on the Inspiration page run to 2000 characters, so they keep all of it; every
 * other source stays at 400, since a longer cut there would change the version of every row it has already written.
 */
export function excerptMax(source: Source): number {
  return source === 'inspiration_page' ? 2000 : 400
}

export function normalise(e: Evidence): Evidence {
  return {
    ...e,
    sourceRef: e.sourceRef.slice(0, 300),
    layer: asLayer(e.layer),
    title: clip(e.title, 300),
    excerpt: clip(e.excerpt, excerptMax(e.source)),
  }
}

export interface WriteResult { seen: number; written: number }

export async function writeEvidence(db: Db, rows: Evidence[], runId: string): Promise<WriteResult> {
  if (!rows.length) return { seen: 0, written: 0 }
  const payload = rows.map(normalise).map(e => ({
    source: e.source,
    source_ref: e.sourceRef,
    source_version: versionOf(e),
    occurred_at: e.occurredAt,
    attribution: e.attribution,
    polarity: e.polarity,
    lane: e.lane,
    layer: e.layer,
    title: e.title,
    excerpt: e.excerpt,
    meta: e.meta,
    collected_run: runId,
  }))
  let written = 0
  for (let i = 0; i < payload.length; i += 200) {
    const batch = payload.slice(i, i + 200)
    const res = await db.query<{ n: number }>(
      `with ins as (
         insert into public.taste_evidence
           (source, source_ref, source_version, occurred_at, attribution, polarity, lane, layer, title, excerpt, meta, collected_run)
         select source, source_ref, source_version, occurred_at, attribution, polarity, lane, layer, title, excerpt, meta, collected_run
         from jsonb_to_recordset($1::jsonb) as x(
           source text, source_ref text, source_version text, occurred_at timestamptz, attribution text,
           polarity text, lane text, layer text, title text, excerpt text, meta jsonb, collected_run uuid)
         on conflict (source, source_ref, source_version) do nothing
         returning 1)
       select count(*)::int as n from ins`,
      [JSON.stringify(batch)],
      { write: true },
    )
    written += Number(res[0]?.n ?? 0)
  }
  return { seen: rows.length, written }
}

export interface WithdrawResult { withdrawn: number; restored: number; recounted: number }

/**
 * An answer he took back, or replaced, stops counting as his support. After a source is collected, every standing row
 * of it whose version was not collected this run is withdrawn (a reopened card, or an answer with a newer version), and
 * a withdrawn row whose version was collected again stands again (an answer he gave back as it was). Then every claim
 * citing any row of the source is touched, on every run, so the database's trigger recounts its support. The recount
 * never depends on what this run changed: a run that withdrew rows and then failed before its recount is healed by the
 * next one. Only for a source that is read whole on every run: a row missing from one run is gone, never just unread.
 * A dry run counts and writes nothing.
 */
export async function withdrawUncollected(db: Db, source: 'inspiration_page', rows: Evidence[], write: boolean): Promise<WithdrawResult> {
  const keep = JSON.stringify(rows.map(normalise).filter(e => e.source === source).map(e => ({ r: e.sourceRef, v: versionOf(e) })))
  const kept = `exists (select 1 from jsonb_to_recordset($2::jsonb) as k(r text, v text) where k.r = e.source_ref and k.v = e.source_version)`
  const citing = `(evidence_ids || counterexample_ids) && array(select id from public.taste_evidence where source = $1)`
  if (!write) {
    const [res] = await db.query<{ withdrawn: number; restored: number; recounted: number }>(
      `select count(*) filter (where e.withdrawn_at is null and not ${kept})::int as withdrawn,
              count(*) filter (where e.withdrawn_at is not null and ${kept})::int as restored,
              (select count(*)::int from public.taste_claims where ${citing}) as recounted
       from public.taste_evidence e where e.source = $1`,
      [source, keep],
    )
    return { withdrawn: Number(res?.withdrawn ?? 0), restored: Number(res?.restored ?? 0), recounted: Number(res?.recounted ?? 0) }
  }
  const gone = await db.query<{ id: string }>(
    `update public.taste_evidence e set withdrawn_at = now()
     where e.source = $1 and e.withdrawn_at is null and not ${kept}
     returning e.id::text`,
    [source, keep],
    { write: true },
  )
  const back = await db.query<{ id: string }>(
    `update public.taste_evidence e set withdrawn_at = null
     where e.source = $1 and e.withdrawn_at is not null and ${kept}
     returning e.id::text`,
    [source, keep],
    { write: true },
  )
  const [res] = await db.query<{ n: number }>(
    `with c as (
       update public.taste_claims set updated_at = now()
       where ${citing}
       returning 1)
     select count(*)::int as n from c`,
    [source],
    { write: true },
  )
  return { withdrawn: gone.length, restored: back.length, recounted: Number(res?.n ?? 0) }
}
