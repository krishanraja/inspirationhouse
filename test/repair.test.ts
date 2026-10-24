import { describe, it, expect } from 'vitest'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { cutAt, repairToSchema } from '../src/repair.ts'
import { TagSchema } from '../src/tag/items.ts'
import { WhySchema } from '../src/explain/whys.ts'
import { ClaimSchema } from '../src/distil/claims.ts'

const tag = (): any => ({
  tags: [{ label: 'the hook', kind: 'form', layer: 'opening' }],
  predicted: { why_here: ['a sharp opening'], why_like: ['it gets to the point'], would_do: ['try the same hook'] },
  route: 'make_piece',
  facets: { platform: 'unknown', format: 'document', source: null, creator: null, people: [], organisations: [], topics: [] },
})

describe('the limits never reach the model', () => {
  it('is why the answer is repaired here: the schema the API gets carries none of them', () => {
    const sent = JSON.stringify(zodOutputFormat(TagSchema).schema)
    for (const k of ['maxItems', 'maxLength', 'minItems', 'minLength']) expect(sent).not.toContain(`"${k}"`)
  })
})

describe('cutAt', () => {
  it('cuts at a word boundary, and leaves a short string alone', () => {
    expect(cutAt('ask not what your country can do', 16)).toBe('ask not what')
    expect(cutAt('short', 40)).toBe('short')
    expect(cutAt('x'.repeat(50), 40)).toBe('x'.repeat(40))
    // A space only early on would cut away most of the sentence: cut hard at the limit instead.
    expect(cutAt('ab ' + 'c'.repeat(60), 40)).toBe('ab ' + 'c'.repeat(37))
  })
})

describe('repairToSchema', () => {
  it('passes a good answer through untouched', () => {
    expect(repairToSchema(TagSchema, tag())).toEqual({ data: tag(), repairs: 0 })
  })
  it('keeps the card when the model writes one tag too many or one answer too long', () => {
    const raw = tag()
    raw.tags = Array.from({ length: 11 }, (_, i) => ({ label: `subject ${i}`, kind: 'subject', layer: null }))
    raw.predicted.why_like = ['a'.repeat(100) + ' ' + 'b'.repeat(60), 'two', 'three', 'four']
    const out = repairToSchema(TagSchema, raw)!
    expect(out.data.tags).toHaveLength(8)
    expect(out.data.predicted.why_like).toEqual(['a'.repeat(100), 'two', 'three'])
    expect(out.repairs).toBe(3)
    expect(raw.tags).toHaveLength(11) // the model's answer itself is never changed
  })
  it('drops only the item that is too short', () => {
    const raw = tag()
    raw.tags = [{ label: 'x', kind: 'subject', layer: null }, { label: 'kept', kind: 'subject', layer: null }]
    raw.predicted.would_do = ['ok', 'make one like it', 'no']
    const out = repairToSchema(TagSchema, raw)!
    expect(out.data.tags.map(t => t.label)).toEqual(['kept'])
    expect(out.data.predicted.would_do).toEqual(['make one like it'])
  })
  it('still fails what is not a limit: a wrong word, a missing field, a wrong type', () => {
    expect(repairToSchema(TagSchema, { ...tag(), route: 'post_it' })).toBeNull()
    const { facets: _f, ...noFacets } = tag()
    expect(repairToSchema(TagSchema, noFacets)).toBeNull()
    expect(repairToSchema(TagSchema, { ...tag(), tags: 'the hook' })).toBeNull()
  })
  it('repairs an explain batch instead of losing all of it', () => {
    const why = (s: string) => ({ statement: s, kind: 'subject', layer: null, origin: 'model_guess' })
    const raw = { items: [
      { ref: 0, whys: [why('He likes a number that lands early.'), why('too short'), why('It shows the money.'), why('It names the cost.'), why('A fourth reason.')] },
      { ref: -1, whys: [why('A reason for an item that does not exist.')] },
    ] }
    const out = repairToSchema(WhySchema, raw)!
    expect(out.data.items).toHaveLength(1)
    expect(out.data.items[0]!.whys.map(w => w.statement)).toEqual(['He likes a number that lands early.', 'It shows the money.', 'It names the cost.'])
  })
  it('drops a claim with no support and keeps a quote a true prefix of his words', () => {
    const claim = (statement: string, support: number[]): any => ({
      statement, lane: 'voice', layer: null, kind: 'subject', why: 'Because he said so twice.', means: 'Write it that way next time.',
      support, counter: [], krish_quote_ref: 0, krish_quote: 'word '.repeat(100).trim(), flip_rule: 'If he says otherwise twice.',
    })
    const out = repairToSchema(ClaimSchema, { claims: [claim('A claim with nothing under it.', []), claim('A claim he backed twice.', [0, 1])] })!
    expect(out.data.claims).toHaveLength(1)
    const q = out.data.claims[0]!.krish_quote!
    expect(q.length).toBeLessThanOrEqual(400)
    expect('word '.repeat(100)).toContain(q)
  })
})
