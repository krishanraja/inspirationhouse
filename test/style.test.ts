import { describe, it, expect } from 'vitest'
import { PINNED_VOCAB, TEACHES_DB_ROLES, TEACHES_ROLES, captionIds, dbTeaches, readStyleVocab, styleRefIds, stylePicks, vocabPrompt,
  CAPTION_THEMES_FILE, STYLE_REFERENCES_FILE } from '../src/tag/style.ts'

// content-engine's style vocabulary as a card's reading names it. Synthetic files only: the shapes of content-engine's
// config/caption-themes.json and config/style-references.json, with invented ids.
const captions = { _about: 'synthetic', 'syn-pop': { name: 'Pop' }, 'syn-slam': { name: 'Slam' } }
const refs = {
  _about: 'synthetic',
  layers: ['opening', 'motion'],
  bank: [
    { id: 'syn-open', layer: 'opening' },
    { id: 'syn-drift', layer: 'motion' },
    { id: 'syn-ladder', layer: 'motion' },
    { id: 'Not An Id', layer: 'motion' },
  ],
  formats: { _about: 'synthetic', script: [{ id: 'syn-debate' }, { id: 'syn-rule' }], production: [{ id: 'syn-face' }] },
}

describe('reading the vocabulary from content-engine', () => {
  it('takes the caption theme keys, leaving out _about', () => {
    expect(captionIds(captions)).toEqual(['syn-pop', 'syn-slam'])
    expect(captionIds(null)).toEqual([])
  })
  it('takes the motion layer of the bank and the two format lists', () => {
    expect(styleRefIds(refs)).toEqual({ motion: ['syn-drift', 'syn-ladder'], script_formats: ['syn-debate', 'syn-rule'], production_formats: ['syn-face'] })
  })
  it('reads both files live and says so', async () => {
    const asked: string[] = []
    const v = await readStyleVocab(async p => { asked.push(p); return p === CAPTION_THEMES_FILE ? captions : refs })
    expect(asked.sort()).toEqual([CAPTION_THEMES_FILE, STYLE_REFERENCES_FILE].sort())
    expect(v.live).toBe(true)
    expect(v.pinned).toEqual([])
    expect(v.vocab.captions).toEqual(['syn-pop', 'syn-slam'])
    expect(v.vocab.motion).toEqual(['syn-drift', 'syn-ladder'])
    // Transitions, camera, energy, the series and the roles are pinned: no config file holds them.
    expect(v.vocab.transitions).toEqual(PINNED_VOCAB.transitions)
    expect(v.vocab.teaches).toEqual(TEACHES_ROLES)
  })
  it('falls back to the pinned list for each read that fails or comes back empty, and names it', async () => {
    const v = await readStyleVocab(async p => { if (p === CAPTION_THEMES_FILE) throw new Error('HTTP 502'); return { bank: [], formats: { script: [{ id: 'syn-debate' }] } } })
    expect(v.live).toBe(false)
    expect(v.pinned.sort()).toEqual(['captions', 'motion', 'production_formats'])
    expect(v.vocab.captions).toEqual(PINNED_VOCAB.captions)
    expect(v.vocab.motion).toEqual(PINNED_VOCAB.motion)
    expect(v.vocab.script_formats).toEqual(['syn-debate'])
  })
})

describe('a reading\'s style picks', () => {
  it('keeps only ids in the lists, drops the rest and counts them, and labels the picks the engine\'s', () => {
    const { picks, dropped } = stylePicks({
      captions: ['slam', 'made-up-theme'], motion: ['living-ui'], transitions: ['whip', 'wipe'], camera: ['drift'],
      energy: 'frantic', script_formats: ['head-to-head'], production_formats: [], series: 'mind_the_gap', teaches: ['hook', 'thumbnail', 'vibes'],
    }, PINNED_VOCAB, ['why_here'])
    expect(picks).toEqual({
      captions: ['slam'], motion: ['living-ui'], transitions: ['whip'], camera: ['drift'], energy: null,
      script_formats: ['head-to-head'], production_formats: [], series: 'mind_the_gap', teaches: ['hook', 'thumbnail'],
      origin: 'engine_read', grounded_in: ['why_here'],
    })
    expect(dropped).toBe(4)
  })
  it('reads a missing answer as no picks', () => {
    expect(stylePicks(undefined, PINNED_VOCAB, []).picks).toMatchObject({ captions: [], energy: null, series: null, teaches: [], grounded_in: [] })
  })
  it('writes to content-engine\'s teaches column only the roles it takes', () => {
    expect(dbTeaches(['hook', 'thumbnail', 'layout'])).toEqual(['hook', 'layout'])
    expect(TEACHES_ROLES.filter(r => !(TEACHES_DB_ROLES as readonly string[]).includes(r))).toEqual(['thumbnail'])
  })
  it('lists every id in the prompt', () => {
    const p = vocabPrompt(PINNED_VOCAB)
    for (const id of [...PINNED_VOCAB.captions, ...PINNED_VOCAB.motion, ...PINNED_VOCAB.series, ...PINNED_VOCAB.teaches]) expect(p).toContain(id)
  })
})
