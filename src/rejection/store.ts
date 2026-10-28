import type { Db } from '../db.ts'
import type { QuoteRow, RecordRow } from './file.ts'
import { RULES_REV } from './vocab.ts'

// Writing what file.ts made: his quotes, then each record version, then what he liked nearby. Every write is
// idempotent (a second run writes nothing), and a dry run writes nothing at all: it counts what a real run would.

export const REJECTION_TABLES = ['taste_rejection_quotes', 'taste_rejections', 'taste_rejection_media', 'taste_rejection_inbox', 'taste_floor_standards'] as const

/** Whether content-engine's rejections migration is applied. Until it is, a real run writes nothing. */
export async function rejectionTablesExist(db: Db): Promise<boolean> {
  const [r] = await db.query<{ ok: boolean }>(
    `select ${REJECTION_TABLES.map(t => `to_regclass('public.${t}') is not null`).join(' and ')} as ok`,
  )
  return Boolean(r?.ok)
}

export interface QuoteResult { ids: Map<string, string>; inserted: number; reclassed: number }

/**
 * His quotes, one row per distinct thing he said. A quote already there keeps its words and when he said them (to the
 * precision first filed); only how the engine classes it (attribution, source, where) follows the latest read.
 */
export async function fileQuotes(db: Db, quotes: QuoteRow[], runId: string, write: boolean): Promise<QuoteResult> {
  if (!quotes.length) return { ids: new Map(), inserted: 0, reclassed: 0 }
  const payload = JSON.stringify(quotes.map(q => ({
    quote_key: q.key, text: q.text, said_at: q.saidAt, said_precision: q.precision, said_where: q.saidWhere,
    source: q.source, attribution: q.attribution,
  })))
  const keys = quotes.map(q => q.key)
  if (!write) {
    const held = await db.query<{ quote_key: string; id: string; same: boolean }>(
      `select t.quote_key, t.id::text,
              (t.attribution, t.source, t.said_where) is not distinct from (x.attribution, x.source, x.said_where) as same
       from public.taste_rejection_quotes t
       join jsonb_to_recordset($1::jsonb) as x(quote_key text, attribution text, source text, said_where text) on x.quote_key = t.quote_key`,
      [payload],
    )
    return { ids: new Map(held.map(h => [h.quote_key, h.id])), inserted: keys.length - held.length, reclassed: held.filter(h => !h.same).length }
  }
  const [res] = await db.query<{ inserted: number; reclassed: number }>(
    `with up as (
       insert into public.taste_rejection_quotes (quote_key, text, said_at, said_precision, said_where, source, attribution, first_run)
       select quote_key, text, said_at, said_precision, said_where, source, attribution, $2::uuid
       from jsonb_to_recordset($1::jsonb) as x(quote_key text, text text, said_at timestamptz, said_precision text,
                                                said_where text, source text, attribution text)
       on conflict (quote_key) do update
         set attribution = excluded.attribution, source = excluded.source, said_where = excluded.said_where
         where (public.taste_rejection_quotes.attribution, public.taste_rejection_quotes.source,
                public.taste_rejection_quotes.said_where)
               is distinct from (excluded.attribution, excluded.source, excluded.said_where)
       returning (xmax = 0) as inserted)
     select count(*) filter (where inserted)::int as inserted, count(*) filter (where not inserted)::int as reclassed from up`,
    [payload, runId],
    { write: true },
  )
  const rows = await db.query<{ quote_key: string; id: string }>(
    `select quote_key, id::text from public.taste_rejection_quotes where quote_key = any($1::text[])`,
    [keys],
  )
  return { ids: new Map(rows.map(r => [r.quote_key, r.id])), inserted: Number(res?.inserted ?? 0), reclassed: Number(res?.reclassed ?? 0) }
}

export interface RecordResult { inserted: number; restored: number; withdrawn: number }

/**
 * Each record version, once. A version read again after it was withdrawn stands again. When the read is whole (the
 * dump's files that were read cleanly, or the reports), every standing record of that source, and of those kinds, not
 * in it is withdrawn: a record a later merge pass dropped, or an older version of one it changed. An empty read
 * withdraws nothing: an empty dump is a broken read, never "he took it all back". A file that was missing, shared a
 * path with another, or held a line that would not parse is not read whole, so its records are never withdrawn.
 */
export interface WholeRead { source: 'drive_dump' | 'session_report'; kinds: string[] }

export async function fileRecords(
  db: Db, records: RecordRow[], quoteIds: Map<string, string>, runId: string,
  opts: { write: boolean; whole: WholeRead | null },
): Promise<RecordResult> {
  if (!records.length) return { inserted: 0, restored: 0, withdrawn: 0 }
  const keep = JSON.stringify(records.map(r => ({ s: r.source, r: r.sourceRef, v: r.version })))
  const read = `exists (select 1 from jsonb_to_recordset($1::jsonb) as k(s text, r text, v text)
                        where k.s = t.source and k.r = t.source_ref and k.v = t.source_version)`
  const sources = [...new Set(records.map(r => r.source))]
  if (!opts.write) {
    const [c] = await db.query<{ held: number; restored: number; withdrawn: number }>(
      `select count(*) filter (where ${read})::int as held,
              count(*) filter (where ${read} and t.withdrawn_at is not null)::int as restored,
              count(*) filter (where $2::text is not null and t.source = $2 and t.kind = any($4::text[]) and t.withdrawn_at is null and not ${read})::int as withdrawn
       from public.taste_rejections t where t.source = any($3::text[])`,
      [keep, opts.whole?.source ?? null, sources, opts.whole?.kinds ?? []],
    )
    return { inserted: records.length - Number(c?.held ?? 0), restored: Number(c?.restored ?? 0), withdrawn: Number(c?.withdrawn ?? 0) }
  }
  const payload = JSON.stringify(records.map(r => ({
    source: r.source, source_ref: r.sourceRef, source_version: r.version, kind: r.kind, rejected_at: r.rejectedAt,
    quote_ids: r.quoteKeys.map(k => quoteIds.get(k)).filter((id): id is string => Boolean(id)),
    attribution: r.attribution, item: r.item, reason: r.reason, wanted_instead: r.wantedInstead, strength: r.strength,
    theme: r.theme, formats: r.formats, rule_kind: r.ruleKind, capture: r.capture, piece: r.piece,
    moment_ms: r.moment?.ms ?? null, moment_origin: r.moment?.ms != null ? r.moment.origin : null,
    meta: { ...r.meta, ...(r.moment?.anchor ? { moment_anchor: r.moment.anchor, moment_anchor_origin: r.moment.origin } : {}), media_plan: r.media },
  })))
  const [ins] = await db.query<{ n: number }>(
    `with ins as (
       insert into public.taste_rejections
         (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, item, reason, wanted_instead,
          strength, theme, formats, rule_kind, capture, piece, rules_rev, moment_ms, moment_origin, collected_run, meta)
       select source, source_ref, source_version, kind, rejected_at,
              array(select jsonb_array_elements_text(quote_ids))::uuid[], attribution, item, reason, wanted_instead,
              strength, theme, array(select jsonb_array_elements_text(formats)), rule_kind, capture, piece, $3,
              moment_ms, moment_origin, $2::uuid, meta
       from jsonb_to_recordset($1::jsonb) as x(source text, source_ref text, source_version text, kind text,
         rejected_at timestamptz, quote_ids jsonb, attribution text, item text, reason text, wanted_instead text,
         strength text, theme text, formats jsonb, rule_kind text, capture text, piece text, moment_ms integer,
         moment_origin text, meta jsonb)
       on conflict (source, source_ref, source_version) do nothing
       returning 1)
     select count(*)::int as n from ins`,
    [payload, runId, RULES_REV],
    { write: true },
  )
  const back = await db.query<{ id: string }>(
    `update public.taste_rejections t set withdrawn_at = null where t.withdrawn_at is not null and ${read} returning t.id::text`,
    [keep],
    { write: true },
  )
  let withdrawn = 0
  if (opts.whole?.kinds.length) {
    const gone = await db.query<{ id: string }>(
      `update public.taste_rejections t set withdrawn_at = now()
       where t.source = $2 and t.kind = any($3::text[]) and t.withdrawn_at is null and not ${read} returning t.id::text`,
      [keep, opts.whole.source, opts.whole.kinds],
      { write: true },
    )
    withdrawn = gone.length
  }
  return { inserted: Number(ins?.n ?? 0), restored: back.length, withdrawn }
}

/** What he liked nearby, on the standing version of each record. Changes only when the set changes. */
export async function fileNear(
  db: Db, near: Map<string, Array<{ key: string; basis: string }>>, records: RecordRow[], quoteIds: Map<string, string>, write: boolean,
): Promise<number> {
  const rows = records.map(r => ({
    s: r.source, r: r.sourceRef, v: r.version,
    near: (near.get(r.sourceRef) ?? []).map(n => ({ quote_id: quoteIds.get(n.key) ?? null, basis: n.basis })).filter(n => n.quote_id),
  }))
  const sql = `from jsonb_to_recordset($1::jsonb) as k(s text, r text, v text, near jsonb)
               where k.s = t.source and k.r = t.source_ref and k.v = t.source_version and t.near is distinct from k.near`
  if (!write) {
    const [c] = await db.query<{ n: number }>(`select count(*)::int as n from public.taste_rejections t, lateral (select k.near ${sql}) j`, [JSON.stringify(rows)])
    return Number(c?.n ?? 0)
  }
  const done = await db.query<{ id: string }>(
    `update public.taste_rejections t set near = k.near ${sql} returning t.id::text`,
    [JSON.stringify(rows)],
    { write: true },
  )
  return done.length
}
