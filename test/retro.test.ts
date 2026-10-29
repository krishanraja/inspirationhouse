import { describe, it, expect } from 'vitest'
import { FEATURE_KEYS, RETRO_DAYS, due, featuresOf, proposeRetro, retro, type Piece } from '../src/retro/retro.ts'
import type { Db } from '../src/db.ts'

// The retrospective on fixtures: synthetic pieces, synthetic scores, synthetic engagement. Nothing here is a real piece.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const piece = (n: number, narrative: number, production: number, features: Piece['features'], engagement: Piece['engagement'] = null): Piece =>
  ({ id: id(n), published_at: `2026-10-${String(10 + n).padStart(2, '0')}`, narrative, production, basis: 'hindsight', features, engagement })

const FIXTURE: Piece[] = [
  piece(1, 8, 9, { opening: 'hook_is_intro', lead_picture: 'story_object', format: 'short' }, { reach: 1000, shares: 30, saves: 20 }),
  piece(2, 9, 8, { opening: 'hook_is_intro', lead_picture: 'series_picture', format: 'short' }, { reach: 2000, shares: 50, saves: 30 }),
  piece(3, 7, 8, { opening: 'hook_is_intro', lead_picture: 'story_object', format: 'long' }),
  piece(4, 5, 3, { opening: 'logo_intro', lead_picture: 'series_picture', format: 'short' }, { reach: 1500, shares: 6, saves: 3 }),
  piece(5, 6, 4, { opening: 'logo_intro', lead_picture: 'series_picture', format: 'long' }),
]

describe('retro', () => {
  const report = retro(FIXTURE)
  it('names one thing that scored well and one that scored badly, with the pieces and numbers behind each', () => {
    expect(report.claims.map(c => [c.verdict, c.feature, c.value])).toEqual([
      ['scored_well', 'opening', 'hook_is_intro'],
      ['scored_badly', 'opening', 'logo_intro'],
    ])
    const [well, badly] = report.claims
    expect(well!.pieces).toEqual([id(1), id(2), id(3)])
    expect(well!.numbers).toEqual({ score: 16.33, others: 9, n: 3, others_n: 2, narrative: 8, production: 8.33 })
    expect(badly!.pieces).toEqual([id(4), id(5)])
    expect(badly!.numbers).toMatchObject({ score: 9, others: 16.33, n: 2, others_n: 3 })
    // Engagement is a hypothesis, from the pieces it was read for only.
    expect(well!.engagement).toEqual({ shares_per_reach: 0.0267, saves_per_reach: 0.0167, engaged: 2 })
    expect(badly!.engagement).toEqual({ shares_per_reach: 0.004, saves_per_reach: 0.002, engaged: 1 })
  })
  it('claims nothing beyond the data: each says how many pieces, that it is an association, and what it is compared with', () => {
    for (const c of report.claims) {
      expect(c.text).toContain(`An association across ${c.numbers.n + c.numbers.others_n} pieces, not a cause.`)
      expect(c.text).toContain(`Across the ${c.numbers.n} pieces you scored that used it`)
      expect(c.text).not.toMatch(/\u2014/)
    }
    expect(report.claims[0]!.text).toContain('hypothesis until your own data confirms it')
  })
  it('makes no claim from too few pieces, and says why', () => {
    const thin = retro(FIXTURE.slice(0, 3))
    expect(thin.claims).toEqual([])
    expect(thin.held[0]).toMatch(/too few to compare/)
    // A value on one piece only never carries a claim, even when it is the best or the worst.
    const once = retro([...FIXTURE, piece(6, 10, 10, { opening: 'story_card' })])
    expect(once.claims.map(c => c.value)).not.toContain('story_card')
  })
  it('never ranks topics: a feature naming what a piece is about is refused', () => {
    for (const k of ['topic', 'series', 'subject', 'angle', 'idea', 'theme', 'story']) {
      expect(() => featuresOf({ [k]: 'synthetic_value' }), k).toThrow(/never ranks topics/)
    }
    expect(FEATURE_KEYS).toEqual(['opening', 'lead_picture', 'big_moment_sound', 'format'])
    expect(featuresOf({ opening: 'hook_is_intro', lead_picture: 'Not A Slug', other: 'x' })).toEqual({ opening: 'hook_is_intro' })
  })
})

describe('due', () => {
  const now = new Date('2026-11-20T06:00:00Z')
  it('runs after four newly scored pieces or a month, and not otherwise', () => {
    expect(due(now, null, 0).due).toBe(false)
    expect(due(now, null, 1).due).toBe(true)
    expect(due(now, new Date('2026-11-19T06:00:00Z'), 4).due).toBe(true)
    expect(due(now, new Date('2026-11-19T06:00:00Z'), 3).due).toBe(false)
    expect(due(now, new Date(now.getTime() - RETRO_DAYS * 86_400_000), 1).due).toBe(true)
    expect(due(now, new Date(now.getTime() - RETRO_DAYS * 86_400_000), 0).due).toBe(false)
  })
})

describe('proposeRetro', () => {
  it('puts each claim to him as a proposal, never a decision, once a day', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    let held = 0
    const db = { query: async (sql: string, params: unknown[] = [], o?: { write?: boolean }) => {
      if (o?.write) { writes.push({ sql, params }); held++ }
      return /count\(\*\)/.test(sql) ? [{ n: held }] : []
    } } as unknown as Db
    const report = retro(FIXTURE)
    expect(await proposeRetro(db, report, new Date('2026-11-20T06:00:00Z'), true)).toBe(2)
    expect(writes).toHaveLength(2)
    for (const w of writes) {
      expect(w.sql).toContain('insert into public.mindmake_studio_learning_proposals')
      expect(w.sql).not.toMatch(/status|decided/)
      expect(w.params[0]).toBe('retro-2026-11-20')
      expect(JSON.parse(String(w.params[2]))).toMatchObject({ source: 'retro', venture: 'publication' })
    }
    // The same day's report is never put twice.
    expect(await proposeRetro(db, report, new Date('2026-11-20T07:00:00Z'), true)).toBe(0)
    // A dry run counts and writes nothing.
    expect(await proposeRetro({ query: async () => [{ n: 0 }] } as unknown as Db, report, new Date(), false)).toBe(2)
  })
})
