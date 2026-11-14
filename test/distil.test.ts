import { describe, it, expect } from 'vitest'
import { resolveClaim, claimFingerprint, DISTIL_SYSTEM, type WhyRow, type DraftClaim } from '../src/distil/claims.ts'

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

  it('never keeps a quote cut to fit: one over 400 characters is dropped whole, and the claim kept', () => {
    const long = 'he said it plainly and then said it again '.repeat(12).trim()
    const r = resolveClaim(draft({ krish_quote: long }), [why(1, { excerpt: long }), why(2), why(3)])!
    expect(long.length).toBeGreaterThan(400)
    expect(r.krish).toBeNull()
    expect(r.evidenceIds).toHaveLength(3)
  })

  it('drops a quote attributed to a line that is not his words', () => {
    const notHis = [why(1, { attribution: 'krish_action' }), why(2), why(3)]
    expect(resolveClaim(draft({ counter: [] }), notHis)!.krish).toBeNull()
  })

  it('refuses a form claim with no craft layer', () => {
    expect(resolveClaim(draft({ layer: null }), whys)).toBeNull()
  })

  it('keeps how the engine works out of taste (Krish, 2026-11-03: "the taste ledger is a mess with loads of random stuff")', () => {
    expect(DISTIL_SYSTEM).toMatch(/How the engine, its tools, its files, its boards or a session should work is never a claim/)
  })

  it('fingerprints the same claim the same way through punctuation and case', () => {
    expect(claimFingerprint(draft({ statement: 'Titles should say what happens, in plain words!' })))
      .toBe(claimFingerprint(draft({ statement: 'titles should say what happens in plain words' })))
  })
})

import { distil } from '../src/distil/claims.ts'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'

describe('distil against the database', () => {
  function fake() {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = []) {
        calls.push({ sql, params })
        if (/select distinct e\.venture/.test(sql)) return [{ venture: 'publication' }] as T[]
        if (/from public\.taste_whys/.test(sql)) return whys as T[]
        if (/with prior as/.test(sql)) return [{ n: 1 }] as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, calls }
  }
  const llm = (claim: DraftClaim): Llm => ({ model: 'stub', structured: async () => ({ data: { claims: [claim] } as never, failure: null, model: 'stub' }) })

  it('names the venture and the kind of each failed answer, so a failed run can be diagnosed', async () => {
    const { db } = fake()
    const cut: Llm = { model: 'stub', structured: async () => ({ data: null, failure: 'max_tokens', model: 'stub' }) }
    const r = await distil(db, cut, 'run', false)
    expect(r.failed).toBe(true)
    expect(r.failures).toEqual(['publication:max_tokens'])
  })

  it('reads only evidence still standing, one venture at a time', async () => {
    const { db, calls } = fake()
    await distil(db, llm(draft()), 'run', false)
    expect(calls[0]!.sql).toMatch(/e\.withdrawn_at is null/)
    const read = calls.find(c => /select w\.id::text/.test(c.sql))!
    expect(read.sql).toMatch(/e\.venture = \$1 and [\s\S]*e\.withdrawn_at is null/)
    expect(read.params).toEqual(['publication'])
  })

  it('writes the quote this draft resolved on an update, so a claim re-cited without its old quote never keeps it', async () => {
    const { db, calls } = fake()
    await distil(db, llm(draft({ krish_quote: null, krish_quote_ref: null })), 'run', true)
    const write = calls.find(c => /with prior as/.test(c.sql))!
    expect(write.sql).toMatch(/set evidence_ids = [\s\S]*krish = \$8, krish_source_id = \$9::uuid, status = 'candidate'\s+from prior/)
    expect(write.params[7]).toBeNull()
    expect(write.params[8]).toBeNull()
    const quoted = fake()
    await distil(quoted.db, llm(draft()), 'run', true)
    const w2 = quoted.calls.find(c => /with prior as/.test(c.sql))!
    expect(w2.params[7]).toBe('plain words')
    expect(w2.params[8]).toBe('00000000-0000-0000-0000-000000000001')
  })
})

describe('a venture whose answer runs out of room is read again in halves', () => {
  // Heartside's weekly answer was cut off at max_tokens on 7 and 14 Nov 2026 (counts.distil_failures
  // heartside:max_tokens) while its 49 whys of 31 Oct answered: too many whys for one answer, as the floor found.
  const many = (n: number): WhyRow[] => Array.from({ length: n }, (_, i) => ({
    id: `w${i}`, evidence_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, statement: `why ${i}`, kind: 'form',
    layer: 'packaging', lane: 'voice', polarity: 'likes', source: 'title_verdicts', attribution: 'krish_words',
    excerpt: `he said plain words ${i}`, occurred_at: '2026-11-01T00:00:00Z',
  }))
  function fakeDb(rows: WhyRow[]) {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = []) {
        calls.push({ sql, params })
        if (/select distinct e\.venture/.test(sql)) return [{ venture: 'heartside' }] as T[]
        if (/from public\.taste_whys/.test(sql)) return rows as T[]
        if (/with prior as/.test(sql)) return [{ n: 1 }] as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, calls }
  }
  /** A model that runs out of room above `room` whys, and otherwise drafts one claim (or the one it is told) citing
   *  the part's first three whys. It keeps each prompt it was sent. */
  function roomy(room: number, statementFor: (call: number) => string = () => 'Titles should say what happens in plain words.') {
    const prompts: string[] = []
    const llm: Llm = {
      model: 'stub',
      structured: async ({ content }) => {
        const text = (content[0] as { text: string }).text
        prompts.push(text)
        const n = (text.match(/<why ref=/g) ?? []).length
        if (n > room) return { data: null, failure: 'max_tokens', model: 'stub' }
        return { data: { claims: [draft({ statement: statementFor(prompts.length), support: [0, 1, 2], counter: [], krish_quote: null, krish_quote_ref: null })] } as never, failure: null, model: 'stub' }
      },
    }
    return { llm, prompts }
  }

  it('reads a cut-off venture again as two halves, keeps both answers and records no failure', async () => {
    const rows = many(40)
    const { db } = fakeDb(rows)
    const { llm, prompts } = roomy(25, call => `Claim number ${call} says what happens in plain words.`)
    const r = await distil(db, llm, 'run', false)
    expect(prompts).toHaveLength(3)
    expect((prompts[1]!.match(/<why ref=/g) ?? []).length).toBe(20)
    expect((prompts[2]!.match(/<why ref=/g) ?? []).length).toBe(20)
    expect(r.failed).toBe(false)
    expect(r.failures).toEqual([])
    expect(r.splits).toBe(1)
    expect(r.calls).toBe(3)
    expect(r.drafted).toBe(2)
    expect(r.resolved).toBe(2)
  })

  it('resolves each half against its own whys, and shows the second half what the first drafted', async () => {
    const rows = many(40)
    const { db, calls } = fakeDb(rows)
    const { llm, prompts } = roomy(25, call => `Claim number ${call} says what happens in plain words.`)
    await distil(db, llm, 'run', true)
    expect(prompts[2]).toContain('- Claim number 2 says what happens in plain words.')
    const writes = calls.filter(c => /with prior as/.test(c.sql))
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[0]!.params[1] as string)).toEqual(rows.slice(0, 3).map(w => w.evidence_id))
    expect(JSON.parse(writes[1]!.params[1] as string)).toEqual(rows.slice(20, 23).map(w => w.evidence_id))
  })

  it('writes a claim both halves drafted once, on the evidence of both', async () => {
    const rows = many(40)
    const { db, calls } = fakeDb(rows)
    const { llm } = roomy(25)
    const r = await distil(db, llm, 'run', true)
    expect(r.resolved).toBe(1)
    const writes = calls.filter(c => /with prior as/.test(c.sql))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!.params[1] as string)).toEqual([...rows.slice(0, 3), ...rows.slice(20, 23)].map(w => w.evidence_id))
  })

  it('splits again while a half is still too big, and fails only a part too small to split', async () => {
    const { db } = fakeDb(many(80))
    const deep = roomy(25)
    const r = await distil(db, deep.llm, 'run', false)
    expect(r.failed).toBe(false)
    expect(r.splits).toBe(3)
    const small = fakeDb(many(20))
    const never = roomy(5)
    const s = await distil(small.db, never.llm, 'run', false)
    expect(never.prompts).toHaveLength(1)
    expect(s.failed).toBe(true)
    expect(s.failures).toEqual(['heartside:max_tokens'])
  })

  it('keeps one item’s whys in one half, so no item is cut in two', async () => {
    const rows = many(40).map((w, i) => ({ ...w, evidence_id: `00000000-0000-0000-0000-${String(Math.floor(i / 3)).padStart(12, '0')}` }))
    const { db } = fakeDb(rows)
    const { llm, prompts } = roomy(25, call => `Claim number ${call} says what happens in plain words.`)
    await distil(db, llm, 'run', false)
    // 40 whys in items of three: the middle, row 20, is the last of item 6 (rows 18 to 20), so the first half ends there.
    expect((prompts[1]!.match(/<why ref=/g) ?? []).length).toBe(21)
    expect((prompts[2]!.match(/<why ref=/g) ?? []).length).toBe(19)
  })
})
