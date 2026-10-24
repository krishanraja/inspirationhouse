import { describe, it, expect } from 'vitest'
import { ELIGIBLE_SQL, mondayOf } from '../src/publish/propose.ts'

// The eligibility query runs against the real schema in test/pipeline.int.test.ts. These pin the two rules a review
// found missing, so they cannot quietly go again.
describe('which claims may be proposed', () => {
  const flat = ELIGIBLE_SQL.replace(/\s+/g, ' ')

  it('counts no day from evidence he took back or replaced', () => {
    expect(flat).toMatch(/e\.attribution in \('krish_words', 'krish_action'\) and e\.withdrawn_at is null\) as days/)
  })

  it('carries his quote only while the row it quotes still stands', () => {
    expect(flat).toContain('case when exists (select 1 from public.taste_evidence k where k.id = c.krish_source_id and k.withdrawn_at is null) then c.krish end as krish')
    expect(flat).not.toMatch(/c\.statement, c\.krish,/)
  })

  it('batches by the Monday of the week', () => {
    expect(mondayOf(new Date('2026-10-24T12:00:00Z'))).toBe('2026-10-19')
  })
})
