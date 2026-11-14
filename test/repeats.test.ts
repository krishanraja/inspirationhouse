import { describe, it, expect } from 'vitest'
import { readRepeats, repeatedCorrections, repeatCounts, mondayOf, REPEATS_SQL, CORRECTION_SOURCES, owningSkill, repeatEnvelopes, readingMarker, sendRepeats, DISPATCH_MAX, type SlugWeek } from '../src/publish/repeats.ts'
import { githubApi, type GitHubApi } from '../src/publish/harness.ts'
import type { Db } from '../src/db.ts'

// Synthetic rows only: slugs from the public vocabulary, no words of his.
const W = '2026-11-02'
const rows: SlugWeek[] = [
  { venture: 'publication', attribute: 'opening.plain_declarative', week: W, evidence: 3, lane: 'voice', kind: 'form' },
  { venture: 'publication', attribute: 'tone.no_hype', week: W, evidence: 1 },
  { venture: 'heartside', attribute: 'production.polished_finish', week: W, evidence: 2, lane: 'production', kind: 'form' },
  { venture: 'publication', attribute: 'close.one_ask', week: '2026-10-26', evidence: 5 },
]

describe('readRepeats', () => {
  it('counts a slug given twice in a week once, and a slug given once not at all', () => {
    const r = readRepeats(rows, W)
    expect(r.total).toBe(2)
    expect(r.slugs).toEqual(['publication:opening.plain_declarative=3', 'heartside:production.polished_finish=2'])
  })
  it('keeps each venture apart: the same slug in two ventures is two repeats, each under its own venture', () => {
    expect(readRepeats(rows, W).byVenture).toEqual({ publication: 1, heartside: 1 })
    const both = [...rows, { venture: 'heartside', attribute: 'opening.plain_declarative', week: W, evidence: 2 }]
    expect(readRepeats(both, W).byVenture).toEqual({ publication: 1, heartside: 2 })
  })
  it('reads only the week asked for', () => {
    expect(readRepeats(rows, '2026-10-26')).toMatchObject({ total: 1, byVenture: { publication: 1 } })
    expect(readRepeats(rows, '2026-11-09')).toMatchObject({ total: 0, byVenture: {}, slugs: [] })
  })
})

describe('the query', () => {
  it('counts only his own dislikes of machine work, never subject or unnamed slugs, never withdrawn evidence', () => {
    expect(REPEATS_SQL).toContain(`s.origin = 'krish'`)
    expect(REPEATS_SQL).toContain(`s.polarity = 'dislikes'`)
    expect(REPEATS_SQL).toContain(`s.kind <> 'subject'`)
    expect(REPEATS_SQL).toContain(`not like '%.other'`)
    expect(REPEATS_SQL).toContain('e.withdrawn_at is null')
    expect(REPEATS_SQL).toContain('count(distinct e.id)')
    expect(CORRECTION_SOURCES).not.toContain('inspiration_page')
  })
  it('reads the last whole week, Monday to Monday, never the week still running', async () => {
    let params: unknown[] = []
    const db = { query: async (_sql: string, p: unknown[]) => { params = p; return [{ ...rows[0]!, evidence: '3' }] }, close: async () => {} } as unknown as Db
    const r = await repeatedCorrections(db, new Date('2026-11-13T10:00:00Z'))
    expect(params.slice(1)).toEqual(['2026-11-02', '2026-11-09'])
    expect(r).toMatchObject({ week: '2026-11-02', total: 1 })
  })
})

describe('mondayOf and repeatCounts', () => {
  it('finds the Monday of a Sunday and of a Monday', () => {
    expect(mondayOf(new Date('2026-11-15T23:00:00Z'))).toBe('2026-11-09')
    expect(mondayOf(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09')
  })
  it('flattens to run counts with no text but slugs', () => {
    expect(repeatCounts(readRepeats(rows, W))).toEqual({
      repeated_corrections_week: W, repeated_corrections: 2, repeated_corrections_publication: 1, repeated_corrections_heartside: 1,
      repeated_correction_slugs: 'publication:opening.plain_declarative=3, heartside:production.polished_finish=2',
    })
    expect(repeatCounts(readRepeats([], W))).toEqual({ repeated_corrections_week: W, repeated_corrections: 0 })
  })
})

describe('the envelopes for the harness ledger', () => {
  it('names the skill that reads each lane, and workflow corrections go to krish-principles', () => {
    expect(owningSkill('voice', 'form')).toBe('krish-voice')
    expect(owningSkill('strategy', 'form')).toBe('krish-voice')
    expect(owningSkill('production', 'form')).toBe('krish-design')
    expect(owningSkill('visibility', 'form')).toBe('krish-design')
    expect(owningSkill('voice', 'workflow')).toBe('krish-principles')
    expect(owningSkill(null, null)).toBe('krish-voice')
  })
  it('sends one envelope per repeat, with a fixed id, in the shape ai-harness intake accepts', () => {
    const env = repeatEnvelopes(readRepeats(rows, W))
    expect(env).toHaveLength(3)
    expect(env[1]).toEqual({
      event_id: 'taste-ledger:2026-11-02:heartside:production.polished_finish', occurred_at: '2026-11-02T00:00:00Z',
      surface: 'github-actions', kind: 'explicit_correction',
      summary: 'Krish gave the same correction (production.polished_finish) in 2 pieces of evidence in the week of 2026-11-02 (venture heartside), counted by the taste ledger.',
      evidence_ref: 'inspirationhouse:taste_signals:2026-11-02:heartside:production.polished_finish',
      related_skill_or_rule: 'krish-design', outcome: 'corrected', severity: 'medium', confidence: 'high',
    })
    expect(repeatEnvelopes(readRepeats(rows, W))).toEqual(env)
    for (const e of env) {
      expect(e.event_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/)
      expect(e.summary.length).toBeGreaterThanOrEqual(12)
      expect(e.summary.length).toBeLessThanOrEqual(800)
      expect(e.evidence_ref.length).toBeLessThanOrEqual(300)
    }
  })
  it('always ends with the week\'s reading marker, carrying the total, also when the week has no repeat', () => {
    const env = repeatEnvelopes(readRepeats(rows, W))
    expect(env[env.length - 1]).toEqual(readingMarker(readRepeats(rows, W)))
    expect(env[env.length - 1]).toMatchObject({ event_id: 'taste-ledger:2026-11-02:reading', kind: 'successful_pattern', outcome: 'succeeded', evidence_ref: 'inspirationhouse:taste_signals:2026-11-02:reading:2' })
    const none = repeatEnvelopes(readRepeats([], W))
    expect(none).toEqual([readingMarker(readRepeats([], W))])
    expect(none[0]!.evidence_ref).toBe('inspirationhouse:taste_signals:2026-11-02:reading:0')
    expect(none[0]!.event_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/)
  })
  it('dispatches in batches of at most the intake cap, and refuses a client that cannot dispatch', async () => {
    const sent: unknown[][] = []
    const gh = { dispatch: async (t: string, p: { events: unknown[] }) => { expect(t).toBe('harness-observations'); sent.push(p.events) } } as unknown as GitHubApi
    const many = Array.from({ length: DISPATCH_MAX + 5 }, (_, i) => ({ ...repeatEnvelopes(readRepeats(rows, W))[0]!, event_id: `taste-ledger:x:${i}:abcdefghijk` }))
    await sendRepeats(gh, many)
    expect(sent.map(b => b.length)).toEqual([DISPATCH_MAX, 5])
    await expect(sendRepeats({} as GitHubApi, many)).rejects.toThrow('cannot dispatch')
  })
  it('fails when GitHub refuses the dispatch, a 404 included', async () => {
    const fetcher = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(githubApi('o/r', 't', fetcher).dispatch!('harness-observations', { events: [] })).rejects.toThrow('HTTP 404')
    const ok = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await expect(githubApi('o/r', 't', ok).dispatch!('harness-observations', { events: [] })).resolves.toBeUndefined()
  })
})
