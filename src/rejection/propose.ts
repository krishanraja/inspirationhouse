import type { Db } from '../db.ts'
import { mondayOf } from '../publish/propose.ts'

// Putting the floor's standards to Krish, through the learning proposals door that already exists
// (mindmake_studio_learning_proposals, class taste), where Control Center's waiting list shows every proposed row. He
// approves, rewords or rejects; the engine never decides (AGENTS.md rule 5).
//
// Ruling (Krish, 2026-10-28): his rejections bind now, as his words, and the engine's standards are put to him once,
// in one batch. So the first batch holds every standard that rests on his words, and later standards are batched at
// most once a week, never under the ceiling's three-a-week cap. A standard he rejects is retired and never put again.

export interface FloorEligible {
  id: string; fingerprint: string; statement: string; how_to_check: string; formats: string[]; theme: string
  kind: string; krish: string | null; quote_ids: string[]; support_n: number; days: number
}

export const FLOOR_ELIGIBLE_SQL = `
  select s.id::text, s.fingerprint, s.statement, s.how_to_check, s.formats, s.theme, s.kind,
         case when exists (select 1 from public.taste_rejections r where r.withdrawn_at is null and s.krish_quote_id = any(r.quote_ids))
              then s.krish end as krish,
         s.quote_ids::text[] as quote_ids, s.support_n,
         (select count(distinct q.said_at::date)::int from public.taste_rejection_quotes q where q.id = any(s.quote_ids)) as days
  from public.taste_floor_standards s
  where s.status = 'candidate' and s.support_n >= 1
    and not exists (select 1 from public.taste_floor_standards o
                    where o.fingerprint = s.fingerprint and o.proposal_id is not null)
  order by s.support_n desc, s.fingerprint`

export interface FloorProposeResult { eligible: number; proposed: number; batch: string; waiting: boolean }

/** Put the eligible standards to him as one batch, at most one batch a week. A dry run counts and writes nothing. */
export async function proposeFloor(db: Db, now: Date, write: boolean): Promise<FloorProposeResult> {
  const batch = `floor-${mondayOf(now)}`
  const eligible = await db.query<FloorEligible>(FLOOR_ELIGIBLE_SQL)
  const [held] = await db.query<{ n: number }>(
    `select count(*)::int as n from public.mindmake_studio_learning_proposals where weekly_batch_id = $1 and scope->>'source' = 'rejections'`,
    [batch],
  )
  // This week's batch has gone to him already: new standards wait for next week's.
  const waiting = Number(held?.n ?? 0) > 0
  const result: FloorProposeResult = { eligible: eligible.length, proposed: 0, batch, waiting }
  if (waiting || !eligible.length) return result
  if (!write) return { ...result, proposed: eligible.length }
  for (const s of eligible) {
    const makers = s.formats.join(', ')
    const assertion = `Floor for ${makers}: ${s.statement}${s.krish ? ` (In his words: "${s.krish}")` : ''}`
    await db.query(
      `with p as (
         insert into public.mindmake_studio_learning_proposals
           (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids,
            independent_session_count, independent_job_count, counterexamples, regression_cases, proposed_change)
         values ($1, 'taste', $2, $3::jsonb, $4::uuid[], $5, 0, '[]'::jsonb, $6::jsonb, $7::jsonb)
         returning id)
       update public.taste_floor_standards set status = 'proposed', proposal_id = (select id from p)
       where id = $8::uuid and status = 'candidate'`,
      [
        batch,
        assertion.slice(0, 1600),
        JSON.stringify({ key: `floor:${s.formats[0] ?? 'all'}`, level: 'global', source: 'rejections', standard_id: s.id, formats: s.formats, theme: s.theme, kind: s.kind }),
        s.quote_ids.slice(0, 100),
        Math.max(1, s.days),
        JSON.stringify([{ how_to_check: s.how_to_check }]),
        JSON.stringify({ standard_id: s.id, statement: s.statement, how_to_check: s.how_to_check, formats: s.formats }),
        s.id,
      ],
      { write: true },
    )
    result.proposed++
  }
  return result
}

/** A standard he rejected is retired, so it is never put to him again. Approved and reworded ones are read live. */
export async function syncFloorDecisions(db: Db, write: boolean): Promise<number> {
  if (!write) {
    const [r] = await db.query<{ n: number }>(
      `select count(*)::int as n from public.taste_floor_standards s
       join public.mindmake_studio_learning_proposals p on p.id = s.proposal_id
       where p.status = 'rejected' and s.status = 'proposed'`,
    )
    return Number(r?.n ?? 0)
  }
  const rows = await db.query<{ id: string }>(
    `update public.taste_floor_standards s set status = 'retired'
     from public.mindmake_studio_learning_proposals p
     where p.id = s.proposal_id and p.status = 'rejected' and s.status = 'proposed'
     returning s.id::text`,
    [],
    { write: true },
  )
  return rows.length
}
