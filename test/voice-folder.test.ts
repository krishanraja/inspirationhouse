import { describe, expect, it } from 'vitest'
import { DRIVE } from '../src/config.ts'
import { collectVoiceFolder, VOICE_REF } from '../src/collect/voiceFolder.ts'

// His voice folder (Krish, 2026-11-07): screenshots of posts by writers whose voice he admires, read as lane voice,
// each transcribed once. Synthetic files and a stand-in model only.

const file = (id: string, name: string, mimeType = 'image/jpeg') => ({ id, name, mimeType, modifiedTime: '2026-11-07T18:44:31Z', createdTime: '2026-11-07T18:44:31Z' })

function google(files: ReturnType<typeof file>[]) {
  const thumbs: string[] = []
  return {
    thumbs,
    g: {
      listFolder: async (id: string) => (id === DRIVE.voiceInspiration ? files : []),
      thumbnail: async (f: { id: string }) => { thumbs.push(f.id); return { bytes: Buffer.from('img'), mime: 'image/jpeg' } },
    },
  }
}

const llm = (calls: unknown[]) => ({
  model: 'stand-in',
  async structured(args: unknown) {
    calls.push(args)
    return { data: { writer: 'Synthetic Writer', headline: 'Cofounder, Example Co', post_text: 'A first line that makes the claim.\nThen the proof.' }, failure: null, model: 'stand-in' }
  },
}) as never

describe('the voice folder', () => {
  it('reads the folder Krish named as the home of voices he finds inspiring', () => {
    expect(DRIVE.voiceInspiration).toBe('17KrJJKbGp193ZndMDxhcdfkxy0dhYiEk')
  })

  it('files each screenshot as his action in the voice lane, Mindmake\'s, with the transcribed post', async () => {
    const calls: unknown[] = []
    const { g } = google([file('aSyntheticFile01', 'Screenshot_LinkedIn.jpg')])
    const e = (await collectVoiceFolder(g, { llm: llm(calls) }))[0]!
    expect(e).toMatchObject({ source: 'drive_cold', sourceRef: `${VOICE_REF}aSyntheticFile01`, lane: 'voice', attribution: 'krish_action', polarity: 'likes', venture: 'mindmake' })
    expect(e.title).toBe('Synthetic Writer: A first line that makes the claim.')
    expect(e.excerpt).toContain('Then the proof.')
    expect(e.meta).toMatchObject({ folder: 'voice_inspiration', writer: 'Synthetic Writer', transcribed_by: 'stand-in' })
    expect(calls).toHaveLength(1)
  })

  it('transcribes a file once: one already in the ledger is not read or sent again', async () => {
    const calls: unknown[] = []
    const { g, thumbs } = google([file('aSyntheticFile01', 'a.jpg'), file('aSyntheticFile02', 'b.jpg')])
    const rows = await collectVoiceFolder(g, { llm: llm(calls), known: new Set([`${VOICE_REF}aSyntheticFile01`]) })
    expect(rows.map(r => r.sourceRef)).toEqual([`${VOICE_REF}aSyntheticFile02`])
    expect(thumbs).toEqual(['aSyntheticFile02'])
    expect(calls).toHaveLength(1)
  })

  it('without a model, still files his action under the file name, and never invents a transcription', async () => {
    const { g } = google([file('aSyntheticFile03', 'saved.jpg')])
    const e = (await collectVoiceFolder(g, {}))[0]!
    expect(e.title).toBe('saved.jpg')
    expect(e.excerpt).toBeNull()
    expect(e.meta).toMatchObject({ transcribed_by: null })
  })
})
