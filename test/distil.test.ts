import { describe, it, expect } from 'vitest'
import { resolveClaim, claimFingerprint, type WhyRow, type DraftClaim } from '../src/distil/claims.ts'

const why = (i: number, over: Partial<WhyRow> = {}): WhyRow => ({
  id: `w${i}`, evidence_id: `00000000-0000-0000-0000-00000000000${i}`, statement: `why ${i}`, kind: 'form', layer: 'packaging',
  lane: 'voice', polarity: 'likes', source: 'title_verdicts', attribution: 'krish_words', excerpt: `he said plain words ${i}`,
  occurred_at: `2026-10-0${i}T00:00:00Z`, ...over,
})
const whys = [why(1), why(2), why(3), why(4, { polarity: 'dislikes' })]
const draft = (over: Partial<DraftClaim> = {}): DraftClaim => ({
  statement: 'Titles should say what happens in plain words.', lane: 'voice', layer: 'packaging', kind: 'form',
  why: 'He picks concrete titles.', means: 'Write the event, not the theme.', support: [0, 1, 2], counter: [3],
  krish_quote_ref: 0, krish_quote: 'plain words', flip_rule: 'He picks two abstract titles in a month.', ...over,
})

describe('turning a drafted claim into one the database will hold', () => {
  it('maps refs to evidence and keeps a verbatim quote', () => {
    const r = resolveClaim(draft(), whys)!
    expect(r.evidenceIds).toHaveLength(3)
    expect(r.counterIds).toEqual(['00000000-0000-0000-0000-000000000004'])
    expect(r.krish).toBe('plain words')
  })

  it('drops refs that do not resolve, and then the claim if fewer than three remain', () => {
    expect(resolveClaim(draft({ support: [0, 1, 99] }), whys)).toBeNull()
  })

  it('drops a quote he never said, but keeps the claim', () => {
    const r = resolveClaim(draft({ krish_quote: 'words he never used' }), whys)!
    expect(r.krish).toBeNull()
  })

  it('drops a quote attributed to a line that is not his words', () => {
    const notHis = [why(1, { attribution: 'krish_action' }), why(2), why(3)]
    expect(resolveClaim(draft({ counter: [] }), notHis)!.krish).toBeNull()
  })

  it('refuses a form claim with no craft layer', () => {
    expect(resolveClaim(draft({ layer: null }), whys)).toBeNull()
  })

  it('fingerprints the same claim the same way through punctuation and case', () => {
    expect(claimFingerprint(draft({ statement: 'Titles should say what happens, in plain words!' })))
      .toBe(claimFingerprint(draft({ statement: 'titles should say what happens in plain words' })))
  })
})
