import { describe, it, expect } from 'vitest'
import { THEMES, FORMATS, FORMAT_GROUPS, themeOf, formatsOf, strengthOf, type ThemeSlug } from '../src/rejection/vocab.ts'
import { parseJsonl, parseManifest, type DumpRecord } from '../src/rejection/dump.ts'
import {
  normaliseWords, quoteKey, saidAtOf, quoteAttribution, quotesOf, mediaOf, captureOf, momentOf, fileRecord, fileDump, nearOf,
  holdQuote, type Kind, type MediaPlan, type QuoteRow,
} from '../src/rejection/file.ts'

// Synthetic records only; nothing here is anything Krish said or any file in his Drive.
const rec = (over: Partial<DumpRecord> = {}): DumpRecord => ({
  id: 'R001', date: '2026-10-01', piece: 'synthetic: piece one', format: 'Short', category: 'Visual',
  theme: 'Clipart, generic and boring visuals', item: 'synthetic: a stock robot on the chapter card', quotes: [],
  reason: null, strength: 'Rejected', wanted_instead: null, asset_paths: [], screenshot_files: [], evidence: [], sources: [],
  confidence: 'krish verbatim', ...over,
})
const said = (text: string, when: string | null = '2026-10-01', source = 'cloud') => ({ text, when, source })
const noMedia: MediaPlan = { stills: [], strips: [], masters: [], texts: 0 }
const dumpOf = (rejected: DumpRecord[], liked: DumpRecord[] = [], process: DumpRecord[] = []) =>
  ({ rejected, liked, process, manifest: new Map<string, string[]>() })

describe('the rejection vocabulary', () => {
  it('maps the dump theme text to a slug, and anything unplaced to other', () => {
    expect(themeOf('Motion that decorates, not explains')).toBe('decorative_motion')
    expect(themeOf('  words on screen ')).toBe('words_on_screen')
    expect(themeOf('Edit and A/V defects')).toBe('edit_av')
    expect(themeOf('Structure: intros, outros, duplicate sequences')).toBe('structure')
    expect(themeOf('Process')).toBe('process')
    expect(themeOf('Liked')).toBe('liked')
    expect(themeOf('synthetic: a theme nobody named')).toBe('other')
    expect(themeOf('')).toBe('other')
    expect(themeOf(null)).toBe('other')
    expect(themeOf(42)).toBe('other')
  })

  it('finds every theme the dump names in words by its own label, so no rule shadows another', () => {
    // process and liked come from the file a record is in, and other is the fallback, so none is named in words.
    const named = (Object.keys(THEMES) as ThemeSlug[]).filter(s => !['process', 'liked', 'other'].includes(s))
    for (const slug of named) expect(themeOf(THEMES[slug].label), slug).toBe(slug)
  })

  it('gives every theme a kind, keeping subject and workflow apart from form', () => {
    for (const [slug, theme] of Object.entries(THEMES)) {
      expect(['form', 'subject', 'workflow'], slug).toContain(theme.kind)
      expect(theme.label.length, slug).toBeGreaterThan(0)
    }
    expect(THEMES.story_angle.kind).toBe('subject')
    expect(THEMES.process.kind).toBe('workflow')
  })

  it('drafts in groups of known formats, and places every format in a group', () => {
    const known = Object.keys(FORMATS)
    const grouped = new Set<string>()
    for (const [group, slugs] of Object.entries(FORMAT_GROUPS)) {
      for (const s of slugs) { expect(known, group).toContain(s); grouped.add(s) }
    }
    // A record joins the groups its formats are in, so a format in no group would never be drafted.
    expect([...grouped].sort()).toEqual([...known].sort())
  })

  it('reads formats from the format text, sorted, and never empty', () => {
    expect(formatsOf('Short')).toEqual(['short_video'])
    expect(formatsOf('16:9 deep cut')).toEqual(['long_video'])
    expect(formatsOf('Voiceover')).toEqual(['long_video', 'short_video'])
    expect(formatsOf('Thumbnail and title')).toEqual(['thumbnail', 'title'])
    expect(formatsOf('all')).toEqual(['all'])
    expect(formatsOf('synthetic: a shape no rule knows')).toEqual(['other'])
    expect(formatsOf(null)).toEqual(['other'])
  })

  it('adds the specialist an item names, and drops all once something specific is found', () => {
    expect(formatsOf('all', { item: 'synthetic: the burned caption misspells a name' })).toEqual(['captions'])
    expect(formatsOf('Short', { item: 'synthetic: the music swamps the voice' })).toEqual(['audio', 'short_video'])
    expect(formatsOf('Video')).toEqual(['long_video', 'short_video'])
    // How a session worked, or what a piece is about, is never a maker's defect, whatever its item mentions.
    expect(formatsOf('', { theme: 'process', item: 'synthetic: the session asked about the music twice' })).toEqual(['session'])
    expect(formatsOf('', { theme: 'story_angle', item: 'synthetic: the intro story was off' })).toEqual(['other'])
  })

  it('falls back on the theme only when the format text says nothing, and only where the theme is unambiguous', () => {
    expect(formatsOf('', { theme: 'packaging' })).toEqual(['title'])
    expect(formatsOf(undefined, { theme: 'predictions_framing' })).toEqual(['prediction'])
    expect(formatsOf('', { theme: 'voice_tone' })).toEqual(['script'])
    expect(formatsOf('', { theme: 'unclear_copy' })).toEqual(['script'])
    expect(formatsOf('', { theme: 'layout' })).toEqual(['other'])
    expect(formatsOf('Carousel', { theme: 'packaging' })).toEqual(['carousel'])
  })

  it('reads how strongly he said it, and anything else as unstated', () => {
    expect(strengthOf('Hated')).toBe('hated')
    expect(strengthOf(' disliked ')).toBe('disliked')
    expect(strengthOf('REJECTED')).toBe('rejected')
    expect(strengthOf('Ruled out')).toBe('ruled_out')
    expect(strengthOf('Endorsed (a session critique)')).toBe('endorsed')
    expect(strengthOf('liked')).toBe('liked')
    expect(strengthOf('ruled-out')).toBe('unstated')
    expect(strengthOf('synthetic: strongly')).toBe('unstated')
    expect(strengthOf(null)).toBe('unstated')
  })
})

describe('the dump files', () => {
  it('keeps every good line and counts the bad ones by class, never by content', () => {
    const lines = [
      JSON.stringify({ id: 'R001', date: '2026-10-01', quotes: [{ text: 'synthetic: too busy' }] }),
      '',
      '   ',
      'synthetic: not json {',
      JSON.stringify({ id: 'R002' }),
      '[1, 2]',
      JSON.stringify({ id: 'R003', date: '2026-10-02', quotes: 'synthetic: not a list' }),
      JSON.stringify({ id: 'R004', date: '2026-10-03' }),
    ]
    const parsed = parseJsonl(lines.join('\r\n'))
    expect(parsed.rows.map(r => r.id)).toEqual(['R001', 'R004'])
    expect(parsed.bad).toEqual({ json: 1, shape: 3 })
    // The lists a record leaves out default to empty.
    expect(parsed.rows[1]).toMatchObject({ quotes: [], asset_paths: [], screenshot_files: [], evidence: [], sources: [] })
  })

  it('reads the manifest as files by record, and refuses anything but a list', () => {
    const m = parseManifest(JSON.stringify([{ id: 'R001', files: ['what he was looking at/R001 synthetic.png'] }, { id: 'R002' }]))
    expect(m.get('R001')).toEqual(['what he was looking at/R001 synthetic.png'])
    expect(m.get('R002')).toEqual([])
    expect(() => parseManifest(JSON.stringify({ R001: ['synthetic.png'] }))).toThrow(/not a list/)
    expect(() => parseManifest(JSON.stringify([{ files: [] }]))).toThrow(/not a list/)
    // The error names the file, never what is in it.
    expect(() => parseManifest('synthetic: his words')).toThrow(/does not parse/)
    expect(() => parseManifest('synthetic: his words')).not.toThrow(/synthetic/)
  })
})

describe('his words as a key', () => {
  it('gives the same words one key whatever their quote marks, spacing or case, and another day another key', () => {
    expect(normaliseWords('  It\u2019s   \u201CTOO\u201D busy\u2026 ')).toBe('it\'s "too" busy...')
    const k = quoteKey('synthetic: It\u2019s \u201Ctoo\u201D  busy', '2026-10-01')
    expect(quoteKey('synthetic: it\'s "TOO" busy', '2026-10-01')).toBe(k)
    expect(quoteKey('synthetic:\tit\u2019s "too"\nbusy ', '2026-10-01')).toBe(k)
    expect(quoteKey('synthetic: it\'s "too" busy', '2026-10-02')).not.toBe(k)
    expect(quoteKey('synthetic: it\'s too busy', '2026-10-01')).not.toBe(k)
  })

  it('keeps a moment to the second where there is one, else the day at noon UTC', () => {
    expect(saidAtOf('2026-10-01T08:15:30Z', '2026-09-01')).toEqual({ at: '2026-10-01T08:15:30.000Z', day: '2026-10-01', precision: 'second' })
    expect(saidAtOf('2026-10-01', '2026-09-01')).toEqual({ at: '2026-10-01T12:00:00.000Z', day: '2026-10-01', precision: 'day' })
    // With no usable when of its own, the record's date stands in.
    expect(saidAtOf(null, '2026-09-05')).toEqual({ at: '2026-09-05T12:00:00.000Z', day: '2026-09-05', precision: 'day' })
    expect(saidAtOf('synthetic: that evening', '2026-09-05 (approx)')).toEqual({ at: '2026-09-05T12:00:00.000Z', day: '2026-09-05', precision: 'day' })
  })

  it('returns null when neither the quote nor the record gives a real day', () => {
    expect(saidAtOf(null, '')).toBeNull()
    expect(saidAtOf('synthetic: sometime', 'undated')).toBeNull()
    expect(saidAtOf('2026-13-40', 'undated')).toBeNull()
    expect(saidAtOf(undefined, '2026-13-01')).toBeNull()
  })

  // src bug: V8 rolls 2026-02-30 over to 2 March instead of refusing it, so the NaN check passes and the day
  // '2026-02-30T12:00:00.000Z' goes to a timestamptz column that Postgres refuses, failing the whole run.
  it('returns null for a calendar day that does not exist', () => {
    expect(saidAtOf('2026-02-30', 'undated')).toBeNull()
    expect(saidAtOf(null, '2026-02-31')).toBeNull()
  })
})

describe('whose words a quote is', () => {
  it('reads a verbatim record as his words, and a short approval as his action', () => {
    expect(quoteAttribution('synthetic: the zoom on every card feels cheap', true)).toBe('krish_words')
    expect(quoteAttribution('All recommended, thanks', true)).toBe('krish_action')
    expect(quoteAttribution('Ship it (Recommended)', true)).toBe('krish_action')
    expect(quoteAttribution('Yes to both', true)).toBe('krish_action')
    expect(quoteAttribution('synthetic option B (Recommended).', true)).toBe('krish_action')
    // Starting with yes does not make a sentence an approval once it goes on to say what was wrong.
    expect(quoteAttribution('Yes, and the synthetic lower third is far too small to read on a phone', true)).toBe('krish_words')
    expect(quoteAttribution('Yesterday the synthetic cut was fine', true)).toBe('krish_words')
  })

  it('reads a record that is not verbatim as an observation, whatever it says', () => {
    expect(quoteAttribution('synthetic: the zoom feels cheap', false)).toBe('observation')
    expect(quoteAttribution('All recommended, thanks', false)).toBe('observation')
    const r = rec({ quotes: [said('synthetic: the zoom feels cheap')] })
    expect(quotesOf({ ...r, confidence: 'Direct quote (synthetic log)' })[0]?.attribution).toBe('krish_words')
    expect(quotesOf({ ...r, confidence: 'paraphrased ruling' })[0]?.attribution).toBe('observation')
    expect(quotesOf({ ...r, confidence: null })[0]?.attribution).toBe('observation')
  })

  it('files each thing he said once per record, with when and where he said it', () => {
    const qs = quotesOf(rec({
      quotes: [
        said('synthetic: The card is TOO busy', '2026-10-01T09:00:00Z', 'cloud'),
        said('synthetic:  the card is too  busy', '2026-10-01', 'codex'),
        said('   ', '2026-10-01'),
        said('synthetic: and the font is thin', null, 'Other-account (synthetic)'),
      ],
    }))
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({
      text: 'synthetic: The card is TOO busy', saidAt: '2026-10-01T09:00:00.000Z', precision: 'second', source: 'cloud',
      attribution: 'krish_words', saidWhere: 'a Claude Code cloud session, on synthetic: piece one',
    })
    expect(qs[1]).toMatchObject({ saidAt: '2026-10-01T12:00:00.000Z', precision: 'day', source: 'other_account' })
  })
})

describe('what is kept of a record', () => {
  it('reads the manifest prefixes, strips, stills, folder videos and texts', () => {
    const plan = mediaOf(rec(), [
      'VIDEO KEPT IN PLACE: H:\\My Drive\\synthetic\\cut-a.mp4',
      'video kept in place: C:\\Users\\synthetic\\cut-b.mkv',
      // Kept in place but not a video, and left in place (a cache, a gap note): neither is a master nor a text.
      'VIDEO KEPT IN PLACE: C:\\Users\\synthetic\\notes.txt',
      'LEFT IN PLACE: C:\\Users\\synthetic\\cache',
      'OVERWRITTEN: C:\\Users\\synthetic\\old-cut.mp4',
      'CLOUD-ONLY: synthetic/render/cut-c.mp4',
      'what he was looking at/R001 synthetic cut - frames.jpg',
      'what he was looking at/R001 synthetic card.png',
      'what he was looking at/R001 synthetic card.png',
      'what he was looking at/R001 synthetic cover.webp',
      'Videos/R001 synthetic cut.mp4',
      'scripts/R001 synthetic script.md',
      'receipts/R001 synthetic.pdf',
    ])
    expect(plan.strips).toEqual(['what he was looking at/R001 synthetic cut - frames.jpg'])
    expect(plan.stills).toEqual(['what he was looking at/R001 synthetic card.png', 'what he was looking at/R001 synthetic cover.webp'])
    expect(plan.masters).toEqual([
      { where: 'drive_path', ref: 'H:\\My Drive\\synthetic\\cut-a.mp4' },
      { where: 'local', ref: 'C:\\Users\\synthetic\\cut-b.mkv' },
      { where: 'gone', ref: 'C:\\Users\\synthetic\\old-cut.mp4' },
      { where: 'gone', ref: 'synthetic/render/cut-c.mp4' },
      { where: 'folder', ref: 'Videos/R001 synthetic cut.mp4' },
    ])
    expect(plan.texts).toBe(2)
  })

  it('adds the videos the record lists, a Drive-for-desktop path apart from a local one, each master once', () => {
    const r = rec({
      asset_paths: [
        { path: 'H:\\My Drive\\synthetic\\master.mp4', status: 'present' },
        { path: 'C:\\Users\\synthetic\\master.mov', status: 'local only' },
        { path: 'C:\\Users\\synthetic\\gone.mp4', status: 'Overwritten by a later render' },
        { path: 'H:\\My Drive\\synthetic\\lost.mp4', status: 'missing' },
        { path: 'H:\\My Drive\\synthetic\\still.png' },
        { path: null },
        { path: 'H:\\My Drive\\synthetic\\cut-a.mp4', status: 'present' },
      ],
    })
    const plan = mediaOf(r, ['VIDEO KEPT IN PLACE: H:\\My Drive\\synthetic\\cut-a.mp4'])
    expect(plan.masters).toEqual([
      { where: 'drive_path', ref: 'H:\\My Drive\\synthetic\\cut-a.mp4' },
      { where: 'drive_path', ref: 'H:\\My Drive\\synthetic\\master.mp4' },
      { where: 'local', ref: 'C:\\Users\\synthetic\\master.mov' },
      { where: 'gone', ref: 'C:\\Users\\synthetic\\gone.mp4' },
      { where: 'gone', ref: 'H:\\My Drive\\synthetic\\lost.mp4' },
    ])
    expect(plan.stills).toEqual([])
    expect(plan.texts).toBe(0)
  })
})

describe('how a defect is kept', () => {
  // The theme the way fileRecord picks it: from the file for liked and process records, else from the theme text.
  const cap = (over: Partial<DumpRecord>, kind: Kind = 'rejected', media: MediaPlan = noMedia) => {
    const r = rec(over)
    const theme: ThemeSlug = kind === 'liked' ? 'liked' : kind === 'process' ? 'process' : themeOf(r.theme)
    return captureOf(r, kind, theme, media)
  }
  const motion = { category: 'Motion', theme: 'Motion that decorates, not explains' }
  const audio = { category: 'Audio', theme: 'Edit and A/V defects' }
  const component = { category: 'Component', theme: 'Edit and A/V defects' }

  it('keeps copy as words and a visual as a still, unless the visual fault runs through the cuts', () => {
    expect(cap({ category: 'Copy', theme: "Copy a stranger can't follow", item: 'synthetic: the hook line leans on jargon' })).toBe('words')
    expect(cap({ category: 'Visual', item: 'synthetic: a stock robot on the chapter card' })).toBe('still')
    expect(cap({ category: 'Brand', theme: 'Brand applied wrong', item: 'synthetic: the logo is the old colour' })).toBe('still')
    expect(cap({ category: 'Visual', item: 'synthetic: generic stock footage throughout the videos' })).toBe('whole_cut')
    expect(cap({ theme: 'Whole cut rejected', item: 'synthetic: start again' })).toBe('whole_cut')
  })

  it('keeps a fault in time as a moment, and an absence across the cut as the whole cut', () => {
    expect(cap({ ...motion, item: 'synthetic: the logo spins in for no reason' })).toBe('moment')
    expect(cap({ ...audio, item: 'synthetic: the short went out with no music under it' })).toBe('whole_cut')
    // A bare all or every inside a quoted line is not a fault across the cut.
    expect(cap({ ...audio, item: 'synthetic: a word is chopped at the join after "we answered all the questions, every one"' })).toBe('moment')
    expect(cap({ category: 'Footage', theme: 'Camera and footage treatment', item: 'synthetic: the handheld shot wobbles' })).toBe('moment')
    expect(cap({ category: 'Footage', theme: 'Camera and footage treatment', item: 'synthetic: the crop cuts off the chin' })).toBe('still')
  })

  it('keeps a burned caption as a still when what it says is wrong, and as a moment when it lags', () => {
    expect(cap({ ...component, item: 'synthetic: the burned-in caption misspells the guest name' })).toBe('still')
    expect(cap({ ...component, item: 'synthetic: the burned-in captions lag behind the voice' })).toBe('moment')
  })

  it('keeps words on screen as a still where they are on screen, and as words where they are only said', () => {
    expect(cap({ category: 'Copy', theme: 'Words on screen', item: 'synthetic: the card repeats the narration word for word' })).toBe('still')
    expect(cap({ category: 'Copy', theme: 'Words on screen', item: 'synthetic: the voice reads the line twice' })).toBe('words')
  })

  it('keeps a ruling and how a session worked as words, and a liked thing as a still only when there is an image', () => {
    expect(cap({ ...motion, item: 'synthetic: the proposed motion system for every chapter' })).toBe('words')
    expect(cap({ ...motion, item: 'synthetic: the logo spins in for no reason' }, 'process')).toBe('words')
    expect(cap({ item: 'synthetic: the warm grade' }, 'liked', { ...noMedia, stills: ['what he was looking at/R001 synthetic.png'] })).toBe('still')
    expect(cap({ item: 'synthetic: the warm grade' }, 'liked', { ...noMedia, strips: ['what he was looking at/R001 synthetic - frames.jpg'] })).toBe('still')
    expect(cap({ item: 'synthetic: the warm grade' }, 'liked')).toBe('words')
  })
})

describe('where in the cut', () => {
  it('takes his own words first, then a moment the record names', () => {
    const his = rec({ item: 'synthetic: the join at 01:05 is rough', quotes: [said('synthetic: the jump between 3 and 4 seconds is ugly')] })
    expect(momentOf(his, quotesOf(his))).toEqual({ ms: 3500, anchor: null, origin: 'krish' })
    const named = rec({ item: 'synthetic: the join at 01:05 is rough', quotes: [said('synthetic: fix the join')] })
    expect(momentOf(named, quotesOf(named))).toEqual({ ms: 65000, anchor: null, origin: 'record' })
    // Seconds in a quote that is not his words are not his moment.
    const seen = rec({ confidence: 'paraphrased ruling', item: 'synthetic: the jump is ugly', quotes: [said('synthetic: the jump between 3 and 4 seconds')] })
    expect(momentOf(seen, quotesOf(seen))).toBeNull()
  })

  it('never reads a clock time as a moment', () => {
    for (const item of ['synthetic: sent at 8:41 pm, the join is rough', 'synthetic: from 8:41pm onwards', 'synthetic: around 11:05 P.M. he replied']) {
      expect(momentOf(rec({ item }), []), item).toBeNull()
    }
  })

  it('falls back on where he points, and says nothing when nothing says', () => {
    expect(momentOf(rec({ item: 'synthetic: the logo pops in on the last frame' }), [])).toEqual({ ms: null, anchor: 'end', origin: 'anchor' })
    const opening = rec({ item: 'synthetic: slow', quotes: [said('synthetic: the opening is too slow')] })
    expect(momentOf(opening, quotesOf(opening))).toEqual({ ms: null, anchor: 'start', origin: 'anchor' })
    expect(momentOf(rec({ item: 'synthetic: the join is rough' }), [])).toBeNull()
  })
})

describe('a record version', () => {
  const base = (over: Partial<DumpRecord> = {}) => rec({
    category: 'Motion', theme: 'Motion that decorates, not explains', item: 'synthetic: the logo spins in for no reason',
    quotes: [said('synthetic: the spin between 3 and 4 seconds is pointless', '2026-10-01T09:00:00Z')], ...over,
  })

  it('files a rejection with its theme, formats, capture and moment, and a moment only for a fault in time', () => {
    const { quotes, record } = fileRecord(base(), 'rejected', [])
    expect(quotes).toHaveLength(1)
    expect(record).toMatchObject({
      source: 'drive_dump', kind: 'rejected', rejectedAt: '2026-10-01T12:00:00.000Z', attribution: 'krish_words', strength: 'rejected',
      theme: 'decorative_motion', formats: ['short_video'], ruleKind: 'form', capture: 'moment',
      moment: { ms: 3500, anchor: null, origin: 'krish' },
    })
    expect(record.sourceRef).toMatch(/^dump:[0-9a-f]{24}$/)
    expect(record.quoteKeys).toEqual([quotes[0]!.key])
    const copy = fileRecord(base({ category: 'Copy', theme: "Copy a stranger can't follow" }), 'rejected', []).record
    expect(copy.capture).toBe('words')
    expect(copy.moment).toBeNull()
  })

  it('files liked and process records under their own theme, whatever the theme text says', () => {
    expect(fileRecord(base(), 'liked', []).record).toMatchObject({ theme: 'liked', ruleKind: 'form', capture: 'words' })
    expect(fileRecord(base(), 'process', []).record).toMatchObject({ theme: 'process', ruleKind: 'workflow', capture: 'words' })
  })

  it('keeps what he liked in copy or a script as subject, never served, and what he liked in a frame as form', () => {
    expect(fileRecord(base({ category: 'copy/script' }), 'liked', []).record.ruleKind).toBe('subject')
    expect(fileRecord(base({ category: 'Copy' }), 'liked', []).record.ruleKind).toBe('subject')
    expect(fileRecord(base({ category: 'visual asset' }), 'liked', []).record.ruleKind).toBe('form')
    // A rejection in copy is form: how a line reads is craft (his story-angle theme is what makes a rejection subject).
    expect(fileRecord(base({ category: 'copy/script', theme: "Copy a stranger can't follow" }), 'rejected', []).record.ruleKind).toBe('form')
  })

  it('keeps its identity and version when the dump renumbers it', () => {
    const a = fileRecord(base(), 'rejected', ['what he was looking at/R001 synthetic - frames.jpg']).record
    const b = fileRecord(base({ id: 'R077' }), 'rejected', ['what he was looking at/R077 synthetic - frames.jpg']).record
    expect(b.sourceRef).toBe(a.sourceRef)
    expect(b.version).toBe(a.version)
    expect(b.meta.dump_id).toBe('R077')
  })

  it('gets a new identity when his quote changes, but not when only its marks, spacing or case do', () => {
    const a = fileRecord(base(), 'rejected', []).record
    const retyped = fileRecord(base({ quotes: [said(' synthetic:  The spin between 3 and 4 seconds is POINTLESS ', '2026-10-01T09:00:00Z')] }), 'rejected', []).record
    expect(retyped.sourceRef).toBe(a.sourceRef)
    const changed = fileRecord(base({ quotes: [said('synthetic: the spin is fine actually', '2026-10-01T09:00:00Z')] }), 'rejected', []).record
    expect(changed.sourceRef).not.toBe(a.sourceRef)
  })

  it('gets a new version, not a new identity, when only the item changes, unless the item is what tells it apart', () => {
    const a = fileRecord(base(), 'rejected', []).record
    const b = fileRecord(base({ item: 'synthetic: the logo spins in twice' }), 'rejected', []).record
    expect(b.sourceRef).toBe(a.sourceRef)
    expect(b.version).not.toBe(a.version)
    const ac = fileRecord(base(), 'rejected', [], true).record
    const bc = fileRecord(base({ item: 'synthetic: the logo spins in twice' }), 'rejected', [], true).record
    expect(bc.sourceRef).not.toBe(ac.sourceRef)
    expect(ac.sourceRef).not.toBe(a.sourceRef)
  })

  it('gets a new version under the new label, not a new identity, when a merge pass reclasses his words', () => {
    const a = fileRecord(base(), 'rejected', []).record
    const b = fileRecord(base({ confidence: 'paraphrased ruling' }), 'rejected', []).record
    expect(a.attribution).toBe('krish_words')
    expect(b.attribution).toBe('observation')
    expect(b.sourceRef).toBe(a.sourceRef)
    expect(b.version).not.toBe(a.version)
  })

  it('keys a record with no quote of his by its date, piece and item, and never calls it his words', () => {
    const r = rec({ item: 'synthetic: a grey card' })
    const a = fileRecord(r, 'rejected', []).record
    expect(a.attribution).toBe('observation')
    expect(a.quoteKeys).toEqual([])
    expect(fileRecord({ ...r, id: 'R050' }, 'rejected', []).record.sourceRef).toBe(a.sourceRef)
    expect(fileRecord({ ...r, item: 'synthetic: a beige card' }, 'rejected', []).record.sourceRef).not.toBe(a.sourceRef)
  })

  // src bug, the same root as saidAtOf: rejectedAt is built from the record's date without checking the day exists.
  it('never files a rejection at a day that does not exist', () => {
    const { rejectedAt } = fileRecord(rec({ date: '2026-02-30' }), 'rejected', []).record
    expect(new Date(rejectedAt).toISOString()).toBe(rejectedAt)
  })
})

describe('the whole dump', () => {
  const shared = said('synthetic: this whole look is off', '2026-10-02')
  const twin = (id: string, item: string, over: Partial<DumpRecord> = {}) =>
    rec({ id, date: '2026-10-02', category: 'Visual', item, quotes: [shared], ...over })

  it('tells apart two records on the same quotes and category by their item', () => {
    const filed = fileDump(dumpOf([twin('R001', 'synthetic: the grey card'), twin('R002', 'synthetic: the clipart robot')]))
    const refs = filed.records.map(r => r.sourceRef)
    expect(new Set(refs).size).toBe(2)
    expect(filed.collisions).toBe(0)
    expect(filed.quotes.size).toBe(1)
    // Alone, the record would keep the identity its quotes give it; shared, its item joins that identity.
    expect(refs).not.toContain(fileRecord(twin('R001', 'synthetic: the grey card'), 'rejected', []).record.sourceRef)
  })

  it('keeps records whose quotes and item are both shared apart by their own content, whichever a merge pass writes first', () => {
    const a = twin('R001', 'synthetic: the grey card')
    const b = twin('R002', 'synthetic: the grey card', { piece: 'synthetic: piece two' })
    const c = twin('R003', 'synthetic: the grey card', { reason: 'synthetic: too dull' })
    const refsOf = (order: DumpRecord[]) => new Map(fileDump(dumpOf(order)).records.map(r => [r.meta.dump_id, r.sourceRef]))
    const ab = refsOf([a, b, c])
    expect(new Set(ab.values()).size).toBe(3)
    expect(fileDump(dumpOf([a, b, c])).collisions).toBe(3)
    // The same record, the same identity, in any order.
    expect(refsOf([c, b, a])).toEqual(ab)
    expect(refsOf([b, a, c])).toEqual(ab)
    // Only a record the same in every way is numbered: it is the same record twice.
    const same = fileDump(dumpOf([a, { ...a, id: 'R009' }])).records.map(r => r.sourceRef)
    expect(same[1]).toBe(`${same[0]}:1`)
  })

  it('files a quote two records share once, and the strongest reading of it wins in either order', () => {
    const seen = rec({ id: 'R001', confidence: 'paraphrased ruling', quotes: [said('synthetic: the cover is muddy', '2026-10-01')] })
    const his = rec({ id: 'R002', category: 'Brand', item: 'synthetic: the logo is off-brand', quotes: [said('synthetic: The cover is muddy', '2026-10-01T10:00:00Z')] })
    for (const order of [[seen, his], [his, seen]]) {
      const filed = fileDump(dumpOf(order))
      expect(filed.quotes.size).toBe(1)
      const [quote] = [...filed.quotes.values()]
      expect(quote).toMatchObject({ attribution: 'krish_words', precision: 'second', saidAt: '2026-10-01T10:00:00.000Z' })
      for (const r of filed.records) expect(r.quoteKeys).toEqual([quote!.key])
    }
  })

  it('prefers the reading to the second when two readings of a quote are equally his', () => {
    const byDay = rec({ id: 'R001', quotes: [said('synthetic: the cover is muddy', '2026-10-01')] })
    const bySecond = rec({ id: 'R002', category: 'Brand', item: 'synthetic: the logo is off-brand', quotes: [said('synthetic: the cover is muddy', '2026-10-01T10:00:00Z')] })
    for (const order of [[byDay, bySecond], [bySecond, byDay]]) {
      expect([...fileDump(dumpOf(order)).quotes.values()].map(q => q.precision)).toEqual(['second'])
    }
  })
})

describe('what he liked nearby', () => {
  it('finds a liked quote from the same message, then one about the same piece that day', () => {
    const rejected = rec({ id: 'R001', date: '2026-10-03', quotes: [said('synthetic: the outro drags', '2026-10-03T09:00:00Z', 'cloud')] })
    const sameMessage = rec({ id: 'L001', date: '2026-10-03', piece: 'synthetic: another piece', quotes: [said('synthetic: but the hook is great', '2026-10-03T09:00:00Z', 'cloud')] })
    const samePiece = rec({ id: 'L002', date: '2026-10-03', piece: 'Synthetic:  PIECE one', quotes: [said('synthetic: the cover works', '2026-10-03T15:00:00Z', 'cloud')] })
    const otherSource = rec({ id: 'L003', date: '2026-10-03', piece: 'synthetic: a third piece', quotes: [said('synthetic: the music is right', '2026-10-03T09:00:00Z', 'codex')] })
    const otherDay = rec({ id: 'L004', date: '2026-10-04', quotes: [said('synthetic: the title is right', '2026-10-04T09:00:00Z', 'cloud')] })
    const filed = fileDump(dumpOf([rejected], [sameMessage, samePiece, otherSource, otherDay]))
    const near = nearOf(filed.records, filed.quotes)
    const ref = filed.records.find(r => r.kind === 'rejected')!.sourceRef
    const keyOf = (r: DumpRecord) => quotesOf(r)[0]!.key
    expect(near.get(ref)).toEqual([
      { key: keyOf(sameMessage), basis: 'same_message' as const },
      { key: keyOf(samePiece), basis: 'same_piece' as const },
    ].sort((a, b) => a.key.localeCompare(b.key)))
    // Liked records are the boundary, never given one of their own.
    expect(near.size).toBe(1)
  })

  it('never makes what he liked in copy anyone\'s boundary: it is what a piece says', () => {
    const rejected = rec({ id: 'R001', date: '2026-10-03', quotes: [said('synthetic: the outro drags', '2026-10-03T09:00:00Z', 'cloud')] })
    const copy = rec({ id: 'L001', date: '2026-10-03', category: 'copy/script', quotes: [said('synthetic: the landing is right', '2026-10-03T09:00:00Z', 'cloud')] })
    const filed = fileDump(dumpOf([rejected], [copy]))
    expect(nearOf(filed.records, filed.quotes).size).toBe(0)
  })

  it('never calls a quote known only to the day the same message', () => {
    const rejected = rec({ id: 'R001', date: '2026-10-03', quotes: [said('synthetic: the outro drags', '2026-10-03', 'cloud')] })
    const liked = rec({ id: 'L001', date: '2026-10-03', piece: 'synthetic: another piece', quotes: [said('synthetic: the hook is great', '2026-10-03', 'cloud')] })
    const filed = fileDump(dumpOf([rejected], [liked]))
    expect(nearOf(filed.records, filed.quotes).size).toBe(0)
  })
})

describe('one quote classed two ways', () => {
  const q = (attribution: QuoteRow['attribution'], precision: QuoteRow['precision'] = 'day', source: QuoteRow['source'] = 'cloud'): QuoteRow => ({
    key: quoteKey('synthetic: the join chops a word', '2026-10-03'), text: 'synthetic: the join chops a word',
    saidAt: precision === 'day' ? '2026-10-03T12:00:00.000Z' : '2026-10-03T09:00:00.000Z', precision, saidWhere: 'synthetic', source, attribution,
  })

  it('holds his words over his action, and either over a paraphrase, whichever is read first', () => {
    for (const order of [['observation', 'krish_words'], ['krish_words', 'observation'], ['krish_action', 'krish_words', 'observation']] as const) {
      const held = new Map<string, QuoteRow>()
      for (const a of order) holdQuote(held, q(a))
      expect(held.get(q('krish_words').key)!.attribution).toBe('krish_words')
    }
    const held = new Map<string, QuoteRow>()
    holdQuote(held, q('observation'))
    holdQuote(held, q('krish_action'))
    expect(held.get(q('krish_action').key)!.attribution).toBe('krish_action')
  })

  it('holds the one that knows the second, at the same rank, and never trades his words for it', () => {
    const held = new Map<string, QuoteRow>()
    holdQuote(held, q('krish_words', 'day'))
    holdQuote(held, q('krish_words', 'second', 'session_report'))
    expect(held.get(q('krish_words').key)).toMatchObject({ precision: 'second', source: 'session_report' })
    holdQuote(held, q('observation', 'second', 'capture'))
    expect(held.get(q('krish_words').key)).toMatchObject({ attribution: 'krish_words', source: 'session_report' })
  })
})
