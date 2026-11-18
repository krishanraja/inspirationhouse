import { describe, it, expect } from 'vitest'
import { countsAsSignal } from '../src/evidence.ts'
import { REPEATS_SQL } from '../src/publish/repeats.ts'
import { ELIGIBLE_SQL } from '../src/publish/propose.ts'
import { METRICS } from '../src/score/scoreboard.ts'
import { readFileSync } from 'node:fs'

// Reference material (content-engine 20261206090000_taste_evidence_reference.sql; Krish, 2026-11-18) is kept, never
// counted as his signal. Synthetic only: no row of his is read here.
describe('reference material', () => {
  it('reads the mark through the row json, so the clause holds before the column exists', () => {
    expect(countsAsSignal('e')).toBe(`(to_jsonb(e) ->> 'reference_at') is null`)
  })
  it('is left out of every read that counts or uses his signal', () => {
    expect(REPEATS_SQL).toContain(countsAsSignal('e'))
    expect(ELIGIBLE_SQL).toContain(countsAsSignal('e'))
    expect(ELIGIBLE_SQL).toContain(countsAsSignal('k'))
    for (const m of METRICS.filter(m => m.sql.includes('public.taste_evidence'))) expect(m.sql).toContain(countsAsSignal('e'))
    for (const f of ['src/signal/extract.ts', 'src/explain/whys.ts', 'src/distil/claims.ts']) {
      expect(readFileSync(f, 'utf8')).toContain("countsAsSignal('e')")
    }
  })
  it('never touches the withdraw logic: a withdrawal and a reference mark are separate facts', () => {
    const src = readFileSync('src/evidence.ts', 'utf8')
    const withdraw = src.slice(src.indexOf('export async function withdrawUncollected'))
    expect(withdraw).not.toContain('reference_at')
    expect(withdraw).not.toContain('countsAsSignal')
  })
})
