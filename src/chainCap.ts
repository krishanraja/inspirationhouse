import type { Db } from './db.ts'
import { unitKey } from './meter.ts'

// content-engine's $15 a week chain cap. Ruling (Krish, 2026-11-14): the chain cap as proposed in content-engine's
// docs/proposals/2026-11-14-phase3-and-chain-cap.md, approved as written (his words: "I agree with everything else until
// Batch 6"). content-engine's daily triage sweep (03:00 UTC) reads the week's chain spend and records its verdict in the
// run ledger this engine already writes, content_engine_runs, as job chain_cap: skipped once the week passes $15, with
// skip_<unit key> = 1 for each optional run it skips (inspirationhouse tagging first, its config/chain-cap.json
// skip_when_over), ok under it, failed when its meter could not be read. The rule and the sum are content-engine's
// (apps/control-plane/api/_chainCap.ts there); this engine only reads the verdict before a stage it names, so there is no
// copy of the families or the cap here. Weeks start Monday 00:00 UTC there, and here.
//
// Unknown never stops a run: no row this week, a failed one, or a read that fails, skips nothing and is counted.

export const CHAIN_JOB = 'chain_cap'

/** The Monday 00:00 UTC that starts the week holding `now`. */
export function weekStart(now: Date): Date {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
  return t
}

/** The ledger count that names a skipped run: skip_<its unit key>, snake case (content-engine's skipKey). */
export function skipKey(key: string): string {
  return `skip_${key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}

export interface ChainCap {
  /** The ledger could be read. */
  read: boolean
  /** This week's newest verdict: ok, skipped or failed, or null when the sweep has recorded none this week. */
  status: string | null
  /** The skip_<unit key> counts it set. */
  skips: Set<string>
}

/** This week's newest chain_cap verdict. A read that fails is unknown, and skips nothing. */
export async function readChainCap(db: Db, now: Date): Promise<ChainCap> {
  try {
    const rows = await db.query<{ status: string; counts: Record<string, unknown> | null }>(
      `select status, counts from public.content_engine_runs where job = $1 and started_at >= $2 order by started_at desc limit 1`,
      [CHAIN_JOB, weekStart(now).toISOString()],
    )
    const row = rows[0]
    if (!row) return { read: true, status: null, skips: new Set() }
    const skips = row.status === 'skipped'
      ? new Set(Object.entries(row.counts ?? {}).filter(([k, v]) => k.startsWith('skip_') && Number(v) === 1).map(([k]) => k))
      : new Set<string>()
    return { read: true, status: row.status, skips }
  } catch {
    return { read: false, status: null, skips: new Set() }
  }
}

/** Whether the cap skips this engine's stage this week: only on a skipped verdict that names the stage's unit key. */
export function capSkips(cap: ChainCap, stage: string): boolean {
  return cap.status === 'skipped' && cap.skips.has(skipKey(unitKey(stage)))
}
