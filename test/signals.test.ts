import { describe, it, expect } from 'vitest'
import {
  resolveSignal, renderEvidence, patternsOf, extractSignals, hisWords, contextOf, SIGNAL_SYSTEM, SIGNAL_PROMPT_REV, type EvidenceRow,
} from '../src/signal/extract.ts'
import { DIMENSIONS, FORM_DIMENSIONS, VOCAB, slugOf, kindOf } from '../src/signal/vocab.ts'
import { normalise, versionOf, FULL_TEXT, type Evidence } from '../src/evidence.ts'
import { safeFields } from '../src/log.ts'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'

// Synthetic evidence only; nothing here is anything Krish said.
const row = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: 'e1', source: 'learnings_json', polarity: 'dislikes', lane: 'voice', layer: null, title: 'a rule',
  excerpt: 'the ending drags and the hook is great', meta: {}, attribution: 'krish_words',
  card_facets: null, card_kind: null, card_kind_source: null, venture: 'publication', ...over,
})
const raw = (over: Record<string, unknown> = {}) => ({
  dimension: 'close', attribute: 'surprise_last', label: null, polarity: 'dislikes' as const, strength: 2,
  span: 'the ending drags', reference: null, ...over,
})

describe('the vocabulary', () => {
  it('names every craft layer, subject and workflow, each slug in the shape the table holds', () => {
    expect(DIMENSIONS).toEqual([...FORM_DIMENSIONS, 'subject', 'workflow'])
    for (const d of DIMENSIONS) {
      expect(Object.keys(VOCAB[d]).length).toBeGreaterThan(0)
      for (const a of Object.keys(VOCAB[d])) expect(`${d}.${a}`).toMatch(/^[a-z][a-z_]{1,31}\.[a-z][a-z0-9_]{1,47}$/)
    }
    expect(kindOf('tone')).toBe('form')
    expect(kindOf('subject')).toBe('subject')
    expect(kindOf('workflow')).toBe('workflow')
  })

  it('maps a known attribute with or without its dimension, and anything else to other', () => {
    expect(slugOf('tone', 'dry_aside')).toBe('tone.dry_aside')
    expect(slugOf('tone', 'tone.dry_aside')).toBe('tone.dry_aside')
    // What every object inherits is no tag of his.
    for (const a of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(slugOf('tone', a)).toBe('tone.other')
    expect(slugOf('tone', 'Dry Aside')).toBe('tone.dry_aside')
    expect(slugOf('tone', 'whimsical')).toBe('tone.other')
    expect(slugOf('subject', 'anything')).toBe('subject.topic')
  })

  it('is shown to the model, every dimension', () => {
    for (const d of DIMENSIONS) expect(SIGNAL_SYSTEM).toContain(`${d}: `)
  })
})

describe('resolveSignal', () => {
  it('keeps a phrase that is his words verbatim, as his', () => {
    const s = resolveSignal(raw(), row())!
    expect(s).toMatchObject({ origin: 'krish', span: 'the ending drags', attribute: 'close.surprise_last', kind: 'form', label: null })
  })

  it('makes a signal whose phrase is not his words a guess, and keeps no phrase', () => {
    const s = resolveSignal(raw({ span: 'the ending is slow' }), row())!
    expect(s).toMatchObject({ origin: 'model_guess', span: null })
    expect(resolveSignal(raw({ span: null }), row())).toMatchObject({ origin: 'model_guess', span: null })
  })

  it('never takes a phrase from a recorded reason or a title, only from his words', () => {
    const r = row({ excerpt: 'cut it', title: 'the ending drags', meta: { why: 'the ending drags' } })
    expect(resolveSignal(raw(), r)).toMatchObject({ origin: 'model_guess', span: null })
  })

  it('reads the whole of a cut excerpt, and a card\'s typed fields', () => {
    const long = `${'word '.repeat(90)}and the ending drags`
    const r = normalise({ source: 'learnings_json', sourceRef: '1', occurredAt: '2026-10-01T00:00:00Z', attribution: 'krish_words',
      polarity: 'dislikes', lane: 'voice', layer: null, title: null, excerpt: long, meta: {}, venture: 'publication' })
    expect(r.excerpt!.length).toBeLessThanOrEqual(400)
    expect(resolveSignal(raw(), row({ excerpt: r.excerpt, meta: r.meta }))).toMatchObject({ origin: 'krish' })
    expect(resolveSignal(raw({ span: 'try it Monday' }), row({ source: 'inspiration_page', excerpt: 'x', meta: { would_do: 'try it  Monday' } })))
      .toMatchObject({ origin: 'krish', span: 'try it Monday' })
  })

  it('makes a tapped answer\'s signals his action, with no phrase', () => {
    const s = resolveSignal(raw({ span: 'tight pacing' }), row({ attribution: 'krish_action', excerpt: 'tight pacing' }))!
    expect(s).toMatchObject({ origin: 'krish_action', span: null })
    expect(hisWords(row({ attribution: 'krish_action' }))).toEqual([])
  })

  it('drops a dimension outside the vocabulary, and an open tag with nothing to name it', () => {
    expect(resolveSignal(raw({ dimension: 'vibes' }), row())).toBeNull()
    expect(resolveSignal(raw({ dimension: 'subject', attribute: 'topic', label: null }), row())).toBeNull()
  })

  it('names an unknown attribute in its label, and a subject by its topic', () => {
    expect(resolveSignal(raw({ dimension: 'tone', attribute: 'Whimsical' }), row())).toMatchObject({ attribute: 'tone.other', label: 'whimsical' })
    expect(resolveSignal(raw({ dimension: 'subject', attribute: 'x', label: 'Chip Supply' }), row()))
      .toMatchObject({ attribute: 'subject.topic', label: 'chip supply', kind: 'subject' })
  })

  it('gives the same tag the same fingerprint, and a different polarity another', () => {
    expect(resolveSignal(raw(), row())!.fingerprint).toBe(resolveSignal(raw(), row({ id: 'e2' }))!.fingerprint)
    expect(resolveSignal(raw(), row())!.fingerprint).not.toBe(resolveSignal(raw({ polarity: 'likes' }), row())!.fingerprint)
  })
})

describe('contextOf', () => {
  it('copies where it applies, and a card\'s kind only when the file proves it or he set it', () => {
    const card = { card_facets: { platform: 'tiktok', format: 'short_video', link: { platform: 'instagram', author: 'someone' } } }
    expect(contextOf(row({ source: 'inspiration_page', lane: 'production', ...card, card_kind: 'video', card_kind_source: 'rule' })))
      .toEqual({ lane: 'production', source: 'inspiration_page', platform: 'instagram', format: 'short_video', kind: 'video', author: 'someone' })
    expect(contextOf(row({ ...card, card_kind: 'corpus', card_kind_source: 'model' }))).not.toHaveProperty('kind')
  })

  it('keeps where a report from another session says he typed the words', () => {
    expect(contextOf(row({ source: 'session_report', lane: 'voice', meta: { repository: 'owner/some-repo', said_where: 'a chat in some-repo', session_ref: 's1' } })))
      .toEqual({ lane: 'voice', source: 'session_report', repository: 'owner/some-repo', said_where: 'a chat in some-repo' })
  })
})

describe('renderEvidence', () => {
  it('shows the model the whole of his words where the excerpt was cut', () => {
    const text = renderEvidence(0, row({ excerpt: 'the start', meta: { [FULL_TEXT]: 'the start and the whole rest of it' } }))
    expect(text).toContain('Krish said: the start and the whole rest of it')
  })
})

describe('the whole of a cut excerpt', () => {
  const ev = (excerpt: string, source: Evidence['source'] = 'learnings_json'): Evidence => ({
    source, sourceRef: 'r1', occurredAt: '2026-10-01T00:00:00Z', attribution: 'krish_words', polarity: 'likes',
    lane: 'voice', layer: null, title: null, excerpt, meta: { why: 'recorded' }, venture: 'publication',
  })

  it('is kept only when the excerpt was cut, and normalising twice changes nothing', () => {
    expect(normalise(ev('short')).meta).toEqual({ why: 'recorded' })
    const long = normalise(ev('x '.repeat(400)))
    expect(long.meta[FULL_TEXT]).toBe('x '.repeat(400).trim())
    expect(normalise(long)).toEqual(long)
  })

  it('is out of the version, so no row written before it was kept becomes a new version', () => {
    const long = ev('word '.repeat(200))
    const before = versionOf({ ...long, excerpt: normalise(long).excerpt })
    expect(versionOf(normalise(long))).toBe(before)
  })
})

describe('patternsOf', () => {
  it('counts distinct answers and sources of his, and keeps guesses beside the count', () => {
    const a = resolveSignal(raw(), row({ id: 'e1' }))!
    const b = resolveSignal(raw(), row({ id: 'e2', source: 'title_verdicts' }))!
    const c = resolveSignal(raw(), row({ id: 'e2', source: 'title_verdicts' }))!
    const guess = resolveSignal(raw({ span: null }), row({ id: 'e3' }))!
    const mymu = (s: typeof a) => ({ ...s, venture: 'publication' })
    const [p] = patternsOf([a, b, c, guess].map(mymu))
    expect(p).toMatchObject({ venture: 'publication', attribute: 'close.surprise_last', polarity: 'dislikes', evidence: 2, sources: 2, grounded: 2, guesses: 1 })
  })

  it('counts within one venture, as the view does: the same tag in two ventures is two patterns', () => {
    const a = { ...resolveSignal(raw(), row({ id: 'e1' }))!, venture: 'publication' }
    const b = { ...resolveSignal(raw(), row({ id: 'e2', source: 'session_report' }))!, venture: 'heartside' }
    expect(patternsOf([a, b]).map(p => [p.venture, p.attribute, p.evidence]))
      .toEqual([['heartside', 'close.surprise_last', 1], ['publication', 'close.surprise_last', 1]])
  })
})

describe('extractSignals', () => {
  const pending = [row({ id: 'e1' }), row({ id: 'e2', excerpt: 'love the hook, always' })]
  const fakeDb = (tables: boolean, log: Array<{ sql: string; params: unknown[] }>): Db => ({
    query: async <T,>(sql: string, params: unknown[] = []) => {
      log.push({ sql, params })
      if (sql.includes('to_regclass')) return [{ ok: tables }] as T[]
      if (sql.includes('from public.taste_evidence e')) return pending.map(p => ({ ...p, read_before: false })) as T[]
      return [] as T[]
    },
    close: async () => {},
  })
  const stub = (calls: { n: number }): Llm => ({
    model: 'stub',
    structured: async () => {
      calls.n++
      return { failure: null, model: 'stub', data: { items: [
        { ref: 0, signals: [raw(), raw({ dimension: 'vibes' })] },
        { ref: 1, signals: [raw({ dimension: 'opening', attribute: 'provocative_hook', polarity: 'likes', strength: 3, span: 'love the hook' })] },
      ] } as never }
    },
  })

  it('asks no model and writes nothing when the table is not there yet', async () => {
    const calls = { n: 0 }
    const log: Array<{ sql: string; params: unknown[] }> = []
    const r = await extractSignals(fakeDb(false, log), stub(calls), 'run', { write: true })
    expect(r).toMatchObject({ missing: true, items: 0, signals: 0 })
    expect(calls.n).toBe(0)
  })

  it('in a dry run reads anyway, for the preview, and writes nothing', async () => {
    const calls = { n: 0 }
    const log: Array<{ sql: string; params: unknown[] }> = []
    const r = await extractSignals(fakeDb(false, log), stub(calls), 'run', { write: false })
    expect(r).toMatchObject({ items: 2, signals: 2, krish: 2, dropped: 1, missing: true })
    expect(r.preview.signals.map(s => s.attribute)).toEqual(['close.surprise_last', 'opening.provocative_hook'])
    expect(r.preview.signals.map(s => s.venture)).toEqual(['publication', 'publication'])
    expect(log.some(l => /insert|update/i.test(l.sql.split('\n')[0]!))).toBe(false)
  })

  it('reads only what this revision has not, then writes the signals, supersedes older readings and marks all read', async () => {
    const calls = { n: 0 }
    const log: Array<{ sql: string; params: unknown[] }> = []
    const r = await extractSignals(fakeDb(true, log), stub(calls), 'run', { write: true })
    expect(r).toMatchObject({ items: 2, signals: 2, failed: 0, missing: false })
    const read = log.find(l => l.sql.includes('from public.taste_evidence e'))!
    expect(read.sql).toContain('taste_signal_reads')
    expect(read.params).toContain(SIGNAL_PROMPT_REV)
    expect(log.some(l => l.sql.includes('insert into public.taste_signals'))).toBe(true)
    expect(log.some(l => l.sql.includes('set superseded_at = now()'))).toBe(true)
    const marked = log.find(l => l.sql.includes('insert into public.taste_signal_reads'))!
    expect(JSON.parse(String(marked.params[0]))).toEqual(['e1', 'e2'])
  })

  it('marks nothing read from a batch the model failed, so the next run asks again', async () => {
    const log: Array<{ sql: string; params: unknown[] }> = []
    const failing: Llm = { model: 'stub', structured: async () => ({ failure: 'refusal', model: 'stub', data: null }) }
    const r = await extractSignals(fakeDb(true, log), failing, 'run', { write: true })
    expect(r).toMatchObject({ failed: 2, signals: 0 })
    expect(log.some(l => l.sql.includes('taste_signal_reads (evidence_id'))).toBe(false)
  })
})

describe('the public log', () => {
  it('carries the signals stage\'s counts and nothing it says', () => {
    expect(safeFields({ signals_written: 4, signals_other: 1, signals_label: 'his words' })).toEqual({ signals_written: 4, signals_other: 1 })
  })
})
