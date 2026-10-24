import { describe, it, expect } from 'vitest'
import { ELIGIBLE_SQL, mondayOf } from '../src/publish/propose.ts'

// The eligibility query runs against the real schema in test/pipeline.int.test.ts. These pin the two rules a review
// found missing, so they cannot quietly go again.
describe('which claims may be proposed', () => {
  const flat = ELIGIBLE_SQL.replace(/\s+/g, ' ')

  it('counts a day while any version of its entry stands, as support does, so only his Undo takes it away', () => {
    expect(flat).toContain(`e.attribution in ('krish_words', 'krish_action') and exists (select 1 from public.taste_evidence s where s.source = e.source and s.source_ref = e.source_ref and s.withdrawn_at is null)) as days`)
    expect(flat).not.toMatch(/e\.withdrawn_at is null\) as days/)
  })

  it('carries his quote only while the row it quotes still stands', () => {
    expect(flat).toContain('case when exists (select 1 from public.taste_evidence k where k.id = c.krish_source_id and k.withdrawn_at is null) then c.krish end as krish')
    expect(flat).not.toMatch(/c\.statement, c\.krish,/)
  })

  it('batches by the Monday of the week', () => {
    expect(mondayOf(new Date('2026-10-24T12:00:00Z'))).toBe('2026-10-19')
  })
})
