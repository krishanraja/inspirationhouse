import type { Db } from '../db.ts'
import { mondayOf } from '../publish/propose.ts'

// Is the output getting better? Computed from signals that are actually live,
// by SQL anyone can re-run (query_rev pins the version). A week with nothing to
// count is a no_reading, never a zero: silence is not feedback.

// score-v2 (2026-10-24): the answered rate counts a card from when he first answered it (first_answered_at).
export const QUERY_REV = 'score-v2'

interface Metric { metric: string; sql: string }

// $1 = the Monday that starts the week, $2 = the Monday after.
export const METRICS: Metric[] = [
  {
    // The moat metric: how often Krish still has to correct the output, per
    // piece published. Lower is better.
    metric: 'corrections_per_published_piece',
    sql: `
      with corrections as (
        select count(*)::numeric as n from public.taste_evidence e
        where e.occurred_at >= $1::date and e.occurred_at < $2::date
          and (e.source in ('learnings_json', 'rejected_lines')
               or (e.source = 'title_verdicts' and e.polarity = 'dislikes'))
      ), edits as (
        select count(*)::numeric as n from public.content_edit_events
        where actor = 'Krish' and action = 'manual_edit'
          and occurred_at >= $1::date and occurred_at < $2::date
      ), published as (
        select count(*)::numeric as n from public.content_ideas
        where published_at >= $1::date and published_at < $2::date
      )
      select (select n from corrections) + (select n from edits) as numerator,
             (select n from published) as denominator`,
  },
  {
    metric: 'title_first_pick_rate',
    sql: `
      select count(*) filter (where polarity = 'likes')::numeric as numerator,
             count(*)::numeric as denominator
      from public.taste_evidence
      where source = 'title_verdicts' and occurred_at >= $1::date and occurred_at < $2::date`,
  },
  {
    metric: 'inspiration_answered_rate',
    sql: `
      -- A card still answered, counted from when he first answered it: an edit restamps answered_at, never
      -- first_answered_at, and a card not yet stamped with it falls back to answered_at.
      select count(*) filter (where answered_at is not null and coalesce(first_answered_at, answered_at) < $2::date)::numeric as numerator,
             count(*)::numeric as denominator
      from public.inspiration_items
      -- Cumulative to the end of the week. $1 is bound so every metric takes
      -- the same two parameters.
      where created_at < $2::date and dismissed_at is null and $1::date < $2::date`,
  },
  {
    metric: 'taste_claims_decided_rate',
    sql: `
      select count(*) filter (where p.status <> 'proposed')::numeric as numerator,
             count(*)::numeric as denominator
      from public.mindmake_studio_learning_proposals p
      where p.scope->>'source' = 'taste_ledger' and p.created_at < $2::date and $1::date < $2::date`,
  },
]

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface ScoreRow { week: string; metric: string; numerator: number | null; denominator: number | null; reading: 'measured' | 'no_reading' }

export async function computeWeek(db: Db, week: string): Promise<ScoreRow[]> {
  const next = addDays(week, 7)
  const out: ScoreRow[] = []
  for (const m of METRICS) {
    const [row] = await db.query<{ numerator: string | number | null; denominator: string | number | null }>(m.sql, [week, next])
    const num = row?.numerator == null ? null : Number(row.numerator)
    const den = row?.denominator == null ? null : Number(row.denominator)
    const measured = num !== null && den !== null && den > 0 && !(m.metric === 'corrections_per_published_piece' && num === 0)
    out.push({ week, metric: m.metric, numerator: measured ? num : null, denominator: measured ? den : null, reading: measured ? 'measured' : 'no_reading' })
  }
  return out
}

/** Score the week that just ended. On the first run, also the four weeks
 *  before it, as the baseline taken before any reader used a claim. */
export async function score(db: Db, now: Date, write = true): Promise<{ weeks: number; metrics: number; rows: ScoreRow[] }> {
  const lastWeek = addDays(mondayOf(now), -7)
  const [{ n: have }] = await db.query<{ n: number }>(`select count(*)::int as n from public.taste_scoreboard`) as [{ n: number }]
  const weeks = Number(have) === 0 ? [-28, -21, -14, -7, 0].map(d => addDays(lastWeek, d)) : [lastWeek]
  const phase = Number(have) === 0 ? 'baseline' : 'live'
  const rows: ScoreRow[] = []
  for (const w of weeks) rows.push(...await computeWeek(db, w))
  if (write) {
    await db.query(
      `insert into public.taste_scoreboard (week, metric, numerator, denominator, reading, phase, inputs)
       select week, metric, numerator, denominator, reading, $2, jsonb_build_object('query_rev', $3::text)
       from jsonb_to_recordset($1::jsonb) as x(week date, metric text, numerator numeric, denominator numeric, reading text)
       on conflict (week, metric) do update
         set numerator = excluded.numerator, denominator = excluded.denominator, reading = excluded.reading,
             inputs = excluded.inputs, computed_at = now()`,
      [JSON.stringify(rows), phase, QUERY_REV],
      { write: true },
    )
  }
  return { weeks: weeks.length, metrics: rows.length, rows }
}
