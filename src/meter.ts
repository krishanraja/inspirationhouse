import type { Db } from './db.ts'

// What this engine's model calls cost, posted to Control Center's usage meter (public.meter_daily, through its
// meter_add function) so the Make Your Mind Up chain's weekly figure counts them (Krish, 2026-10-29: "happy with $15 a
// week"). Before this the figure left inspirationhouse out (control-center src/lib/chainSpend.ts, CHAIN_UNMETERED).
//
// One row per stage and model a day: provider anthropic, unit_kind agent, unit_key inspirationhouse-<stage>, bucket the
// model that answered. The rows add up (meter_add sums on conflict), so two runs on one day make one row each.
//
// The rates are Control Center's (api/_prices.ts, the one Anthropic price table), copied for the models this engine
// can be set to. A model not listed is metered with its tokens and $0, category unpriced-model, as Control Center
// does: a visible gap, never a guessed rate. Change a rate there first, then here.

interface ModelPrice { in: number; out: number; cacheRead?: number }

// USD per 1M tokens.
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
}

// A cache read is a tenth of an input token; a five minute write is a quarter more, an hour's twice.
const CACHE = { read: 0.1, write5m: 1.25, write1h: 2 } as const

/** The rate row a served model id prices off: its exact id, or one it extends by a dated snapshot suffix only. */
export function priceFamily(model: string): string | null {
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICES, model)) return model
  return Object.keys(MODEL_PRICES).filter(k => model.startsWith(k) && /^-\d{8}$/.test(model.slice(k.length)))
    .sort((a, b) => b.length - a.length)[0] ?? null
}

function rateOf(model: string): ModelPrice | null {
  const key = priceFamily(model)
  return key ? MODEL_PRICES[key] ?? null : null
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

/** The token counts off an Anthropic usage object, whatever is present: a missing field is zero, never a throw. */
export function readUsage(raw: unknown): Partial<Usage> {
  const u = (raw ?? {}) as Record<string, unknown>
  const has = (k: string) => typeof u[k] === 'number'
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const creation = (u.cache_creation ?? null) as Record<string, unknown> | null
  const out: Partial<Usage> = {}
  if (has('input_tokens')) out.input = n(u.input_tokens)
  if (has('output_tokens')) out.output = n(u.output_tokens)
  if (has('cache_read_input_tokens')) out.cacheRead = n(u.cache_read_input_tokens)
  if (creation) {
    out.cacheWrite1h = n(creation.ephemeral_1h_input_tokens)
    out.cacheWrite5m = n(creation.ephemeral_5m_input_tokens)
  } else if (has('cache_creation_input_tokens')) {
    out.cacheWrite5m = n(u.cache_creation_input_tokens)
    out.cacheWrite1h = 0
  }
  return out
}

/** USD for a call, cache included; a model with no rate is $0. */
export function priceUsd(model: string, u: Usage): number {
  const p = rateOf(model)
  if (!p) return 0
  return (u.input * p.in + u.output * p.out + u.cacheRead * (p.cacheRead ?? p.in * CACHE.read)
    + u.cacheWrite5m * p.in * CACHE.write5m + u.cacheWrite1h * p.in * CACHE.write1h) / 1e6
}

/** What the same call would have cost with nothing cached: the meter keeps both, so a cache that saves nothing shows. */
export function priceUsdUncached(model: string, u: Usage): number {
  const p = rateOf(model)
  if (!p) return 0
  return ((u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h) * p.in + u.output * p.out) / 1e6
}

/** A stage name as a meter key: lower case, dashes, at most 48 characters (Control Center's normalizeAgent). */
export function unitKey(stage: string): string {
  const s = `inspirationhouse-${stage}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 48)
}

interface Line { stage: string; model: string; calls: number; failed: number; usage: Usage }

export interface MeterTotals { calls: number; failed: number; usd: number; usdUncached: number; tokens: number; cacheRead: number; cacheWrite: number }

/**
 * Every model call of one run, by stage and model. Calls are recorded as they finish, and posted once at the end of
 * the run (flush), so a run's cost reaches the meter even when the run fails.
 */
export class Meter {
  private lines = new Map<string, Line>()

  record(stage: string, model: string, usage: Partial<Usage>, failed = false): void {
    const key = `${stage}\u0000${model}`
    const line = this.lines.get(key) ?? { stage, model, calls: 0, failed: 0, usage: { ...NO_USAGE } }
    line.calls += 1
    if (failed) line.failed += 1
    for (const k of Object.keys(NO_USAGE) as Array<keyof Usage>) line.usage[k] += usage[k] ?? 0
    this.lines.set(key, line)
  }

  totals(): MeterTotals {
    const t: MeterTotals = { calls: 0, failed: 0, usd: 0, usdUncached: 0, tokens: 0, cacheRead: 0, cacheWrite: 0 }
    for (const l of this.lines.values()) {
      t.calls += l.calls
      t.failed += l.failed
      t.usd += priceUsd(l.model, l.usage)
      t.usdUncached += priceUsdUncached(l.model, l.usage)
      t.tokens += tokensOf(l.usage)
      t.cacheRead += l.usage.cacheRead
      t.cacheWrite += l.usage.cacheWrite5m + l.usage.cacheWrite1h
    }
    return t
  }

  /** The rows a flush posts, one per stage and model. */
  rows(day: string): MeterRow[] {
    return [...this.lines.values()].filter(l => tokensOf(l.usage) > 0 || l.calls > 0).map(l => ({
      provider: 'anthropic',
      unit_kind: 'agent',
      unit_key: unitKey(l.stage),
      day,
      bucket: l.model,
      unit_label: unitKey(l.stage),
      category: priceFamily(l.model) ? 'priced' : 'unpriced-model',
      usd: round6(priceUsd(l.model, l.usage)),
      runs: l.calls,
      failed: l.failed,
      units: tokensOf(l.usage),
      unit_name: 'tokens',
      cache_read_tokens: l.usage.cacheRead,
      cache_write_tokens: l.usage.cacheWrite5m + l.usage.cacheWrite1h,
      usd_uncached: round6(priceUsdUncached(l.model, l.usage)),
    }))
  }

  /**
   * Post this run's rows to the meter, on the UTC day the run started (meter_daily keeps UTC days). Once only: the
   * lines are cleared after a post, so a second flush adds nothing.
   */
  async flush(db: Db, day: string): Promise<number> {
    const rows = this.rows(day)
    if (!rows.length) return 0
    await db.query(
      `select public.meter_add(r.provider, r.unit_kind, r.unit_key, r.day, r.bucket, r.unit_label, r.category, r.usd,
                               r.runs, r.failed, r.units, r.unit_name, r.cache_read_tokens, r.cache_write_tokens,
                               r.usd_uncached)
         from jsonb_to_recordset($1::jsonb) as r(provider text, unit_kind text, unit_key text, day date, bucket text,
              unit_label text, category text, usd numeric, runs int, failed int, units numeric, unit_name text,
              cache_read_tokens numeric, cache_write_tokens numeric, usd_uncached numeric)`,
      [JSON.stringify(rows)],
      { write: true },
    )
    this.lines.clear()
    return rows.length
  }
}

export interface MeterRow {
  provider: string; unit_kind: string; unit_key: string; day: string; bucket: string; unit_label: string
  category: string; usd: number; runs: number; failed: number; units: number; unit_name: string
  cache_read_tokens: number; cache_write_tokens: number; usd_uncached: number
}

function tokensOf(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
