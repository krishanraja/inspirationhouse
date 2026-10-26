import { describe, it, expect } from 'vitest'
import { fileReport, type ReportRow } from '../src/collect/sessionReports.ts'

// Synthetic reports only.
const base: ReportRow = {
  id: '00000000-0000-0000-0000-000000000001', kind: 'observation', body: 'synthetic: keep an eye on this one',
  said_where: null, said_at: null, lane: 'strategy', polarity: 'neutral', subject_ref: 'idea:abc-1', subject: 'A synthetic idea',
  session_ref: 'session_synthetic_0001', repository: 'krishanraja/synthetic-repo', surface: 'claude-code-web',
  reported_at: '2026-10-26T10:00:00.000Z',
}
const words: ReportRow = { ...base, kind: 'krish_words', said_where: 'a synthetic chat', said_at: '2026-10-26T09:00:00.000Z' }

describe('a session report', () => {
  it('files his words as his, dated when he typed them, with where', () => {
    const f = fileReport(words)
    expect(f.evidence).toMatchObject({ attribution: 'krish_words', occurredAt: '2026-10-26T09:00:00.000Z', source: 'session_report' })
    expect(f.evidence!.meta).toMatchObject({ said_where: 'a synthetic chat', session_ref: 'session_synthetic_0001', repository: 'krishanraja/synthetic-repo' })
  })

  it('refuses his words without where or when, and never files them as anything', () => {
    for (const r of [{ ...words, said_where: null }, { ...words, said_where: '  ' }, { ...words, said_at: null }]) {
      expect(fileReport(r)).toMatchObject({ evidence: null, cue: null, refused: 'words_without_where_or_when' })
    }
  })

  it('files an observation as context, with no where, and never as a cue, whatever its words say', () => {
    const f = fileReport(base)
    expect(f.evidence).toMatchObject({ attribution: 'observation', occurredAt: base.reported_at })
    expect(f.evidence!.meta).not.toHaveProperty('said_where')
    expect(f.cue).toBeNull()
  })

  it('makes a cue only from a use his own words name, about an idea or a card', () => {
    expect(fileReport(words).cue).toMatchObject({ use: 'track_over_time', use_origin: 'krish', subject_ref: 'abc-1', source: 'session_report' })
    expect(fileReport({ ...words, subject_ref: 'card:abc-2', body: 'synthetic: for a wider piece on chip supply' }).cue)
      .toMatchObject({ use: 'wider_piece_context', theme: 'chip supply', subject_ref: 'abc-2' })
    expect(fileReport({ ...words, body: 'synthetic: I like how this opens' }).cue).toBeNull()
    expect(fileReport({ ...words, subject_ref: 'piece:abc-3' }).cue).toBeNull()
    expect(fileReport({ ...words, subject_ref: null, subject: null }).cue).toBeNull()
  })
})
