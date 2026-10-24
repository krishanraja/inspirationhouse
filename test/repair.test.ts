import { describe, it, expect } from 'vitest'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { cutAt, repairToSchema } from '../src/repair.ts'
import { TagSchema } from '../src/tag/items.ts'
import { WhySchema } from '../src/explain/whys.ts'
import { ClaimSchema } from '../src/distil/claims.ts'

const tag = (): any => ({
  tags: [{ label: 'the hook', kind: 'form', layer: 'opening' }],
  predicted: { why_here: ['a sharp opening'], why_like: ['it gets to the point'], would_do: ['try the same hook'] },
  route: 'make_piece', kind: null, opinion: null, reason: null, piece_ref: null,
  facets: { platform: 'unknown', format: 'document', source: null, creator: null, people: [], organisations: [], topics: [] },
})

describe('the limits are not enforced by the API', () => {
  it('is why the answer is repaired here: the schema it gets carries none of them as limits', () => {
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
  it('drops a claim with no support, and never cuts a quote of his', () => {
    const quote = 'word '.repeat(100).trim()
    const claim = (statement: string, support: number[]): any => ({
      statement, lane: 'voice', layer: null, kind: 'subject', why: 'Because he said so twice.', means: 'Write it that way next time.',
      support, counter: [], krish_quote_ref: 0, krish_quote: quote, flip_rule: 'If he says otherwise twice.',
    })
    const out = repairToSchema(ClaimSchema, { claims: [claim('A claim with nothing under it.', []), claim('A claim he backed twice.', [0, 1])] })!
    expect(out.data.claims).toHaveLength(1)
    expect(out.data.claims[0]!.krish_quote).toBe(quote) // whole; resolveClaim drops it for being over 400
  })
  it('never splits a character in two when it cuts', () => {
    const cut = cutAt('a' + '\u{1F600}'.repeat(70), 140)
    expect(cut.length).toBeLessThanOrEqual(140)
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false)
    expect(() => JSON.parse(JSON.stringify(cut))).not.toThrow()
    expect(cut.endsWith('\u{1F600}')).toBe(true)
  })
  it('drops an item that only came back to fill a place, whatever is wrong with it', () => {
    // Ten tags where eight are allowed: the first two are too short and dropped, the ninth and tenth come back, and
    // the tenth names a kind outside the enum. It goes; the card keeps its seven good tags.
    const raw = tag()
    raw.tags = Array.from({ length: 10 }, (_, i) => ({ label: i < 2 ? 'x' : `subject ${i}`, kind: i === 9 ? 'craft' : 'subject', layer: null }))
    const out = repairToSchema(TagSchema, raw)!
    expect(out.data.tags.map((t: { label: string }) => t.label)).toEqual(['subject 2', 'subject 3', 'subject 4', 'subject 5', 'subject 6', 'subject 7', 'subject 8'])
    // The same wrong kind among the eight it kept is still a failure.
    const kept = tag()
    kept.tags = [{ label: 'subject 0', kind: 'craft', layer: null }]
    expect(repairToSchema(TagSchema, kept)).toBeNull()
  })
})
