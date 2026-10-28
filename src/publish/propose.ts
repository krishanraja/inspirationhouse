import { WEEKLY_PROPOSAL_CAP } from '../config.ts'
import type { Db } from '../db.ts'

// Put at most three claims a week in front of Krish, through the learning
// proposals door that already exists (mindmake_studio_learning_proposals,
// class taste). He decides there; this engine never sets a decision.
// One ranked list and one cap across every venture: the cap limits his
// attention, not any venture's share. Each proposal names its claim's venture
// (scope.venture), so every door can label it and every reader filter by it.

export function mondayOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
  return m.toISOString().slice(0, 10)
}

export interface Eligible {
  id: string; venture: string; fingerprint: string; lane: string; layer: string | null; kind: string
  statement: string; krish: string | null; means: string; flip_rule: string
  evidence_ids: string[]; counterexample_ids: string[]; support_n: number; counter_n: number
  confidence: number; days: number
}

// Eligible: enough of his own evidence, spread over at least two days, never
// proposed in the last eight weeks. Form claims first: they are the ones a
// reader may use. A cited row counts its day while any version of the same entry
// still stands, the rule support uses (content-engine 20261110): an answer he
// changed keeps its day, and only his Undo, which withdraws every version, takes
// it away. His quote goes with the claim only while the very row it quotes still
// stands. The eight weeks are counted within the claim's venture: the same
// statement in another venture is another claim.
export const ELIGIBLE_SQL = `
  select c.id::text, c.venture, c.fingerprint, c.lane, c.layer, c.kind, c.statement,
         case when exists (select 1 from public.taste_evidence k where k.id = c.krish_source_id and k.withdrawn_at is null)
              then c.krish end as krish,
         c.means, c.flip_rule,
         c.evidence_ids::text[] as evidence_ids, c.counterexample_ids::text[] as counterexample_ids,
         c.support_n, c.counter_n, c.confidence::float as confidence,
         (select count(distinct e.occurred_at::date)::int from public.taste_evidence e
          where e.id = any(c.evidence_ids) and e.attribution in ('krish_words', 'krish_action')
            and exists (select 1 from public.taste_evidence s
                        where s.source = e.source and s.source_ref = e.source_ref and s.withdrawn_at is null)) as days
  from public.taste_claims c
  where c.status = 'candidate' and c.support_n >= 3
    and not exists (
      select 1 from public.taste_claims o
      where o.venture = c.venture and o.fingerprint = c.fingerprint and o.proposal_id is not null
        and o.updated_at > now() - interval '56 days')
  order by (c.kind = 'form') desc, c.confidence * c.support_n desc, (c.lane = 'production') desc
  limit 20`

export interface ProposeResult { eligible: number; proposed: number; already_this_week: number }

export async function propose(db: Db, now: Date, write = true): Promise<ProposeResult> {
  const batch = `taste-${mondayOf(now)}`
  const [{ n: already }] = await db.query<{ n: number }>(
    `select count(*)::int as n from public.mindmake_studio_learning_proposals
     where weekly_batch_id = $1 and scope->>'source' = 'taste_ledger'`,
    [batch],
  ) as [{ n: number }]
  const eligible = (await db.query<Eligible>(ELIGIBLE_SQL)).filter(c => c.days >= 2)
  const room = Math.max(0, WEEKLY_PROPOSAL_CAP - Number(already))
  const chosen = eligible.slice(0, room)
  const result: ProposeResult = { eligible: eligible.length, proposed: 0, already_this_week: Number(already) }
  if (!write) return { ...result, proposed: chosen.length }

  for (const c of chosen) {
    const assertion = c.krish ? `${c.statement} (In his words: "${c.krish}")` : c.statement
    await db.query(
      `with p as (
         insert into public.mindmake_studio_learning_proposals
           (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids,
            independent_session_count, independent_job_count, counterexamples, regression_cases, proposed_change)
         values ($1, 'taste', $2, $3::jsonb, array(select jsonb_array_elements_text($4::jsonb))::uuid[],
                 $5, 0, $6::jsonb, $7::jsonb, $8::jsonb)
         returning id)
       update public.taste_claims set status = 'proposed', proposal_id = (select id from p)
       where id = $9::uuid and status = 'candidate'`,
      [
        batch,
        assertion.slice(0, 1600),
        JSON.stringify({ key: `taste:${c.layer ?? c.lane}`, level: 'global', source: 'taste_ledger', claim_id: c.id, lane: c.lane, layer: c.layer,
          kind: c.kind, venture: c.venture }),
        JSON.stringify(c.evidence_ids.slice(0, 100)),
        Math.max(1, c.days),
        JSON.stringify(c.counterexample_ids.map(id => ({ evidence_id: id }))),
        JSON.stringify([{ flip_rule: c.flip_rule }]),
        JSON.stringify({ claim_id: c.id, statement: c.statement, means: c.means }),
        c.id,
      ],
      { write: true },
    )
    result.proposed++
  }
  return result
}

/** A claim he rejected is retired, so it is never proposed again. Approved and
 *  reworded claims need nothing: the profile view reads the decision live. */
export async function syncDecisions(db: Db, write = true): Promise<{ retired: number }> {
  if (!write) {
    const [{ n }] = await db.query<{ n: number }>(
      `select count(*)::int as n from public.taste_claims c
       join public.mindmake_studio_learning_proposals p on p.id = c.proposal_id
       where p.status = 'rejected' and c.status = 'proposed'`,
    ) as [{ n: number }]
    return { retired: Number(n) }
  }
  const rows = await db.query<{ n: number }>(
    `with r as (
       update public.taste_claims c set status = 'retired'
       from public.mindmake_studio_learning_proposals p
       where p.id = c.proposal_id and p.status = 'rejected' and c.status = 'proposed'
       returning 1)
     select count(*)::int as n from r`,
    [],
    { write: true },
  )
  return { retired: Number(rows[0]?.n ?? 0) }
}
