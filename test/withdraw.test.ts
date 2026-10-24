import { describe, it, expect } from 'vitest'
import { withdrawUncollected, normalise, versionOf, type Evidence } from '../src/evidence.ts'
import type { Db } from '../src/db.ts'

// Synthetic answers only; nothing here is anything Krish said.
const answer = (ref: string, excerpt: string): Evidence => ({
  source: 'inspiration_page', sourceRef: ref, occurredAt: '2026-10-24T10:00:00Z', attribution: 'krish_words',
  polarity: 'likes', lane: 'production', layer: null, title: 'clip.mp4', excerpt, meta: { picked_likes: [] },
})

function fakeDb(opts: { gone?: string[]; back?: string[]; counts?: { withdrawn: number; restored: number } } = {}) {
  const calls: Array<{ sql: string; params: unknown[]; write: boolean }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
      calls.push({ sql, params, write: Boolean(o?.write) })
      if (/set withdrawn_at = now\(\)/.test(sql)) return (opts.gone ?? []).map(id => ({ id })) as T[]
      if (/set withdrawn_at = null/.test(sql)) return (opts.back ?? []).map(id => ({ id })) as T[]
      if (/update public\.taste_claims/.test(sql)) return [{ n: 2 }] as T[]
      if (/count\(\*\) filter/.test(sql)) return [opts.counts ?? { withdrawn: 0, restored: 0 }] as T[]
      return [] as T[]
    },
    close: async () => {},
  }
  return { db, calls }
}

describe('withdrawUncollected', () => {
  const rows = [answer('card-1', 'the cut on the beat'), answer('card-2', 'the plain captions')]

  it('keeps standing exactly the versions just collected, as the writer versions them', async () => {
    const { db, calls } = fakeDb({ gone: ['e1'] })
    await withdrawUncollected(db, 'inspiration_page', rows, true)
    const keep = JSON.parse(calls[0]!.params[1] as string)
    expect(keep).toEqual(rows.map(normalise).map(e => ({ r: e.sourceRef, v: versionOf(e) })))
    expect(calls[0]!.params[0]).toBe('inspiration_page')
    expect(calls[0]!.sql).toMatch(/e\.source = \$1 and e\.withdrawn_at is null and not exists/)
  })

  it('withdraws what was not collected, stands again what was, and recounts every claim citing either', async () => {
    const { db, calls } = fakeDb({ gone: ['e1', 'e2'], back: ['e3'] })
    const r = await withdrawUncollected(db, 'inspiration_page', rows, true)
    expect(r).toEqual({ withdrawn: 2, restored: 1, recounted: 2 })
    const claims = calls.find(c => /update public\.taste_claims/.test(c.sql))!
    expect(claims.sql).toMatch(/\(evidence_ids \|\| counterexample_ids\) &&/)
    expect(claims.sql).toMatch(/set updated_at = now\(\)/)
    expect(JSON.parse(claims.params[0] as string)).toEqual(['e1', 'e2', 'e3'])
    expect(calls.every(c => c.write)).toBe(true)
  })

  it('touches no claim when nothing changed', async () => {
    const { db, calls } = fakeDb()
    expect(await withdrawUncollected(db, 'inspiration_page', rows, true)).toEqual({ withdrawn: 0, restored: 0, recounted: 0 })
    expect(calls.some(c => /taste_claims/.test(c.sql))).toBe(false)
  })

  it('withdraws every standing answer when the page holds none (every card undone)', async () => {
    const { db, calls } = fakeDb({ gone: ['e1'] })
    await withdrawUncollected(db, 'inspiration_page', [], true)
    expect(JSON.parse(calls[0]!.params[1] as string)).toEqual([])
  })

  it('counts and writes nothing on a dry run', async () => {
    const { db, calls } = fakeDb({ counts: { withdrawn: 3, restored: 1 } })
    expect(await withdrawUncollected(db, 'inspiration_page', rows, false)).toEqual({ withdrawn: 3, restored: 1, recounted: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.write).toBe(false)
    expect(calls[0]!.sql).not.toMatch(/update/i)
  })
})
