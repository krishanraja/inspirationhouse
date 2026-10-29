import { describe, it, expect } from 'vitest'
import { DRIVE } from '../src/config.ts'
import { FOLDER_MIME, type DriveFile, type Google } from '../src/google.ts'
import { collectDrive, inspirationTree } from '../src/collect/drive.ts'
import { syncItems } from '../src/tag/items.ts'
import { machineStillsOf, productionTags, understandCards } from '../src/tag/understand.ts'
import type { Db } from '../src/db.ts'

// W3.2: his whole Inspiration tree as cards, machine stills never his, and the understanding pass. Synthetic files only.
const sha = (c: string) => c.repeat(64)
const file = (id: string, name: string, o: Partial<DriveFile> = {}): DriveFile =>
  ({ id, name, mimeType: 'video/mp4', modifiedTime: '2026-10-29T10:00:00Z', createdTime: '2026-10-29T10:00:00Z', ...o })

// Content Inspo holds a file, a subfolder with a file, a machine still someone copied in, and a second copy of a file.
const tree: Record<string, DriveFile[]> = {
  [DRIVE.coldIdeas]: [
    file('1SYNcold000a', 'a post.mp4', { sha256Checksum: sha('a'), createdTime: '2026-10-20T10:00:00Z' }),
    file('1SYNsubfold0', 'saved later', { mimeType: FOLDER_MIME }),
    file('1SYNmachine0', 'still 03.jpg', { mimeType: 'image/jpeg', sha256Checksum: sha('e') }),
    file(DRIVE.whatILikeSheet, 'What I like', { mimeType: 'application/vnd.google-apps.spreadsheet' }),
  ],
  '1SYNsubfold0': [
    file('1SYNcold000b', 'deeper.png', { mimeType: 'image/png', sha256Checksum: sha('b') }),
    file('1SYNcold000c', 'a post copy.mp4', { sha256Checksum: sha('a'), createdTime: '2026-10-25T10:00:00Z' }),
  ],
  [DRIVE.videoInspiration]: [file('1SYNvideo00a', 'a cut.mp4', { sha256Checksum: sha('c') })],
}
const google = { listFolder: async (id: string) => tree[id] ?? [] } as unknown as Google
const machine = new Set([sha('e')])

describe('his Inspiration tree', () => {
  it('reads every branch, folds a second copy into the first, and leaves out the sheet and every machine still', async () => {
    const t = await inspirationTree(google, machine)
    expect(t.files.map(f => [f.f.id, f.folder, f.path]).sort()).toEqual([
      ['1SYNcold000a', 'cold_ideas', 'a post.mp4'],
      ['1SYNcold000b', 'cold_ideas', 'saved later/deeper.png'],
      ['1SYNvideo00a', 'video_inspiration', 'a cut.mp4'],
    ])
    expect(t).toMatchObject({ machine: 1, duplicates: 1 })
  })
  it('never counts a machine still as his: no evidence of his action, and no card', async () => {
    const evidence = await collectDrive(google, machine)
    expect(evidence.map(e => e.sourceRef).sort()).toEqual(['1SYNcold000a', '1SYNcold000b', '1SYNvideo00a'])
    expect(evidence.every(e => e.attribution === 'krish_action')).toBe(true)
    const db = { query: async () => [{ n: 0 }] } as unknown as Db
    const items = await syncItems(db, google, false, machine)
    expect([...items.files.keys()]).not.toContain('1SYNmachine0')
    expect(items).toMatchObject({ seen: 3, machine: 1, duplicates: 1 })
  })
})

const READ = {
  shape: 'video',
  video: { aspect: '9:16', duration_s: 69.3 },
  faces: { available: true, share_on_face: 1, framing: 'wide' },
  shots: { cuts_per_min: 0, list: [{ screen_text: ['synthetic'] }] },
  camera_moves: [{ kind: 'push_in' }],
  hook: { cuts: 0, face_on_screen: true, screen_text: ['synthetic'] },
  pace: { speech_share: 0.94, sound_without_words_share: 0.06, words_per_min: 225 },
  machine_stills: { format: 'content-watcher.machine-stills/1', owner: 'machine', counts_as_his: false,
    items: [{ still_sha256: sha('e'), tags: ['machine', 'hook', 'face:on'] }, { still_sha256: sha('f'), tags: ['machine', 'cut'] }] },
}

describe('the understanding pass', () => {
  it('tags how a thing is made from what was measured, by rule', () => {
    expect(productionTags(READ)).toEqual(['aspect:9_16', 'framing:wide', 'hook:face', 'hook:words_on_screen', 'move:push_in',
      'on_camera', 'shape:video', 'single_take', 'speech:fast', 'talk_led', 'words_on_screen'])
    expect(productionTags({})).toEqual([])
    expect(productionTags({ shots: { cuts_per_min: 30 }, faces: { available: true, share_on_face: 0 } })).toEqual(['faceless', 'fast_cutting'])
  })
  it('keeps machine stills as the machine\'s, whatever their block says of itself', () => {
    expect(machineStillsOf(READ)).toEqual({ count: 2, still_sha256: [sha('e'), sha('f')], tags: ['cut', 'face:on', 'hook'] })
    expect(machineStillsOf({})).toBeNull()
  })
  it('writes the tags and the stills on the card as measured and machine, never his', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db = { query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (/to_regclass/.test(sql)) return [{ ok: true }]
      if (/from public\.content_reads/.test(sql)) return [{ sha256: sha('c'), read: READ }]
      return [{ n: 1 }]
    } } as unknown as Db
    const files = new Map([['1SYNvideo00a', file('1SYNvideo00a', 'a cut.mp4', { sha256Checksum: sha('c').toUpperCase() })]])
    expect(await understandCards(db, files, true)).toEqual({ read: 1, understood: 1, stills: 1 })
    const rows = JSON.parse(String(calls.at(-1)!.params[0]))
    expect(rows[0]).toMatchObject({
      drive_file_id: '1SYNvideo00a',
      understanding: { origin: 'measured', production: expect.arrayContaining(['on_camera', 'single_take']) },
      machine_stills: { owner: 'machine', counts_as_his: false, count: 2 },
    })
    // Only facets are written.
    expect(calls.at(-1)!.sql).toMatch(/set facets = i\.facets \|\|/)
    expect(calls.at(-1)!.sql).not.toMatch(/why_here|why_like|would_do|answered/)
  })
})
