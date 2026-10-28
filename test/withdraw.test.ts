import { describe, it, expect } from 'vitest'
import { withdrawUncollected, normalise, versionOf, type Evidence } from '../src/evidence.ts'
import type { Db } from '../src/db.ts'

// Synthetic answers only; nothing here is anything Krish said.
const answer = (ref: string, excerpt: string): Evidence => ({
  source: 'inspiration_page', sourceRef: ref, occurredAt: '2026-10-24T10:00:00Z', attribution: 'krish_words',
  polarity: 'likes', lane: 'production', layer: null, title: 'clip.mp4', excerpt, meta: { picked_likes: [] }, venture: 'publication',
})

function fakeDb(opts: { gone?: string[]; back?: string[]; counts?: { withdrawn: number; restored: number; recounted: number } } = {}) {
  const calls: Array<{ sql: string; params: unknown[]; write: boolean }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
      calls.push({ sql, params, write: Boolean(o?.write) })
      if (/set withdrawn_at = now\(\)/.test(sql)) return (opts.gone ?? []).map(id => ({ id })) as T[]
      if (/set withdrawn_at = null/.test(sql)) return (opts.back ?? []).map(id => ({ id })) as T[]
      if (/update public\.taste_claims/.test(sql)) return [{ n: 2 }] as T[]
      if (/count\(\*\) filter/.test(sql)) return [opts.counts ?? { withdrawn: 0, restored: 0, recounted: 0 }] as T[]
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

  it('withdraws what was not collected, stands again what was, and recounts every claim citing the page', async () => {
    const { db, calls } = fakeDb({ gone: ['e1', 'e2'], back: ['e3'] })
    const r = await withdrawUncollected(db, 'inspiration_page', rows, true)
    expect(r).toEqual({ withdrawn: 2, restored: 1, recounted: 2 })
    const claims = calls.find(c => /update public\.taste_claims/.test(c.sql))!
    expect(claims.sql).toMatch(/set updated_at = now\(\)/)
    expect(claims.sql).toMatch(/\(evidence_ids \|\| counterexample_ids\) && array\(select id from public\.taste_evidence where source = \$1\)/)
    expect(claims.params).toEqual(['inspiration_page'])
    expect(calls.every(c => c.write)).toBe(true)
  })

  it('recounts every claim citing the page even when this run changed nothing, so a recount a failed run missed is made', async () => {
    const { db, calls } = fakeDb()
    expect(await withdrawUncollected(db, 'inspiration_page', rows, true)).toEqual({ withdrawn: 0, restored: 0, recounted: 2 })
    const claims = calls.find(c => /update public\.taste_claims/.test(c.sql))!
    expect(claims.params).toEqual(['inspiration_page'])
  })

  it('withdraws every standing answer when the page holds none (every card undone)', async () => {
    const { db, calls } = fakeDb({ gone: ['e1'] })
    await withdrawUncollected(db, 'inspiration_page', [], true)
    expect(JSON.parse(calls[0]!.params[1] as string)).toEqual([])
  })

  it('counts and writes nothing on a dry run', async () => {
    const { db, calls } = fakeDb({ counts: { withdrawn: 3, restored: 1, recounted: 4 } })
    expect(await withdrawUncollected(db, 'inspiration_page', rows, false)).toEqual({ withdrawn: 3, restored: 1, recounted: 4 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.write).toBe(false)
    expect(calls[0]!.sql).not.toMatch(/update/i)
  })
})

describe('versionOf', () => {
  const page = (meta: Record<string, unknown>): Evidence => ({ ...answer('card-1', 'the cut on the beat'), meta })

  it('versions a page answer by his answer alone, never by its kind or how he said to read it', () => {
    const base = versionOf(page({ why_here: 'for the opener', picked_likes: [] }))
    expect(versionOf(page({ why_here: 'for the opener', picked_likes: [], kind: 'video' }))).toBe(base)
    expect(versionOf(page({ why_here: 'for the opener', picked_likes: [], kind: 'image', read_as: 'watch', note_for_claude: 'the end matters' }))).toBe(base)
    // Who settled the kind rides beside it, out of the version too: adding it re-versions no row he has answered.
    expect(versionOf(page({ why_here: 'for the opener', picked_likes: [], kind: 'corpus', kind_source: 'model' }))).toBe(base)
  })

  it('makes a new version when his answer changes', () => {
    const base = versionOf(page({ why_here: 'for the opener', picked_likes: [] }))
    expect(versionOf(page({ why_here: 'for the close', picked_likes: [] }))).not.toBe(base)
    expect(versionOf(page({ why_here: 'for the opener', picked_likes: ['tight pacing'] }))).not.toBe(base)
    expect(versionOf({ ...page({ why_here: 'for the opener', picked_likes: [] }), excerpt: 'the plain captions' })).not.toBe(base)
  })

  it('keeps every meta key in the version of any other source', () => {
    const other = (meta: Record<string, unknown>): Evidence => ({ ...page(meta), source: 'title_verdicts' })
    expect(versionOf(other({ kind: 'video' }))).not.toBe(versionOf(other({})))
  })
})

describe('withdrawUncollected on the Instagram feed', () => {
  // Synthetic posts only.
  const post = (id: string, file: string): Evidence => ({
    source: 'drive_cold', sourceRef: `instagram:${id}`, occurredAt: '2026-10-24T10:00:00Z', attribution: 'observation',
    polarity: 'neutral', lane: 'strategy', layer: null, title: `post ${id}`, excerpt: 'an invented summary',
    meta: { kind: 'instagram_post', file }, venture: 'publication',
  })

  it('withdraws only within the feed\'s own refs, never a Drive file\'s row in the same source', async () => {
    const { db, calls } = fakeDb({ gone: ['old-1'] })
    const rows = [post('p1', 'new-file'), post('p2', 'new-file')]
    await withdrawUncollected(db, 'drive_cold', rows, true)
    const gone = calls.find(c => /set withdrawn_at = now\(\)/.test(c.sql))!
    expect(gone.sql).toMatch(/e\.source_ref like any\(\$3::text\[\]\)/)
    expect(gone.params).toEqual(['drive_cold', JSON.stringify(rows.map(normalise).map(e => ({ r: e.sourceRef, v: versionOf(e) }))), ['instagram:%', 'instagram-theme:%']])
    const claims = calls.find(c => /update public\.taste_claims/.test(c.sql))!
    expect(claims.sql).toMatch(/source = \$1 and source_ref like any\(\$2::text\[\]\)/)
    expect(claims.params).toEqual(['drive_cold', ['instagram:%', 'instagram-theme:%']])
  })

  it('keeps out of the kept set any drive_cold row that is not the feed\'s', async () => {
    const { db, calls } = fakeDb()
    const driveFile: Evidence = { ...post('x', 'f'), sourceRef: '1someDriveFileId' }
    await withdrawUncollected(db, 'drive_cold', [post('p1', 'f'), driveFile], true)
    expect(JSON.parse(calls[0]!.params[1] as string).map((k: { r: string }) => k.r)).toEqual(['instagram:p1'])
  })

  it('leaves the page path exactly as it was: the whole source, no ref filter', async () => {
    const { db, calls } = fakeDb()
    await withdrawUncollected(db, 'inspiration_page', [], true)
    expect(calls.every(c => !/like any/.test(c.sql))).toBe(true)
    expect(calls.find(c => /update public\.taste_claims/.test(c.sql))!.params).toEqual(['inspiration_page'])
  })
})
