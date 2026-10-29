import type { Db } from './db.ts'

// Runs are recorded in content-engine's existing ledger, which Control
// Center's done-check already reads. Jobs: taste_daily, taste_weekly, taste_harness, taste_cards (the quick job for
// links he pasted), taste_rejections (the floor, src/rejection/) and taste_retro (the retrospective, src/retro/); content_engine_runs allows any job matching
// ^[a-z][a-z0-9_]{1,63}$.
export type RunStatus = 'ok' | 'skipped' | 'failed'

export interface RunRecord {
  job: 'taste_daily' | 'taste_weekly' | 'taste_harness' | 'taste_cards' | 'taste_rejections' | 'taste_retro'
  trigger: 'cron' | 'manual'
  status: RunStatus
  reason: string | null
  counts: Record<string, number | boolean | string>
  startedAt: Date
}

export async function recordRun(db: Db, run: RunRecord): Promise<void> {
  await db.query(
    `insert into public.content_engine_runs (job, trigger, status, reason, counts, started_at, finished_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())`,
    [run.job, run.trigger, run.status, run.reason?.slice(0, 600) ?? null, JSON.stringify(run.counts), run.startedAt.toISOString()],
    { write: true },
  )
}

// A green run that produced nothing from real input is a failure, not a
// quiet success. Zero input is a valid skip.
export function judgeRun(input: number, output: number, minInputForOutput = 5): { status: RunStatus; reason: string | null } {
  if (input === 0) return { status: 'skipped', reason: 'no new input' }
  if (input >= minInputForOutput && output === 0) {
    return { status: 'failed', reason: `${input} new inputs produced 0 outputs` }
  }
  return { status: 'ok', reason: null }
}
