import { describe, it, expect } from 'vitest'
import { filenameHints } from '../src/tag/hints.ts'

// Synthetic names in the shapes his folders hold; no real file is named here.
describe('filenameHints', () => {
  it('reads the app from a phone screenshot', () => {
    expect(filenameHints('Screenshot_20261016_204206_Instagram.jpg', 'image/jpeg')).toEqual({ platform: 'instagram', format: 'screenshot', media: 'image', source: 'a screenshot on his phone, in Instagram' })
    expect(filenameHints('Screenshot_20261016_204206_LinkedIn.jpg', 'image/jpeg').platform).toBe('linkedin')
  })
  it('reads the saver tool from a downloaded video', () => {
    expect(filenameHints('SaveClip.App_AbC123.mp4', 'video/mp4')).toMatchObject({ platform: 'instagram', media: 'video', format: null })
    expect(filenameHints('some-title-ytshorts.savetube.vip.mp4', 'video/mp4')).toMatchObject({ platform: 'youtube', format: 'short_video' })
    expect(filenameHints('igexport-XyZ.mp4', 'video/mp4').platform).toBe('instagram')
  })
  it('says nothing it cannot read from the name', () => {
    expect(filenameHints('unpacking models by country based on this pic.jpg', 'image/jpeg')).toEqual({ platform: null, format: null, media: 'image', source: null })
    expect(filenameHints('09 A note', 'application/vnd.google-apps.document')).toEqual({ platform: null, format: 'document', media: 'document', source: null })
    expect(filenameHints('https://claude..txt', 'text/plain')).toMatchObject({ platform: 'web', source: 'a link he saved' })
  })
})

import { mergeFacets } from '../src/tag/items.ts'
describe('mergeFacets', () => {
  it('keeps at most six of each list, keeps what the file name proves, and records a watched clip', () => {
    const m = mergeFacets(
      { platform: 'unknown', format: 'single_image', source: null, creator: null, people: [], organisations: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a'], topics: [] },
      { platform: 'instagram', format: 'screenshot', media: 'image', source: 'a screenshot on his phone, in Instagram' },
      null,
    )
    expect(m.organisations).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(m.platform).toBe('instagram')
    expect(m.format).toBe('screenshot')
    expect(m.source).toBe('a screenshot on his phone, in Instagram')
    expect(m.watched).toBe(false)
    expect(m.heard).toBeNull()
  })
  it('records whether a watched video was heard', () => {
    const watched = { frames: [], durationS: 42, transcript: null, heard: 'failed' as const, unheard: 'decode' }
    const m = mergeFacets(
      { platform: 'instagram', format: 'short_video', source: null, creator: null, people: [], organisations: [], topics: [] },
      { platform: 'instagram', format: null, media: 'video', source: null },
      watched,
    )
    expect(m.heard).toBe('failed')
    expect(m.duration_s).toBe(42)
  })
})
