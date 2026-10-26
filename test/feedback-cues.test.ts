import { describe, it, expect } from 'vitest'
import {
  classify, themeOf, queueThreads, cardThreads, assemble, planCues, syncCues, saidHash, CUE_PROMPT_REV,
  type Said, type Reading, type ExistingCue, type QueueRow, type CardRow,
} from '../src/collect/feedbackCues.ts'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'
import { safeFields } from '../src/log.ts'

// Synthetic words only; nothing here is anything Krish said.
const said = (text: string, extra: Partial<Said> = {}): Said => ({
  source: 'idea_queue', subjectRef: 'idea-1', subject: 'An idea about chips', said: text, saidAt: '2026-10-20T10:00:00.000Z',
  verdict: 'angle', field: 'triage', routes: [], ...extra,
})
const t = (verdict: string, words: string | null, at = '2026-10-20T10:00:00.000Z') => ({ verdict, said: words, decided_by: 'Krish', at })

describe('reading the use his words name', () => {
  it('keeps material for a bigger piece, under the theme he names', () => {
    expect(classify(said('Hold onto this for a broader chip supply piece.'))).toMatchObject({ use: 'wider_piece_context', theme: 'chip supply', origin: 'krish' })
    expect(classify(said('Keep it as context for a bigger piece.'))).toMatchObject({ use: 'wider_piece_context', theme: null, origin: 'krish' })
    expect(classify(said('Save the numbers as context for a wider piece on robot pricing.'))).toMatchObject({ use: 'wider_piece_context', theme: 'robot pricing' })
  })

  it('reads a pattern to watch, a piece for later, and a no', () => {
    expect(classify(said('Keep an eye on how this plays out over time.'))).toMatchObject({ use: 'track_over_time', origin: 'krish' })
    expect(classify(said('Park this for later.'))).toMatchObject({ use: 'future_piece', origin: 'krish' })
    expect(classify(said('This one has to be saved for the future.', { verdict: 'story' }))).toMatchObject({ use: 'future_piece', origin: 'krish' })
    expect(classify(said('Ditch it.', { verdict: 'drop' }))).toMatchObject({ use: 'not_for_us', origin: 'krish' })
  })

  it('falls back to his verdict, and says the use came from a rule', () => {
    expect(classify(said('Too thin.', { verdict: 'drop' }))).toMatchObject({ use: 'not_for_us', origin: 'rule', rule: 'verdict_drop' })
    expect(classify(said('Yes, run it.', { verdict: 'story' }))).toMatchObject({ use: 'future_piece', origin: 'rule' })
    expect(classify(said('Explain both sides plainly.', { verdict: 'angle' }))).toMatchObject({ use: 'brief', origin: 'rule' })
  })

  it('leaves a remark no rule reads to the model', () => {
    expect(classify(said('Interesting, but why should a manager care?', { verdict: 'curious' }))).toBeNull()
  })

  it('reads a card by its route, and never makes a subject of what he likes about its form', () => {
    const card = (field: string, routes: string[]) => said('the way it builds the argument', { source: 'inspiration_card', verdict: null, field, routes })
    expect(classify(card('why_like', []))).toBe('skip')
    expect(classify(card('would_do', ['make_piece']))).toMatchObject({ use: 'future_piece', origin: 'rule', rule: 'route_make_piece' })
    expect(classify(card('why_here', ['study_style']))).toBe('skip')
    expect(classify(card('why_here', []))).toBeNull()
  })

  it('takes no size word for a theme', () => {
    expect(themeOf('for a bigger future piece')).toBeNull()
    expect(themeOf('for a broader superconductors piece')).toBe('superconductors')
  })
})

describe('the idea queue', () => {
  it('reads only answers decided by Krish, oldest first, and a tap makes no words', () => {
    const rows: QueueRow[] = [
      { id: 'idea-1', idea: 'Chips', at: '2026-10-21 10:00:00+00', triage: t('angle', 'Save this for later.', '2026-10-21T10:00:00.000Z'),
        history: [t('story', null, '2026-10-19T10:00:00.000Z'), { verdict: 'drop', said: 'a session wrote this', decided_by: 'Claude Code' }] },
      { id: 'idea-2', idea: 'Robots', at: '2026-10-21 10:00:00+00', triage: { verdict: 'story', said: 'not his', decided_by: 'engine' }, history: null },
    ]
    const th = queueThreads(rows)
    expect(th).toHaveLength(1)
    expect(th[0]!.entries.map(e => [e.verdict, e.said?.said ?? null])).toEqual([['story', null], ['angle', 'Save this for later.']])
    expect(th[0]!.entries[1]!.said).toMatchObject({ subject: 'Chips', saidAt: '2026-10-21T10:00:00.000Z' })
  })
})

describe('Inspiration cards', () => {
  it('reads why he saved it and what he would do, and what he likes only when he typed it', () => {
    const row: CardRow = { id: 'card-1', name: 'post_one.jpg', facets: { platform: 'instagram', link: { author: 'someone' } },
      why_here: 'the chart says it all', why_like: 'a guess he tapped', why_like_source: 'picked', would_do: 'make a piece from the chart',
      route: 'make_piece', routes: ['make_piece'], at: '2026-10-22 09:00:00+00' }
    const th = cardThreads([row])
    expect(th.map(x => x.entries[0]!.said!.field)).toEqual(['why_here', 'would_do'])
    expect(th[0]!.entries[0]!.said!.subject).toBe('Inspiration card "post one" by someone (instagram)')
    expect(cardThreads([{ ...row, why_like_source: 'typed' }]).map(x => x.entries[0]!.said!.field)).toEqual(['why_here', 'would_do', 'why_like'])
  })
})

describe('from answers to cues', () => {
  const thread = (entries: Array<{ verdict: string | null; said: Said | null }>) => [{ source: 'idea_queue' as const, subjectRef: 'idea-1', entries }]
  const read = (pairs: Array<[Said, Reading]>) => new Map(pairs)

  it('a changed answer of the same use updates its cue, and a different use stands beside it', () => {
    const a = said('Explain it from the buyer side.')
    const b = said('Explain it from the seller side.')
    const c = said('Park this for later.')
    const cues = assemble(thread([{ verdict: 'angle', said: a }, { verdict: 'angle', said: b }, { verdict: 'angle', said: c }]),
      read([[a, classify(a) as Reading], [b, classify(b) as Reading], [c, classify(c) as Reading]]))
    expect(cues.map(x => [x.sourceRef, x.said, x.superseded])).toEqual([
      ['idea-1:brief', 'Explain it from the seller side.', false],
      ['idea-1:future_piece', 'Park this for later.', false],
    ])
  })

  it('a later drop, even a tap, retires what came before it; a later yes retires the no', () => {
    const a = said('Park this for later.', { verdict: 'story' })
    let cues = assemble(thread([{ verdict: 'story', said: a }, { verdict: 'drop', said: null }]), read([[a, classify(a) as Reading]]))
    expect(cues.map(x => [x.use, x.superseded])).toEqual([['future_piece', true]])
    const no = said('Ditch it.', { verdict: 'drop' })
    cues = assemble(thread([{ verdict: 'drop', said: no }, { verdict: 'story', said: null }]), read([[no, classify(no) as Reading]]))
    expect(cues.map(x => [x.use, x.superseded])).toEqual([['not_for_us', true]])
  })

  it('labels a guess with its model and prompt revision, and remembers it on the cue', () => {
    const a = said('Why would a manager care?', { verdict: 'curious' })
    const cues = assemble(thread([{ verdict: 'curious', said: a }]), read([[a, { use: 'brief', theme: 'x', origin: 'model_guess', rule: 'model_guess', model: 'm1' }]]))
    expect(cues[0]).toMatchObject({ useOrigin: 'model_guess', theme: null })
    expect(cues[0]!.meta).toMatchObject({ model: 'm1', prompt_rev: CUE_PROMPT_REV, guesses: { [saidHash(a.said)]: { use: 'brief' } } })
  })
})

describe('planning the writes', () => {
  const a = said('Park this for later.', { verdict: 'story' })
  const [cue] = assemble([{ source: 'idea_queue', subjectRef: 'idea-1', entries: [{ verdict: 'story', said: a }] }], new Map([[a, classify(a) as Reading]]))
  const row = (extra: Partial<ExistingCue> = {}): ExistingCue => ({
    id: 'c1', source: 'idea_queue', source_ref: cue!.sourceRef, subject_ref: 'idea-1', subject: cue!.subject, said: cue!.said,
    said_at: '2026-10-20 10:00:00+00', use: cue!.use, theme: null, use_origin: cue!.useOrigin, status: 'open', meta: cue!.meta, ...extra,
  })

  it('inserts a new cue, and a rerun is a no-op', () => {
    expect(planCues([], [cue!], ['idea_queue']).insert).toHaveLength(1)
    expect(planCues([row()], [cue!], ['idea_queue'])).toEqual({ insert: [], update: [], withdraw: [], superseded: 0 })
  })

  it('updates a cue whose words changed, and withdraws one whose answer is gone', () => {
    expect(planCues([row({ said: 'older words' })], [cue!], ['idea_queue']).update.map(u => u.id)).toEqual(['c1'])
    expect(planCues([row(), row({ id: 'c2', source_ref: 'idea-2:brief', subject_ref: 'idea-2' })], [cue!], ['idea_queue']).withdraw).toEqual(['c2'])
  })

  it('never touches a used cue, never reopens one retired by a person, and reopens one the engine retired', () => {
    expect(planCues([row({ status: 'used', said: 'older words' })], [cue!], ['idea_queue']).update).toEqual([])
    expect(planCues([row({ status: 'retired', meta: { ...cue!.meta, retired_by: 'Krish' } })], [cue!], ['idea_queue']).update).toEqual([])
    expect(planCues([row({ status: 'retired', meta: { ...cue!.meta, retired_by: 'withdrawn' } })], [cue!], ['idea_queue']).update[0]).toMatchObject({ status: 'open' })
  })

  it('withdraws nothing from a source not read whole, or from a subject still waiting for its reading', () => {
    const other = row({ id: 'c2', source_ref: 'idea-2:brief', subject_ref: 'idea-2' })
    expect(planCues([other], [cue!], []).withdraw).toEqual([])
    expect(planCues([other], [cue!], ['idea_queue'], new Set(['idea-2'])).withdraw).toEqual([])
  })
})

describe('the stage', () => {
  const queue: QueueRow[] = [
    { id: '11111111-1111-4111-8111-111111111111', idea: 'Chips', at: '2026-10-21 10:00:00+00', history: null,
      triage: t('angle', 'Keep it as context for a broader chip supply piece.') },
    { id: '22222222-2222-4222-8222-222222222222', idea: 'Robots', at: '2026-10-21 10:00:00+00', history: null,
      triage: t('curious', 'Why would a manager care?') },
  ]
  function fakeDb(opts: { missing?: boolean; existing?: ExistingCue[] } = {}) {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
        if (o?.write) { writes.push({ sql, params }); return [{ n: JSON.parse(params[0] as string).length }] as T[] }
        if (/to_regclass\('public\.feedback_cues'\)/.test(sql)) return [{ ok: !opts.missing }] as T[]
        if (/from public\.content_ideas/.test(sql)) return queue as T[]
        if (/from public\.inspiration_items/.test(sql)) return [] as T[]
        if (/from public\.feedback_cues/.test(sql)) return (opts.existing ?? []) as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, writes }
  }
  const llm = (answer: () => Promise<unknown>) => {
    const asked: string[] = []
    const l: Llm = { model: 'm', structured: async (args) => { asked.push(JSON.stringify(args.content)); return (await answer()) as never } }
    return { l, asked }
  }
  const guess = async () => ({ data: { items: [{ ref: 0, use: 'brief', theme: null }] }, failure: null, model: 'm1' })

  it('reads by rule first, asks the model only about the rest, and writes the cues', async () => {
    const { db, writes } = fakeDb()
    const { l, asked } = llm(guess)
    const r = await syncCues(db, l, { write: true, cards: true })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Why would a manager care?')
    expect(asked[0]).not.toContain('chip supply')
    expect(r).toMatchObject({ inputs: 2, cues: 2, guessed: 1, inserted: 2, failed: 0, missing: false })
    const ins = JSON.parse(writes[0]!.params[0] as string)
    expect(ins.map((x: { use: string; use_origin: string; theme: string | null }) => [x.use, x.use_origin, x.theme]))
      .toEqual([['wider_piece_context', 'krish', 'chip supply'], ['brief', 'model_guess', null]])
  })

  it('never asks the model twice about the same words', async () => {
    const first = fakeDb()
    await syncCues(first.db, llm(guess).l, { write: true, cards: true })
    const existing = (JSON.parse(first.writes[0]!.params[0] as string) as Array<Record<string, unknown>>)
      .map((x, i) => ({ ...x, id: `c${i}`, said_at: String(x.said_at) }) as unknown as ExistingCue)
    const again = fakeDb({ existing })
    const { l, asked } = llm(guess)
    const r = await syncCues(again.db, l, { write: true, cards: true })
    expect(asked).toEqual([])
    expect(r).toMatchObject({ reused: 1, inserted: 0, updated: 0, withdrawn: 0 })
    expect(again.writes).toEqual([])
  })

  it('writes nothing on a dry run or before the table exists, and asks no model without a table to keep the guess', async () => {
    const dry = fakeDb()
    expect(await syncCues(dry.db, llm(guess).l, { write: false, cards: true })).toMatchObject({ inserted: 2 })
    expect(dry.writes).toEqual([])
    const none = fakeDb({ missing: true })
    const { l, asked } = llm(guess)
    expect(await syncCues(none.db, l, { write: true, cards: true })).toMatchObject({ missing: true, inserted: 1, unclassified: 1 })
    expect(asked).toEqual([])
    expect(none.writes).toEqual([])
  })

  it('counts a failed guess and keeps that subject\'s cues as they are', async () => {
    const old: ExistingCue = { id: 'c9', source: 'idea_queue', source_ref: `${queue[1]!.id}:brief`, subject_ref: queue[1]!.id, subject: 'Robots',
      said: 'older words', said_at: '2026-10-19 10:00:00+00', use: 'brief', theme: null, use_origin: 'model_guess', status: 'open', meta: {} }
    const { db, writes } = fakeDb({ existing: [old] })
    const r = await syncCues(db, llm(async () => ({ data: null, failure: 'refusal', model: 'm' })).l, { write: true, cards: true })
    expect(r).toMatchObject({ failed: 1, withdrawn: 0, cues: 1 })
    expect(writes.some(w => /retired_by/.test(w.sql))).toBe(false)
  })
})

describe('the public log', () => {
  it('keeps the cue counts as numbers and nothing else', () => {
    expect(safeFields({ stage: 'cues', cues_inserted: 3, cues_table_missing: 1, said: 'his words', cues_theme: 'a theme' }))
      .toEqual({ stage: 'cues', cues_inserted: 3, cues_table_missing: 1 })
  })
})
