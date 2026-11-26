import { describe, it, expect } from 'vitest'
import { classOfReport } from '../src/collect/reportSort.ts'
import { fileReport, type ReportRow } from '../src/collect/sessionReports.ts'

// Synthetic reports only (AGENTS.md rule 2).
const words: ReportRow & { venture: string } = {
  id: '00000000-0000-0000-0000-0000000000a1', kind: 'krish_words', body: 'synthetic',
  said_where: 'a synthetic chat', said_at: '2026-11-26T09:00:00.000Z', lane: 'production', polarity: 'dislikes',
  subject_ref: null, subject: null, session_ref: 'session_synthetic_0002', repository: 'krishanraja/synthetic-repo',
  surface: 'claude-code-web', reported_at: '2026-11-26T10:00:00.000Z', venture: 'publication',
}
const say = (body: string) => ({ ...words, body })

describe('sorting a report: taste stays, the rest goes to the auditor', () => {
  it('keeps a preference as taste', () => {
    expect(classOfReport('synthetic: the cover feels cheap, I want it bolder and funnier')).toBe('taste')
    expect(classOfReport('synthetic: love how slowly this one opens')).toBe('taste')
  })

  it('takes a process complaint with no judgement out of taste', () => {
    expect(classOfReport('synthetic: stop asking me for approvals, the engine refuses to move on')).toBe('not_taste')
    expect(classOfReport('synthetic: if anything fails, give me the exact error in one line and stop')).toBe('not_taste')
    expect(classOfReport('synthetic: the cron keeps missing the token')).toBe('not_taste')
  })

  it('takes a session note pasted as his words out of taste, whatever else it names', () => {
    expect(classOfReport('synthetic: - Docs: `docs/x.md` updated, the cover looks right')).toBe('not_taste')
    expect(classOfReport('synthetic: node_modules restored and the typechecks pass')).toBe('not_taste')
  })

  it('keeps a report that names a problem and a judgement whole, as mixed', () => {
    expect(classOfReport('synthetic: the board state never saves and the buttons look tacky')).toBe('mixed')
    expect(classOfReport('synthetic: the captions are misaligned')).toBe('mixed')
  })

  it('files a not_taste report of his words for the auditor and never as taste', () => {
    const f = fileReport(say('synthetic: stop asking me for approvals'))
    expect(f).toMatchObject({ sorted: 'not_taste', evidence: null, cue: null, refused: null })
    expect(f.incident).toMatchObject({ client_ref: 'taste-report:00000000-0000-0000-0000-0000000000a1', stage: 'session', his_words: 'synthetic: stop asking me for approvals' })
    expect(f.incident!.meta).toMatchObject({ class: 'not_taste', venture: 'publication', repository: 'krishanraja/synthetic-repo' })
  })

  it('files a mixed report as taste and for the auditor', () => {
    const f = fileReport(say('synthetic: the captions are misaligned and feel cramped'))
    expect(f.sorted).toBe('mixed')
    expect(f.evidence).toMatchObject({ attribution: 'krish_words' })
    expect(f.incident).not.toBeNull()
  })

  it('leaves no incident for taste, and none for an observation (not his words)', () => {
    expect(fileReport(say('synthetic: I like how this opens')).incident).toBeNull()
    const obs = fileReport({ ...say('synthetic: the session said the deploy failed'), kind: 'observation', said_where: null, said_at: null })
    expect(obs).toMatchObject({ sorted: 'not_taste', evidence: null, incident: null })
  })
})
