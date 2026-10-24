import { describe, it, expect } from 'vitest'
import { renderItem, explainPending, EXPLAIN_PROMPT_REV } from '../src/explain/whys.ts'
import { answerEvidence, type AnsweredRow } from '../src/tag/items.ts'
import { normalise } from '../src/evidence.ts'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'

// Synthetic evidence only; nothing here is anything Krish said.
const answered = (over: Partial<AnsweredRow>): AnsweredRow => ({
  id: 'card-1', lane: 'production', name: 'clip.mp4', why_here: null, why_like: null, why_like_source: null, would_do: null,
  route: null, confirmed_tags: [], answered_at: '2026-10-24T10:00:00Z', read_as: null, note_for_claude: null,
  picked_likes: [], routes: [], kind: null, piece_id: null, ...over,
})
const pendingOf = (row: AnsweredRow, id = 'e1') => {
  const e = normalise(answerEvidence(row))
  return { id, source: e.source, polarity: e.polarity, lane: e.lane, layer: e.layer, title: e.title, excerpt: e.excerpt, meta: e.meta, attribution: e.attribution }
}

describe('renderItem for an Inspiration answer', () => {
  it('shows every part of it, each labelled, his words as his and his taps as reasons he agreed with', () => {
    const text = renderItem(0, pendingOf(answered({
      why_like: 'the cut on the beat', why_like_source: 'typed', why_here: 'for my opener', would_do: 'try it Monday',
      picked_likes: ['tight pacing', 'clean captions'], confirmed_tags: ['hook', 'jump cut'], routes: ['study_style', 'make_piece'], kind: 'video',
      note_for_claude: 'skip the intro',
    })))
    expect(text).toContain('Krish said what he likes about it: the cut on the beat')
    expect(text).toContain('Krish said why he saved it: for my opener')
    expect(text).toContain('Krish said what he would do with it: try it Monday')
    expect(text).toContain('Reasons he agreed with (guesses he tapped, not his words): tight pacing; clean captions')
    expect(text).toContain('Tags he confirmed: hook, jump cut')
    expect(text).toContain('Where he sent it: study its style; make a piece from it')
    expect(text).toContain('What kind of thing it is: video')
    // The excerpt is one of those parts, so it is not shown a second time; an instruction is never a why.
    expect(text.match(/the cut on the beat/g)).toHaveLength(1)
    expect(text).not.toContain('skip the intro')
  })

  it('shows taps alone as taps, never as his words', () => {
    const text = renderItem(0, pendingOf(answered({ why_like: 'tight pacing', why_like_source: 'picked', picked_likes: ['tight pacing'], route: 'taste_only' })))
    expect(text).not.toContain('Krish said')
    expect(text.match(/tight pacing/g)).toHaveLength(1)
    expect(text).toContain('Where he sent it: just taste')
  })

  it('leaves other sources as they were', () => {
    const text = renderItem(2, { id: 'x', source: 'title_verdicts', polarity: 'likes', lane: 'voice', layer: 'packaging', title: 'A title', excerpt: 'this one', meta: { why: 'concrete' }, attribution: 'krish_words' })
    expect(text).toBe('<item ref="2" source="title_verdicts" lane="voice" verdict="likes">\nwhat: A title\nKrish said: this one\nrecorded reason: concrete\n</item>')
  })
})

describe('explainPending', () => {
  const rows = ['e1', 'e2', 'e3'].map(id => pendingOf(answered({ why_here: `reason ${id}` }), id))
  function fakeDb() {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const selects: string[] = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
        if (o?.write) { writes.push({ sql, params }); return [] as T[] }
        selects.push(sql)
        return rows as T[]
      },
      close: async () => {},
    }
    return { db, writes, selects }
  }
  const llm = (answer: (n: number) => Promise<unknown>): Llm => {
    let n = 0
    return { model: 'm', structured: async () => (await answer(++n)) as never }
  }
  const whys = { items: [{ ref: 0, whys: [{ statement: 'He wants the cut to land on the beat.', kind: 'form', layer: 'editing', origin: 'krish' }] }] }

  it('reads only evidence never read and still standing', async () => {
    const { db, selects } = fakeDb()
    await explainPending(db, llm(async () => ({ data: { items: [] }, failure: null, model: 'm' })), 'run')
    expect(selects[0]).toMatch(/e\.explained_at is null and e\.withdrawn_at is null/)
  })

  it('marks every item of a batch read, those given no why too', async () => {
    const { db, writes } = fakeDb()
    const r = await explainPending(db, llm(async () => ({ data: whys, failure: null, model: 'm' })), 'run')
    expect(r).toMatchObject({ items: 3, whys: 1, failed: 0 })
    expect(JSON.parse(writes[0]!.params[0] as string)[0]).toMatchObject({ evidence_id: 'e1', prompt_rev: EXPLAIN_PROMPT_REV })
    const read = writes.find(w => /set explained_at = now\(\)/.test(w.sql))!
    expect(JSON.parse(read.params[0] as string)).toEqual(['e1', 'e2', 'e3'])
  })

  it('marks nothing read for a failed batch, whether refused or thrown', async () => {
    for (const answer of [async () => ({ data: null, failure: 'refusal', model: 'm' }), async () => { throw Object.assign(new Error('overloaded'), { status: 529 }) }]) {
      const { db, writes } = fakeDb()
      const r = await explainPending(db, llm(answer), 'run')
      expect(r).toMatchObject({ items: 3, failed: 3, whys: 0 })
      expect(writes).toEqual([])
    }
  })

  it('writes nothing on a dry run', async () => {
    const { db, writes } = fakeDb()
    await explainPending(db, llm(async () => ({ data: whys, failure: null, model: 'm' })), 'run', { write: false })
    expect(writes).toEqual([])
  })
})
