import { describe, it, expect } from 'vitest'
import { CHAIN_JOB, capSkips, readChainCap, skipKey, weekStart } from '../src/chainCap.ts'
import type { Db } from '../src/db.ts'
import { unitKey } from '../src/meter.ts'

// content-engine's $15 a week chain cap (Ruling, Krish, 2026-11-14): its daily sweep records job chain_cap in the run
// ledger, and this engine's daily run skips its tagging while this week's newest verdict is skipped and names it.

function fakeDb(rows: Array<{ status: string; counts: Record<string, unknown> | null }> | Error) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (rows instanceof Error) throw rows
      return rows as T[]
    },
    close: async () => {},
  }
  return { db, calls }
}
const NOW = new Date('2026-11-15T05:17:00Z')

describe('content-engine’s chain cap, read before the daily tagging', () => {
  it('names the tagging stage as content-engine’s list does', () => {
    expect(unitKey('tag')).toBe('inspirationhouse-tag')
    expect(skipKey(unitKey('tag'))).toBe('skip_inspirationhouse_tag')
    expect(CHAIN_JOB).toBe('chain_cap')
  })

  it('reads only this week, from Monday 00:00 UTC, the newest verdict first', async () => {
    expect(weekStart(new Date('2026-11-15T05:17:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z')
    expect(weekStart(new Date('2026-11-16T00:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z')
    expect(weekStart(new Date('2026-11-09T23:59:59Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z')
    const { db, calls } = fakeDb([])
    await readChainCap(db, NOW)
    expect(calls[0]!.sql).toMatch(/from public\.content_engine_runs where job = \$1 and started_at >= \$2 order by started_at desc limit 1/)
    expect(calls[0]!.params).toEqual(['chain_cap', '2026-11-09T00:00:00.000Z'])
  })

  it('skips tagging while the week is over the cap and the verdict names it', async () => {
    const over = await readChainCap(fakeDb([{ status: 'skipped', counts: { usd: 20.43, over: 1, skips: 1, skip_inspirationhouse_tag: 1 } }]).db, NOW)
    expect(over).toMatchObject({ read: true, status: 'skipped' })
    expect(capSkips(over, 'tag')).toBe(true)
    // Another stage it does not name runs.
    expect(capSkips(over, 'explain')).toBe(false)
  })

  it('skips nothing under the cap, with no verdict this week, on a failed verdict, or when the ledger cannot be read', async () => {
    const under = await readChainCap(fakeDb([{ status: 'ok', counts: { usd: 14.18, over: 0, skips: 0 } }]).db, NOW)
    expect(capSkips(under, 'tag')).toBe(false)
    const none = await readChainCap(fakeDb([]).db, NOW)
    expect(none).toMatchObject({ read: true, status: null })
    expect(capSkips(none, 'tag')).toBe(false)
    const failed = await readChainCap(fakeDb([{ status: 'failed', counts: {} }]).db, NOW)
    expect(capSkips(failed, 'tag')).toBe(false)
    // A skipped verdict that does not name tagging skips no tagging.
    const other = await readChainCap(fakeDb([{ status: 'skipped', counts: { skip_inspirationhouse_signals: 1 } }]).db, NOW)
    expect(capSkips(other, 'tag')).toBe(false)
    const unread = await readChainCap(fakeDb(new Error('connection refused')).db, NOW)
    expect(unread).toMatchObject({ read: false, status: null })
    expect(capSkips(unread, 'tag')).toBe(false)
  })
})
