import type { Db } from '../db.ts'

// Krish decides the floor's standards in groups too (content-engine 20261124090000_floor_groups.sql; Krish, 2026-11-04:
// "group the 215 floor standards for my approval"). content-engine seeds each group (scripts/floor_group.py) as one row
// in taste_floor_groups, its members by full fingerprint, and one proposal he decides at /standards. A member takes its
// group's decision in the taste_floor view, while its own row stays a candidate with no proposal of its own.
//
// So a candidate here is not always one he has not seen. On 2026-11-15 a reading that drafted only some of a group's
// members superseded the rest, and the floor rebuilt from the view dropped 36 standards he had approved; it rewrote the
// checks of others he had approved with them (content-engine #707, closed unmerged). A standard he decided through its
// group is his decision, as one on its own proposal is: never rewritten, superseded or put to him again by the engine.
// Only he changes it, by deciding again.

/**
 * His decision on the group the taste_floor view reads a standard's decision from: approved, corrected or rejected, or
 * null when he has not decided it (or the standard is in no group). The view takes a standard's first group, by when it
 * was made and then its key, and this reads the same one. `s` is the alias of a taste_floor_standards row.
 */
export function groupDecisionSql(s: string): string {
  return `(select case when gp.decided_by = 'Krish' and gp.status in ('approved', 'corrected', 'rejected') then gp.status end
     from public.taste_floor_groups g left join public.mindmake_studio_learning_proposals gp on gp.id = g.proposal_id
     where g.venture = ${s}.venture and ${s}.fingerprint = any(g.member_fingerprints)
     order by g.created_at, g.key limit 1)`
}

export interface GroupRestoreResult {
  /** Members of a group he approved or reworded that the engine had superseded, standing again. */
  restored: number
  /** Their checks put back to the one he was shown with the group, where the engine had rewritten it. */
  checks: number
}

// The newest version of each fingerprint only, as the distil reads a standard's prior: an older version never comes back.
const NEWEST = `not exists (select 1 from public.taste_floor_standards o where o.venture = s.venture and o.fingerprint = s.fingerprint and o.version > s.version)`
// The check he was shown for a member is the one content-engine put on the group's proposal (regression_cases, by the
// floor file's id of the member: s and the first 10 characters of its fingerprint).
const SHOWN = `(select x->>'how_to_check' from public.taste_floor_groups g
     join public.mindmake_studio_learning_proposals gp on gp.id = g.proposal_id,
     jsonb_array_elements(case when jsonb_typeof(gp.regression_cases) = 'array' then gp.regression_cases else '[]'::jsonb end) x
     where g.venture = s.venture and s.fingerprint = any(g.member_fingerprints)
       and x->>'standard' = 's' || left(s.fingerprint, 10) and nullif(btrim(x->>'how_to_check'), '') is not null
     order by g.created_at, g.key limit 1)`

/**
 * Each member of a group he approved or reworded stands as he decided it: one the engine superseded is a candidate
 * again (the status it had when he decided it), and a check the engine rewrote is the one he was shown again. A standard
 * he retired, or a group he rejected, is never brought back. Run every run, before the distil; a dry run counts.
 */
export async function restoreGroupDecided(db: Db, write: boolean): Promise<GroupRestoreResult> {
  const kept = `${groupDecisionSql('s')} in ('approved', 'corrected')`
  if (!write) {
    const [r] = await db.query<{ restored: number; checks: number }>(
      `select count(*) filter (where s.status = 'superseded')::int as restored,
              count(*) filter (where s.status in ('superseded', 'candidate') and ${SHOWN} is distinct from s.how_to_check and ${SHOWN} is not null)::int as checks
       from public.taste_floor_standards s where s.status in ('superseded', 'candidate') and ${NEWEST} and ${kept}`,
    )
    return { restored: Number(r?.restored ?? 0), checks: Number(r?.checks ?? 0) }
  }
  const restored = await db.query<{ id: string }>(
    `update public.taste_floor_standards s set status = 'candidate'
     where s.status = 'superseded' and ${NEWEST} and ${kept} returning s.id::text`,
    [],
    { write: true },
  )
  const checks = await db.query<{ id: string }>(
    `update public.taste_floor_standards s set how_to_check = ${SHOWN}
     where s.status = 'candidate' and ${NEWEST} and ${kept} and ${SHOWN} is not null and ${SHOWN} is distinct from s.how_to_check
     returning s.id::text`,
    [],
    { write: true },
  )
  return { restored: restored.length, checks: checks.length }
}
