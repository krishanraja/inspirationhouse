import { describe, it, expect } from 'vitest'
import { DRIVE } from '../src/config.ts'
import type { Source } from '../src/evidence.ts'
import {
  CUE_VENTURE, FLOOR_VENTURE, FOLDER_VENTURE, MINDMAKE, MYMU, SOURCE_VENTURE, VENTURE_NAMES, byVenture, folderVenture, ventureName,
  ventureOf,
} from '../src/venture.ts'

// Every source the engine writes, so a new one cannot slip in without a venture rule (src/evidence.ts Source).
const SOURCES: Source[] = [
  'learnings_json', 'title_verdicts', 'golden_examples', 'rejected_lines', 'style_references', 'style_bank', 'drive_cold',
  'drive_video', 'what_i_like_sheet', 'idea_triage', 'feedback_hist', 'creator_move', 'visibility_target', 'drive_artifact',
  'inspiration_page', 'session_report',
]

describe('the venture of a row', () => {
  it('is Make Your Mind Up\'s for every source but the three that depend on the row', () => {
    for (const s of SOURCES.filter(s => !['session_report', 'visibility_target', 'feedback_hist'].includes(s))) {
      expect(ventureOf(s), s).toBe('publication')
      expect(SOURCE_VENTURE[s as keyof typeof SOURCE_VENTURE], s).toBe('publication')
    }
    expect(MYMU).toBe('publication')
  })

  it('takes a visibility target\'s product, and Mindmake\'s for a target with none', () => {
    expect(ventureOf('visibility_target', { product: 'fractionl_pulse' })).toBe('fractionl_pulse')
    expect(ventureOf('visibility_target', { product: null })).toBe(MINDMAKE)
    expect(ventureOf('visibility_target')).toBe(MINDMAKE)
  })

  it('gives Nova\'s and Nell\'s feedback to Mindmake, and Cleo\'s to Make Your Mind Up', () => {
    expect(ventureOf('feedback_hist', { agent: 'nova' })).toBe('mindmake')
    expect(ventureOf('feedback_hist', { agent: 'nell' })).toBe('mindmake')
    expect(ventureOf('feedback_hist', { agent: 'cleo' })).toBe('publication')
  })

  it('takes a report\'s own venture, and none for a report held unassigned', () => {
    expect(ventureOf('session_report', { report: 'heartside' })).toBe('heartside')
    expect(ventureOf('session_report', { report: null })).toBeNull()
    expect(ventureOf('session_report')).toBeNull()
  })

  it('never depends on anything a model could say: the facts are the row\'s own columns', () => {
    // A report's words naming another venture change nothing; only the report's venture does.
    expect(ventureOf('learnings_json', { report: 'heartside', product: 'heartside', agent: 'nova' })).toBe('publication')
  })
})

describe('Drive folders and cues', () => {
  it('gives both Inspiration folders and Rejections to Make Your Mind Up, as the sources they feed', () => {
    expect(folderVenture(DRIVE.coldIdeas)).toBe(ventureOf('drive_cold'))
    expect(folderVenture(DRIVE.videoInspiration)).toBe(ventureOf('drive_video'))
    expect(folderVenture(DRIVE.rejections)).toBe('publication')
    expect(Object.keys(FOLDER_VENTURE).sort()).toEqual([DRIVE.coldIdeas, DRIVE.videoInspiration, DRIVE.rejections].sort())
  })

  it('refuses a folder no one has said the venture of', () => {
    expect(() => folderVenture('1aSyntheticFolderIdNoOneMapped00')).toThrow(/no venture/)
  })

  it('files the cues stage\'s cues and the floor under Make Your Mind Up', () => {
    expect(CUE_VENTURE).toEqual({ idea_queue: 'publication', inspiration_card: 'publication' })
    expect(FLOOR_VENTURE).toBe('publication')
  })
})

describe('names and order', () => {
  it('names each venture as it is rendered, and shows an unknown slug as itself', () => {
    expect(ventureName('publication')).toBe('Make Your Mind Up')
    expect(ventureName('mindmake')).toBe('Mindmake')
    expect(ventureName('mm_ctrl')).toBe('CTRL')
    expect(ventureName('signal_noise')).toBe('Signal & Noise')
    expect(ventureName('investor')).toBe('investor')
    expect(ventureName('toString')).toBe('toString')
    expect(Object.keys(VENTURE_NAMES)).toHaveLength(9)
  })

  it('puts Make Your Mind Up first, then the rest by slug', () => {
    expect(['mindmake', 'heartside', 'publication', 'full_time'].sort(byVenture)).toEqual(['publication', 'full_time', 'heartside', 'mindmake'])
  })
})
