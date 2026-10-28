import { describe, it, expect } from 'vitest'
import { METRICS, QUERY_REV } from '../src/score/scoreboard.ts'

describe('the answered rate', () => {
  it('counts a card from when he first answered it, which an edit never restamps', () => {
    const sql = METRICS.find(m => m.metric === 'inspiration_answered_rate')!.sql
    expect(sql).toContain('coalesce(first_answered_at, answered_at) < $2::date')
    expect(sql).not.toMatch(/filter \(where answered_at is not null and answered_at </)
    expect(QUERY_REV).toBe('score-v3')
  })
})

describe('the decided rate', () => {
  it('counts only Make Your Mind Up\'s proposals, and every one made before the split, which names no venture', () => {
    const sql = METRICS.find(m => m.metric === 'taste_claims_decided_rate')!.sql
    expect(sql).toContain(`coalesce(p.scope->>'venture', 'publication') = 'publication'`)
  })
})
