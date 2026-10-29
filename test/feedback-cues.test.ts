import { describe, it, expect } from 'vitest'
import {
  classify, themeOf, queueThreads, cardThreads, assemble, planCues, syncCues, saidHash, CUE_PROMPT_REV,
  boardPresses, mergePresses, MAX_SAID,
  type Said, type Reading, type ExistingCue, type QueueRow, type CardRow, type BoardRow,
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

describe('his presses on the publish board', () => {
  // Synthetic ids, weeks and words only; nothing here is anything Krish pressed or typed.
  const IDEA = 'aaaaaaaa-1111-4111-8111-111111111111'
  const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222'
  const doc = (body: Record<string, unknown>, extra: Partial<BoardRow> = {}): BoardRow => ({
    week: '2026-11-09', collection: 'queue', doc_id: IDEA, body, updated_at: '2026-11-01 09:00:00+00',
    idea_id: IDEA, idea: 'A synthetic idea about chips', ...extra,
  })
  const at = (h: number) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`
  const readAll = (said: Said[]) => new Map(said.map(x => [x, classify(x) as Reading]))
  const saidOf = (threads: Array<{ entries: Array<{ said: Said | null }> }>) => threads.flatMap(t => t.entries.flatMap(e => (e.said ? [e.said] : [])))

  it('takes the use from his tap, never from his words or the old verdict beside it', () => {
    const b = boardPresses([doc({ use: 'wider_piece_context', note: 'Ditch the intro, keep the numbers.', verdict: 'drop', at: at(9) })])
    const s = b.queue.get(IDEA)![0]!.said!
    expect(classify(s)).toMatchObject({ use: 'wider_piece_context', origin: 'krish', rule: 'board_wider' })
    const [cue] = assemble(mergePresses([], b), readAll([s]))
    expect(cue).toMatchObject({ source: 'idea_queue', sourceRef: `${IDEA}:wider_piece_context`, useOrigin: 'krish', venture: 'publication' })
    expect(cue!.meta).toMatchObject({ via: 'board', decided_by: 'Krish', press: 'wider_piece_context', board_week: '2026-11-09', board_doc: IDEA })
    expect(cue!.meta).not.toHaveProperty('verdict')
  })

  it('names a wider piece\'s theme from his note, and keeps tracked topics as they are', () => {
    const b = boardPresses([
      doc({ use: 'wider_piece_context', note: 'Keep for a broader chip supply piece.' }),
      doc({ use: 'track_over_time', note: 'Synthetic: see where this goes.' }, { doc_id: OTHER, idea_id: OTHER }),
    ])
    expect(classify(b.queue.get(IDEA)![0]!.said!)).toMatchObject({ theme: 'chip supply' })
    expect(classify(b.queue.get(OTHER)![0]!.said!)).toMatchObject({ use: 'track_over_time', origin: 'krish', theme: null })
  })

  it('files next week as a piece for later that carries the week it is queued for', () => {
    const given = boardPresses([doc({ use: 'next_week', note: 'Synthetic: next week, with the new figures.', target_week: '2026-11-16' })])
    const [cue] = assemble(mergePresses([], given), readAll(saidOf(mergePresses([], given))))
    expect(cue).toMatchObject({ use: 'future_piece', useOrigin: 'krish' })
    expect(cue!.meta).toMatchObject({ rule: 'board_next_week', target_week: '2026-11-16' })
    // No week on the press, or one that is not a Monday: the week after the board's.
    for (const target of [undefined, '2026-11-17']) {
      const b = boardPresses([doc({ use: 'next_week', note: 'Synthetic: later.', target_week: target })])
      expect(b.queue.get(IDEA)![0]!.said!.board!.targetWeek).toBe('2026-11-16')
    }
  })

  it('files a reject with his reason, and keeps a note and a reason whole together', () => {
    const b = boardPresses([doc({ use: 'not_for_us', reason: 'Synthetic: too thin.', note: 'Synthetic: seen it everywhere.' })])
    const s = b.queue.get(IDEA)![0]!.said!
    expect(s.said).toBe('Synthetic: seen it everywhere.\n\nSynthetic: too thin.')
    expect(classify(s)).toMatchObject({ use: 'not_for_us', origin: 'krish', rule: 'board_not_for_us' })
  })

  it('leaves offday to Growth, reads no document without a use, and makes no words of a wordless press', () => {
    const b = boardPresses([
      doc({ use: 'offday', day: 'tue', approved: true, note: 'Synthetic: post it.' }),
      doc({ pick: 'mon-1', queued: true, verdict: 'story' }, { doc_id: 'mon-1' }),
      doc({ use: 'something_else', note: 'Synthetic.' }, { doc_id: 'mon-2' }),
      doc({ use: 'track_over_time' }, { doc_id: OTHER, idea_id: OTHER }),
    ])
    expect(b).toMatchObject({ offday: 1, presses: 1, wordless: 1, unfiled: 0, docs: 4 })
    expect(b.queue.get(IDEA)).toBeUndefined()
    expect(b.queue.get(OTHER)).toEqual([{ verdict: null, said: null, press: 'track_over_time', at: '2026-11-01T09:00:00.000Z' }])
  })

  it('makes a pick\'s note his brief, one per week and day, and reads no pick without one', () => {
    const pick = (day: string, note?: string, idea = IDEA): BoardRow => doc({ pick: `${day}-1`, idea_id: idea, story: 'Synthetic story', day, ...(note ? { note } : {}) },
      { collection: 'picks', doc_id: day, idea_id: idea })
    const b = boardPresses([pick('mon', 'Synthetic: open on the price.'), pick('wed')])
    expect(b.presses).toBe(1)
    const [cue] = assemble(b.picks, readAll(saidOf(b.picks)))
    expect(cue).toMatchObject({ source: 'week_pick', sourceRef: '2026-11-09:mon', subjectRef: IDEA, use: 'brief', useOrigin: 'krish', venture: 'publication' })
    expect(cue!.meta).toMatchObject({ via: 'board', decided_by: 'Krish', press: 'pick', rule: 'board_pick_note' })
  })

  it('never cuts his words to fit and never files a press under a guessed subject: it says so instead', () => {
    const long = `Synthetic ${'word '.repeat(MAX_SAID / 5 + 10)}`
    const b = boardPresses([
      doc({ use: 'not_for_us', reason: long }),
      doc({ use: 'track_over_time', note: 'Synthetic: no idea row.' }, { doc_id: 'fri-3', idea_id: null }),
    ])
    expect(b).toMatchObject({ presses: 2, unfiled: 2 })
    expect([...b.held]).toEqual([IDEA])
    // Too long to keep, but still his reject: it retires what it contradicts.
    expect(b.queue.get(IDEA)).toEqual([expect.objectContaining({ press: 'not_for_us', said: null })])
  })

  it('joins a press to its idea\'s queue in the order he gave them, and a later reject retires the earlier yes', () => {
    const rows: QueueRow[] = [{ id: IDEA, idea: 'A synthetic idea about chips', at: at(8), history: null, triage: t('story', 'Park this for later.', at(8)) }]
    const b = boardPresses([doc({ use: 'not_for_us', reason: 'Synthetic: not for us after all.', at: at(10) })])
    const threads = mergePresses(queueThreads(rows), b)
    expect(threads).toHaveLength(1)
    expect(threads[0]!.entries.map(e => e.press ?? e.verdict)).toEqual(['story', 'not_for_us'])
    const cues = assemble(threads, readAll(saidOf(threads)))
    expect(cues.map(c => [c.use, c.superseded])).toEqual([['future_piece', true], ['not_for_us', false]])
  })

  it('never reads the queue\'s relay of a press again, so one press makes one cue', () => {
    const note = 'Synthetic: good for a bigger piece one day, but it needs the second source.'
    const rows: QueueRow[] = [{ id: IDEA, idea: 'A synthetic idea about chips', at: at(11), history: null, triage: t('cute', note, at(11)) }]
    const b = boardPresses([doc({ use: 'track_over_time', note, at: at(10) })])
    const threads = mergePresses(queueThreads(rows), b)
    // The relay keeps its verdict, as his tap, and loses its words.
    expect(threads[0]!.entries.map(e => [e.press ?? e.verdict, e.said?.said ?? null])).toEqual([['track_over_time', note], ['cute', null]])
    const cues = assemble(threads, readAll(saidOf(threads)))
    expect(cues.map(c => [c.use, c.useOrigin])).toEqual([['track_over_time', 'krish']])
    // Without the press the same words would have been read again by the word rules: a second cue.
    const alone = queueThreads(rows)
    expect(assemble(alone, readAll(saidOf(alone))).map(c => c.use)).toEqual(['wider_piece_context'])
  })

  it('knows the idea queue\'s cut of a long note as the same press', () => {
    const note = `Synthetic ${'long note '.repeat(80)}`.trim()
    const rows: QueueRow[] = [{ id: IDEA, idea: 'A synthetic idea about chips', at: at(11), history: null, triage: t('angle', note.slice(0, 600), at(11)) }]
    const threads = mergePresses(queueThreads(rows), boardPresses([doc({ use: 'track_over_time', note, at: at(10) })]))
    expect(threads[0]!.entries.filter(e => e.said).map(e => e.press)).toEqual(['track_over_time'])
  })

  it('gives an idea with no queue answer a thread of its own presses', () => {
    const threads = mergePresses([], boardPresses([doc({ use: 'track_over_time', note: 'Synthetic: watch it.' })]))
    expect(threads).toEqual([expect.objectContaining({ source: 'idea_queue', subjectRef: IDEA })])
  })
})

describe('the stage with the board', () => {
  const IDEA = 'cccccccc-3333-4333-8333-333333333333'
  const QUEUED = 'dddddddd-4444-4444-8444-444444444444'
  const queue: QueueRow[] = [{ id: QUEUED, idea: 'Synthetic queued idea', at: '2026-10-30 10:00:00+00', history: null,
    triage: t('angle', 'Keep it as context for a broader chip supply piece.', '2026-10-30T10:00:00.000Z') }]
  const docs: BoardRow[] = [
    { week: '2026-11-09', collection: 'queue', doc_id: IDEA, body: { use: 'next_week', note: 'Synthetic: next week please.', at: '2026-11-01T09:00:00.000Z' },
      updated_at: '2026-11-01 09:00:00+00', idea_id: IDEA, idea: 'Synthetic board idea' },
    { week: '2026-11-09', collection: 'queue', doc_id: 'eeeeeeee-5555-4555-8555-555555555555', body: { use: 'offday', day: 'sat', approved: true },
      updated_at: '2026-11-01 09:00:00+00', idea_id: 'eeeeeeee-5555-4555-8555-555555555555', idea: null },
    { week: '2026-11-09', collection: 'picks', doc_id: 'mon', body: { pick: 'mon-2', idea_id: QUEUED, story: 'Synthetic', day: 'mon', note: 'Synthetic: lead with the chart.' },
      updated_at: '2026-11-01 09:05:00+00', idea_id: QUEUED, idea: 'Synthetic queued idea' },
  ]
  function fakeDb(opts: { board?: BoardRow[] | null; existing?: ExistingCue[] } = {}) {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const reads: string[] = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
        if (o?.write) { writes.push({ sql, params }); return [{ n: JSON.parse(params[0] as string).length }] as T[] }
        reads.push(sql)
        if (/to_regclass/.test(sql)) return [{ ok: true, board: opts.board !== null }] as T[]
        if (/from public\.board_documents/.test(sql)) return (opts.board ?? docs) as T[]
        if (/from public\.content_ideas/.test(sql)) return queue as T[]
        if (/from public\.feedback_cues/.test(sql)) return (opts.existing ?? []) as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, writes, reads }
  }
  const noModel: Llm = { model: 'm', structured: async () => { throw new Error('no model may be asked about a press') } }

  it('files his presses as his, counts offday for Growth, and asks no model', async () => {
    const { db, writes, reads } = fakeDb()
    const r = await syncCues(db, noModel, { write: true, cards: false })
    expect(r).toMatchObject({ board: 2, offday: 1, boardWordless: 0, boardUnfiled: 0, boardMissing: false, inserted: 3, failed: 0 })
    // Only what he wrote himself is read from the board.
    expect(reads.find(q => /board_documents/.test(q) && !/to_regclass/.test(q))).toMatch(/updated_by = 'Krish'/)
    const ins = JSON.parse(writes[0]!.params[0] as string) as Array<Record<string, any>>
    expect(ins.map(x => [x.source, x.subject_ref, x.use, x.use_origin, x.venture])).toEqual([
      ['idea_queue', QUEUED, 'wider_piece_context', 'krish', 'publication'],
      ['idea_queue', IDEA, 'future_piece', 'krish', 'publication'],
      ['week_pick', QUEUED, 'brief', 'krish', 'publication'],
    ])
    expect(ins[1]!.meta).toMatchObject({ decided_by: 'Krish', target_week: '2026-11-16' })
    expect(ins[2]).toMatchObject({ source_ref: '2026-11-09:mon', said: 'Synthetic: lead with the chart.' })
  })

  it('withdraws a pick\'s cue once the pick changes, and nothing his presses made when the board reads empty', async () => {
    const first = fakeDb()
    await syncCues(first.db, noModel, { write: true, cards: false })
    const existing = (JSON.parse(first.writes[0]!.params[0] as string) as Array<Record<string, unknown>>)
      .map((x, i) => ({ ...x, id: `c${i}`, said_at: String(x.said_at) }) as unknown as ExistingCue)
    const changed = fakeDb({ existing, board: docs.filter(d => d.collection !== 'picks') })
    expect(await syncCues(changed.db, noModel, { write: false, cards: false })).toMatchObject({ withdrawn: 1, inserted: 0 })
    for (const board of [[], null]) {
      const empty = fakeDb({ existing, board })
      expect(await syncCues(empty.db, noModel, { write: false, cards: false })).toMatchObject({ withdrawn: 0, boardMissing: board === null })
    }
  })
})

describe('the public log', () => {
  it('keeps the cue counts as numbers and nothing else', () => {
    expect(safeFields({ stage: 'cues', cues_inserted: 3, cues_table_missing: 1, cues_offday: 2, said: 'his words', cues_theme: 'a theme' }))
      .toEqual({ stage: 'cues', cues_inserted: 3, cues_table_missing: 1, cues_offday: 2 })
  })
})
