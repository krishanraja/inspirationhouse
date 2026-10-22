import { describe, it, expect } from 'vitest'
import { collectGitTaste, TASTE_FILES } from '../src/collect/gitTaste.ts'
import { sheetEvidence } from '../src/collect/drive.ts'
import { versionOf, normalise, clip } from '../src/evidence.ts'

// Synthetic files only. No real taste data is ever committed here.
const files: Record<string, unknown> = {
  [TASTE_FILES.learnings]: { learnings: [{ id: 'plain-words', on: '2026-10-01', krish: 'what does that word mean?', why: 'jargon', means: 'use plain words' }] },
  [TASTE_FILES.titleVerdicts]: { verdicts: [
    { title: 'The bill nobody reads', verdict: 'picked', krish: 'this one, it is concrete', why: 'concrete', on: '2026-10-02' },
    { title: 'Synergies in the AI era', verdict: 'rejected', krish: 'means nothing', why: 'abstract', on: '2026-10-02' },
    { title: 'Maybe', verdict: 'unsure', krish: 'hmm', on: '2026-10-02' },
  ] },
  [TASTE_FILES.golden]: { examples: [{ kind: 'intro', text: 'I am Krish.', said: 'keep this intro', why: 'warm', on: '2026-10-03' }] },
  [TASTE_FILES.rejected]: { rejected: [{ pattern: 'game.?changer', instead: 'say what changed', said: 'never this word', on: '2026-10-04' }] },
  [TASTE_FILES.style]: {
    references: [{ file: 'a.mp4', drive_id: 'driveid0001', krish_likes: 'how she explains it plainly', added: '2026-10-05' }, { file: 'b.mp4' }],
    bank: [
      { id: 'm1', layer: 'opening', name: 'Concede then claim', krish_verdict: 'liked' },
      { id: 'm2', layer: 'editing', name: 'Long holds', krish_verdict: 'untested' },
      { id: 'm3', layer: 'tone', name: 'Shouting', krish_verdict: 'not for us' },
    ],
  },
}

describe('reading the taste files', () => {
  it('turns his feedback into evidence with the right attribution and direction', async () => {
    const ev = await collectGitTaste(async p => files[p], '2026-10-22T00:00:00.000Z')
    const by = (s: string) => ev.filter(e => e.source === s)
    expect(by('learnings_json')[0]).toMatchObject({ attribution: 'krish_words', excerpt: 'what does that word mean?' })
    expect(by('title_verdicts').map(e => e.polarity)).toEqual(['likes', 'dislikes'])
    expect(by('title_verdicts')[0]!.layer).toBe('packaging')
    expect(by('golden_examples')[0]!.polarity).toBe('likes')
    expect(by('rejected_lines')[0]).toMatchObject({ polarity: 'dislikes', excerpt: 'never this word' })
    // A reference with his words is his words; one without is still his action of saving it.
    expect(by('style_references').map(e => e.attribution)).toEqual(['krish_words', 'krish_action'])
  })

  it('counts a technique only once he has given it a verdict', async () => {
    const ev = await collectGitTaste(async p => files[p])
    const bank = ev.filter(e => e.source === 'style_bank')
    expect(bank.map(e => [e.sourceRef, e.polarity])).toEqual([['m1', 'likes'], ['m3', 'dislikes']])
  })
})

describe('the What I like sheet', () => {
  it('reads one craft per column and the would-not-copy column as a dislike', () => {
    const rows = [
      ['Video file name or link', 'Narrative (the story and hook)', 'Editing (cuts and pace)', 'What I would NOT copy', 'Date added'],
      ['clip.mp4', 'opens on a question', '', 'the music', '2026-10-04'],
      ['', 'ignored: no video named'],
    ]
    const ev = sheetEvidence(rows, '2026-10-22T00:00:00.000Z')
    expect(ev.map(e => [e.layer, e.polarity, e.excerpt])).toEqual([
      ['structure', 'likes', 'opens on a question'],
      [null, 'dislikes', 'the music'],
    ])
    expect(ev[0]!.occurredAt).toBe('2026-10-04T12:00:00.000Z')
  })
})

describe('evidence versions', () => {
  it('give the same entry the same version whatever order its fields arrive in', () => {
    const a = { source: 'golden_examples', sourceRef: 'x', occurredAt: '2026-10-01T00:00:00Z', attribution: 'krish_words', polarity: 'likes', lane: 'voice', layer: null, title: 't', excerpt: 'e', meta: { a: 1, b: 2 } } as const
    const b = { ...a, meta: { b: 2, a: 1 } }
    expect(versionOf(a)).toBe(versionOf(b))
    expect(versionOf({ ...a, excerpt: 'changed' })).not.toBe(versionOf(a))
  })

  it('never stores an excerpt longer than the column allows, and cuts on a word', () => {
    const long = 'word '.repeat(200)
    expect(normalise({ source: 'learnings_json', sourceRef: 'x', occurredAt: '', attribution: 'krish_words', polarity: 'likes', lane: 'voice', layer: 'nonsense', title: null, excerpt: long, meta: {} }).excerpt!.length).toBeLessThanOrEqual(400)
    expect(clip('a b c', 3)).toBe('a b')
  })
})
