import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DRIVE } from '../src/config.ts'
import { readOnly, type Db } from '../src/db.ts'
import { FOLDER_MIME, type DriveFile, type Google } from '../src/google.ts'
import type { RecordRow } from '../src/rejection/file.ts'
import { KEEP_BUDGET_MS, MASTER_MAX_BYTES, MASTERS_PER_RUN, keepMedia, pathResolver, type KeepDeps } from '../src/rejection/keep.ts'
import {
  CLIP_MAX_BYTES, CLIP_MS, CUT_REV, IMAGE_MAX_BYTES, STRIP_FRAMES, cutMoment, keepStill, keepStrip, probe, stripAcross, windowAround, type Kept,
} from '../src/rejection/media.ts'

// Synthetic media and Drive files only; nothing here is anything Krish rejected. Every clip and image is made here
// with ffmpeg's test sources, and every Drive id is made up.

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
// CI installs ffmpeg and sets REQUIRE_FFMPEG: there, a missing ffmpeg is a fault, never a quiet skip.
if (process.env.REQUIRE_FFMPEG && !hasFfmpeg) throw new Error('REQUIRE_FFMPEG is set but ffmpeg or ffprobe is missing')
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])

// A vertical master with sound, a still far over the image cap, and a small still, made once for the whole file.
let fx = ''
const master = () => join(fx, 'synthetic-master.mp4')
const bigPng = () => join(fx, 'synthetic-big.png')
const smallPng = () => join(fx, 'synthetic-small.png')
beforeAll(() => {
  if (!hasFfmpeg) return
  fx = mkdtempSync(join(tmpdir(), 'rejection-media-test-'))
  ff(['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=1080x1920:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', master()])
  // Noise keeps the PNG large, so the cap is what decides the JPEG's size.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=3000x2000:rate=1', '-vf', 'noise=alls=40:allf=t', '-frames:v', '1', bigPng()])
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-frames:v', '1', smallPng()])
}, 60_000)
afterAll(() => { if (fx) rmSync(fx, { recursive: true, force: true }) })

/** What ffprobe says of a kept file's streams, read from a temp copy of its bytes. */
function streamsOf(bytes: Buffer): Array<{ codec_type: string; channels?: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'rejection-probe-'))
  try {
    const f = join(dir, 'kept')
    writeFileSync(f, bytes)
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,channels', '-of', 'json', f]).toString()
    return (JSON.parse(out) as { streams: Array<{ codec_type: string; channels?: number }> }).streams
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const isJpeg = (b: Buffer) => b.subarray(0, 3).toString('hex') === 'ffd8ff'

describe('windowAround', () => {
  it('centres the 4 s window on the moment', () => {
    expect(windowAround(5000, 10_000)).toEqual({ from: 3000, to: 7000 })
    // No stated length: centred, never held.
    expect(windowAround(5000, null)).toEqual({ from: 3000, to: 7000 })
  })
  it('holds the window to the start when the moment is near it', () => {
    expect(windowAround(500, 10_000)).toEqual({ from: 0, to: CLIP_MS })
    expect(windowAround(0, 10_000)).toEqual({ from: 0, to: CLIP_MS })
  })
  it('holds the window to the end when the moment is near it or past it', () => {
    expect(windowAround(9500, 10_000)).toEqual({ from: 6000, to: 10_000 })
    expect(windowAround(12_000, 10_000)).toEqual({ from: 6000, to: 10_000 })
  })
  it('keeps the whole of a clip shorter than 4 s', () => {
    expect(windowAround(1000, 2500)).toEqual({ from: 0, to: 2500 })
    expect(windowAround(2400, 2500)).toEqual({ from: 0, to: 2500 })
  })
})

describe.skipIf(!hasFfmpeg)('media on the runner', () => {
  it('keeps a large still as one JPEG under the cap and at most 1280 px wide', async () => {
    const k = await keepStill(readFileSync(bigPng()))
    expect(k.role).toBe('screenshot')
    expect(k.mime).toBe('image/jpeg')
    expect(isJpeg(k.bytes)).toBe(true)
    expect(k.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
    expect(k.width).toBe(1280)
    expect(k.height).toBe(854)
    expect(k.sha256).toBe(sha(k.bytes))
    expect(k).toMatchObject({ durationMs: null, atMs: null, windowFromMs: null, windowToMs: null, framesN: null })
  }, 30_000)

  it('re-encodes a small still without making it larger', async () => {
    // Every kept image is one format with no source metadata, so a small PNG is a JPEG of the same width.
    const k = await keepStill(readFileSync(smallPng()))
    expect(k.mime).toBe('image/jpeg')
    expect(isJpeg(k.bytes)).toBe(true)
    expect(k.width).toBe(640)
  }, 30_000)

  it('keeps an existing strip as a strip of six frames', async () => {
    const k = await keepStrip(readFileSync(smallPng()))
    expect(k.role).toBe('strip')
    expect(k.framesN).toBe(STRIP_FRAMES)
    expect(k.framesN).toBe(6)
    expect(k.mime).toBe('image/jpeg')
  }, 30_000)

  it('cuts a 4 s clip with its sound, and a strip across the same window, around a moment', async () => {
    const { clip, strip } = await cutMoment(master(), 3500)
    expect(clip.role).toBe('clip')
    expect(clip.mime).toBe('video/mp4')
    expect(clip.bytes.length).toBeLessThanOrEqual(CLIP_MAX_BYTES)
    expect(clip.durationMs).not.toBeNull()
    expect(clip.durationMs!).toBeLessThanOrEqual(CLIP_MS + 500)
    expect(clip.width).toBe(480)
    expect(clip).toMatchObject({ atMs: 3500, windowFromMs: 1500, windowToMs: 5500, framesN: null })
    expect(clip.sha256).toBe(sha(clip.bytes))
    // The sound stays, in mono.
    expect(streamsOf(clip.bytes)).toEqual(expect.arrayContaining([{ codec_type: 'audio', channels: 1 }, expect.objectContaining({ codec_type: 'video' })]))

    expect(strip).toMatchObject({ role: 'strip', mime: 'image/jpeg', framesN: 6, atMs: 3500, windowFromMs: 1500, windowToMs: 5500 })
    expect(strip.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
    // Six frames side by side: about six times as wide as one frame of the 9:16 master.
    expect(strip.width / STRIP_FRAMES).toBeCloseTo(320, 0)
    expect(strip.width / strip.height).toBeCloseTo((STRIP_FRAMES * 1080) / 1920, 1)
  }, 30_000)

  it('holds a moment near the end inside the cut', async () => {
    const length = (await probe(master())).durationMs!
    const { clip, strip } = await cutMoment(master(), length - 200)
    expect(clip.windowToMs).toBe(length)
    expect(clip.windowFromMs).toBe(length - CLIP_MS)
    expect(clip.atMs).toBe(length - 200)
    expect(clip.durationMs!).toBeLessThanOrEqual(CLIP_MS + 500)
    expect(clip.durationMs!).toBeGreaterThan(CLIP_MS - 500)
    expect(strip).toMatchObject({ windowFromMs: length - CLIP_MS, windowToMs: length, framesN: 6 })
  }, 30_000)

  it('takes a strip across the whole cut, from its start to its end', async () => {
    const length = (await probe(master())).durationMs!
    const s = await stripAcross(master())
    expect(s).toMatchObject({ role: 'strip', mime: 'image/jpeg', framesN: 6, atMs: null, windowFromMs: 0, windowToMs: length })
    expect(s.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
  }, 30_000)
})

// Drive as the engine sees it: made-up folders and files under the roots it knows.
const H = 'H:\\My Drive\\Ventures\\Active Ventures\\makeyourmindup'
const postsPath = (...names: string[]) => `${H}\\3 Posts\\${names.join('\\')}`
const id = (n: number) => `1SYNTHETICfileid${String(n).padStart(12, '0')}`
const fid = (n: number) => `1SYNTHETICfolder${String(n).padStart(12, '0')}`
const drive = (fileId: string, name: string, over: Partial<DriveFile> = {}): DriveFile =>
  ({ id: fileId, name, mimeType: 'video/mp4', modifiedTime: '2026-10-24T00:00:00Z', createdTime: '2026-10-24T00:00:00Z', size: '10000000', ...over })
const folder = (folderId: string, name: string): DriveFile => drive(folderId, name, { mimeType: FOLDER_MIME, size: '0' })

const ORIGINAL = drive(id(1), 'synthetic-master.mp4', { videoMediaMetadata: { durationMillis: '8000' } })
const FINAL = drive(id(2), 'synthetic-final.mp4', { videoMediaMetadata: { durationMillis: '8000' } })
const IN_REJECTIONS = drive(id(5), 'synthetic-copy.mp4')
const TREE: Record<string, DriveFile[]> = {
  [DRIVE.posts]: [folder(fid(1), 'synthetic-piece-one'), folder(fid(2), 'synthetic-piece-two'), folder(fid(4), 'synthetic-twin'), folder(fid(5), 'synthetic-twin')],
  [fid(1)]: [ORIGINAL, folder(fid(3), 'renders')],
  [fid(3)]: [FINAL],
  // Two files under one name: never guessed between.
  [fid(2)]: [drive(id(3), 'synthetic-master.mp4'), drive(id(4), 'synthetic-master.mp4')],
  [DRIVE.archive]: [drive(id(6), 'synthetic-archived.mp4')],
  [DRIVE.rejections]: [folder(fid(6), 'assets')],
  [fid(6)]: [IN_REJECTIONS],
}
function listing(tree: Record<string, DriveFile[]> = TREE) {
  const listed: string[] = []
  return { listed, google: { listFolder: async (folderId: string) => { listed.push(folderId); return tree[folderId] ?? [] } } }
}

describe('pathResolver', () => {
  it('walks a Drive-for-desktop path from the 3 Posts root one name at a time', async () => {
    const l = listing()
    const hit = await pathResolver(l.google)(postsPath('synthetic-piece-one', 'renders', 'synthetic-final.mp4'))
    expect(hit).toEqual({ file: FINAL, root: DRIVE.posts })
    expect(l.listed).toEqual([DRIVE.posts, fid(1), fid(3)])
  })

  it('lists each folder once however many paths go through it', async () => {
    const l = listing()
    const resolve = pathResolver(l.google)
    expect(await resolve(postsPath('synthetic-piece-one', 'synthetic-master.mp4'))).toEqual({ file: ORIGINAL, root: DRIVE.posts })
    expect(await resolve(postsPath('synthetic-piece-one', 'renders', 'synthetic-final.mp4'))).toMatchObject({ file: { id: FINAL.id } })
    expect(l.listed).toEqual([DRIVE.posts, fid(1), fid(3)])
  })

  it('reads the drive letter and the case as Windows does', async () => {
    const hit = await pathResolver(listing().google)('G:\\my drive\\ventures\\active ventures\\makeyourmindup\\3 posts\\synthetic-piece-one\\synthetic-master.mp4')
    expect(hit).toEqual({ file: ORIGINAL, root: DRIVE.posts })
  })

  it('knows the Archive and Rejections roots', async () => {
    const resolve = pathResolver(listing().google)
    expect(await resolve(`${H}\\Video Engine\\Archive\\synthetic-archived.mp4`)).toMatchObject({ file: { id: id(6) }, root: DRIVE.archive })
    expect(await resolve(`${H}\\Video Engine\\Rejections\\assets\\synthetic-copy.mp4`)).toEqual({ file: IN_REJECTIONS, root: DRIVE.rejections })
  })

  it('refuses a name two files share, at the file or at a folder on the way', async () => {
    const resolve = pathResolver(listing().google)
    expect(await resolve(postsPath('synthetic-piece-two', 'synthetic-master.mp4'))).toBe('ambiguous')
    expect(await resolve(postsPath('synthetic-twin', 'synthetic-master.mp4'))).toBe('ambiguous')
  })

  it('never guesses a path under no known root', async () => {
    const l = listing()
    const resolve = pathResolver(l.google)
    expect(await resolve('H:\\My Drive\\Somewhere Else\\synthetic-master.mp4')).toBeNull()
    expect(await resolve('C:\\Users\\synthetic\\Videos\\synthetic-master.mp4')).toBeNull()
    expect(await resolve('/home/synthetic/synthetic-master.mp4')).toBeNull()
    expect(l.listed).toEqual([])
  })

  it('finds nothing for a missing name, a folder at the end, or a file in the middle', async () => {
    const resolve = pathResolver(listing().google)
    expect(await resolve(postsPath('synthetic-piece-one', 'synthetic-absent.mp4'))).toBeNull()
    expect(await resolve(postsPath('synthetic-piece-one', 'renders'))).toBeNull()
    expect(await resolve(postsPath('synthetic-piece-one', 'synthetic-master.mp4', 'synthetic-final.mp4'))).toBeNull()
  })
})

// A standing record as file.ts makes one, with only what the media stage reads changed per test.
const record = (ref: string, over: Partial<RecordRow> = {}): RecordRow => ({
  source: 'drive_dump', sourceRef: `dump:synthetic-${ref}`, version: `synthetic-version-${ref}`, kind: 'rejected',
  rejectedAt: '2026-10-24T12:00:00.000Z', quoteKeys: [], attribution: 'observation', item: `synthetic: rejected thing ${ref}`,
  reason: null, wantedInstead: null, strength: 'rejected', theme: 'edit_av', formats: ['short_video'], ruleKind: 'form',
  capture: 'still', piece: 'synthetic: a piece', media: { stills: [], strips: [], masters: [], texts: 0 }, moment: null, meta: {},
  ...over,
})
const plan = (over: Partial<RecordRow['media']>): RecordRow['media'] => ({ stills: [], strips: [], masters: [], texts: 0, ...over })
const at = (ms: number | null, anchor: 'start' | 'end' | null = null) => ({ ms, anchor, origin: 'record' as const })

interface Call { sql: string; params: unknown[]; write: boolean }

/**
 * A database that answers the media stage's reads from `held` (keyed 'driveId:role' for a folder still or strip,
 * 'driveId@atMs' for a cut), and a Google that serves synthetic bytes. `master` is copied to the path the engine
 * streams a master to; without one, a few synthetic bytes are written there.
 */
function harness(opts: { held?: Record<string, string[]>; byId?: Record<string, DriveFile>; image?: Buffer; master?: string; downloadTo?: (fileId: string, path: string) => Promise<void> } = {}) {
  const calls: Call[] = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
      calls.push({ sql, params, write: Boolean(o?.write) })
      if (/from public\.taste_rejection_media/.test(sql)) {
        const key = Array.isArray(params[1]) ? `${params[0]}@${params[3]}` : `${params[0]}:${params[1]}`
        return (opts.held?.[key] ?? []).map(h => ({ sha256: h, role: 'held' })) as T[]
      }
      if (/set master_drive_id/.test(sql)) return [{ id: '1' }] as T[]
      return [] as T[]
    },
    async close() {},
  }
  const downloads: string[] = []
  const streamed: Array<{ fileId: string; path: string; maxBytes: number }> = []
  const files = { ...Object.fromEntries([ORIGINAL, FINAL].map(f => [f.id, f])), ...opts.byId }
  const google = {
    ...listing().google,
    file: async (fileId: string) => files[fileId] ?? null,
    download: async (fileId: string) => { downloads.push(fileId); return opts.image ?? Buffer.from('synthetic: image bytes') },
    downloadTo: async (fileId: string, path: string, maxBytes: number) => {
      streamed.push({ fileId, path, maxBytes })
      if (opts.downloadTo) await opts.downloadTo(fileId, path)
      else if (opts.master) await copyFile(opts.master, path)
      else await writeFile(path, 'synthetic: master bytes')
      const b = await readFile(path)
      return { bytes: b.length, sha256: sha(b) }
    },
  } as unknown as Google
  const inserts = () => calls.filter(c => /insert into public\.taste_rejection_media/.test(c.sql))
  const attaches = () => calls.filter(c => /set media_sha256/.test(c.sql))
  const points = () => calls.filter(c => /set master_drive_id/.test(c.sql))
  return { db, google, calls, downloads, streamed, inserts, attaches, points }
}

/** A kept file made of synthetic bytes, for a stubbed cut. */
function fake(role: Kept['role'], n: number, atMs: number | null = null): Kept {
  const bytes = Buffer.from(`synthetic: ${role} ${n}`)
  return {
    role, mime: role === 'clip' ? 'video/mp4' : 'image/jpeg', bytes, sha256: sha(bytes), width: 480, height: 854,
    durationMs: role === 'clip' ? 4000 : null, atMs, windowFromMs: 0, windowToMs: 4000, framesN: role === 'strip' ? 6 : null,
  }
}
let made = 0
const stubCut = (seen: number[] = []): NonNullable<KeepDeps['cut']> => async (_path, atMs) => {
  seen.push(atMs)
  made++
  return { clip: fake('clip', made, atMs), strip: fake('strip', made, atMs) }
}

// The Rejections folder as the dump reader lists it, by path inside the folder.
const STILL = drive(id(10), 'synthetic still.png', { mimeType: 'image/png', size: '2000', sha256Checksum: 'ABCDEF0123456789'.repeat(4) })
const HELD_STILL = drive(id(11), 'synthetic held.png', { mimeType: 'image/png', size: '2000' })
const STRIP = drive(id(12), 'synthetic - frames.jpg', { mimeType: 'image/jpeg', size: '2000' })
const COPY = drive(id(13), 'synthetic-copy.mp4', { videoMediaMetadata: { durationMillis: '8000' } })
const FOLDER_FILES = new Map<string, DriveFile>([
  ['assets/synthetic-a/synthetic still.png', STILL],
  ['assets/synthetic-r/synthetic held.png', HELD_STILL],
  ['assets/synthetic-b/synthetic - frames.jpg', STRIP],
  ['assets/synthetic-w/synthetic-copy.mp4', COPY],
])

describe('keepMedia on a dry run', () => {
  it('fetches nothing, writes nothing, and counts the plan it would carry out', async () => {
    const h = harness()
    const records = [
      record('a', { capture: 'still', media: plan({ stills: ['assets/synthetic-a/synthetic still.png', 'assets/synthetic-a/synthetic absent.png'] }) }),
      record('b', { capture: 'moment', moment: at(3500), media: plan({ strips: ['assets/synthetic-b/synthetic - frames.jpg'], masters: [{ where: 'drive_id', ref: ORIGINAL.id }] }) }),
      record('c', { capture: 'moment', moment: null, media: plan({ masters: [{ where: 'local', ref: 'C:\\Users\\synthetic\\master.mp4' }, { where: 'gone', ref: 'synthetic-overwritten.mp4' }] }) }),
      record('d', { capture: 'whole_cut', theme: 'whole_cut', media: plan({ masters: [{ where: 'drive_path', ref: postsPath('synthetic-piece-one', 'renders', 'synthetic-final.mp4') }] }) }),
    ]
    // As the CLI runs a dry run: any write is refused, not quietly made.
    const r = await keepMedia(readOnly(h.db), h.google, records, FOLDER_FILES, false)
    expect(h.downloads).toEqual([])
    expect(h.streamed).toEqual([])
    expect(h.calls.filter(c => /^\s*(insert|update)/i.test(c.sql))).toEqual([])
    expect(r).toEqual({
      stills: 1, strips: 3, clips: 1, reused: 0, missing: 1, unreachableLocal: 1, gone: 1, unresolved: 0, noMoment: 1,
      masters: 2, tooBig: 0, deferred: 0, pointed: 1, failed: 0, failedBefore: 0, unresolvedPaths: 0, rootsUnseen: 0, failures: {},
    })
  })

  it('still resolves master paths, so a dry run proves what a real run would reach', async () => {
    const tree = listing()
    const h = harness()
    const google = { ...(h.google as object), listFolder: tree.google.listFolder } as unknown as Google
    const r = await keepMedia(h.db, google, [
      record('e', { capture: 'whole_cut', media: plan({ masters: [
        { where: 'drive_path', ref: postsPath('synthetic-piece-one', 'synthetic-master.mp4') },
        { where: 'drive_path', ref: postsPath('synthetic-piece-two', 'synthetic-master.mp4') },
        { where: 'drive_path', ref: 'H:\\My Drive\\Somewhere Else\\synthetic-master.mp4' },
        { where: 'folder', ref: 'assets/synthetic-absent/synthetic-copy.mp4' },
        { where: 'drive_id', ref: id(99) },
      ] }) }),
    ], FOLDER_FILES, false)
    expect(tree.listed).toEqual([DRIVE.posts, fid(1), fid(2)])
    // One found; the shared name, the unknown root, the absent copy and the id it cannot see are unresolved.
    expect(r).toMatchObject({ unresolved: 4, pointed: 1, masters: 1, strips: 1 })
    expect(h.streamed).toEqual([])
  })
})

describe('keepMedia on a real run', () => {
  it('counts a master over the cap as too big and never fetches it', async () => {
    const huge = drive(id(20), 'synthetic-huge.mp4', { size: String(MASTER_MAX_BYTES + 1) })
    const h = harness({ byId: { [huge.id]: huge } })
    const r = await keepMedia(h.db, h.google, [record('big', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: huge.id }] }) })],
      FOLDER_FILES, true, { cut: stubCut() })
    expect(r).toMatchObject({ tooBig: 1, masters: 0, clips: 0, failed: 0 })
    expect(h.streamed).toEqual([])
    expect(h.inserts()).toEqual([])
  })

  it('counts a still too large to hold as too big, never as a failure of the run', async () => {
    const h = harness()
    const google = { ...(h.google as object), download: async () => { throw new Error('google download refused: file is over the size cap') } } as unknown as Google
    const r = await keepMedia(h.db, google, [record('huge-still', { capture: 'still', media: plan({ stills: ['assets/synthetic-a/synthetic still.png'] }) })], FOLDER_FILES, true)
    expect(r).toMatchObject({ tooBig: 1, stills: 0, failed: 0, failures: {} })
  })

  it('remembers a cut that cannot be made from a master, and never fetches that master for it again', async () => {
    const dead = drive(id(60), 'synthetic-sound-only.mp4')
    const h = harness({ byId: { [dead.id]: dead } })
    // The record's meta, as the database keeps it between runs.
    let note: unknown = null
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
        if (/jsonb_build_object\('cut_failed'/.test(sql)) { note = JSON.parse(params[3] as string); return [] as T[] }
        if (/meta->'cut_failed'/.test(sql)) return [{ failed: note }] as T[]
        return h.db.query<T>(sql, params, o)
      },
      async close() {},
    }
    const rec = record('dead', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: dead.id }] }) })
    const cut: NonNullable<KeepDeps['cut']> = async () => { throw new Error('media: no picture in the file') }
    const first = await keepMedia(db, h.google, [rec], FOLDER_FILES, true, { cut })
    expect(first).toMatchObject({ masters: 1, failed: 1, failures: { no_picture: 1 }, failedBefore: 0 })
    expect(note).toMatchObject({ master: dead.id, rev: CUT_REV, class: 'no_picture' })
    const second = await keepMedia(db, h.google, [rec], FOLDER_FILES, true, { cut })
    expect(second).toMatchObject({ masters: 0, failed: 0, failedBefore: 1 })
    expect(h.streamed.map(s => s.fileId)).toEqual([dead.id])
    // A failure another try could mend (the download broke) is tried again next run.
    note = null
    const flaky = harness({ byId: { [dead.id]: dead }, downloadTo: async () => { throw new Error('google download failed: HTTP 500') } })
    const once = await keepMedia(db, flaky.google, [rec], FOLDER_FILES, true, { cut })
    expect(once).toMatchObject({ failed: 1, failedBefore: 0 })
    expect(note).toBeNull()
  })

  it('says when a master path is not found because 3 Posts or Archive is not shared with the engine', async () => {
    const h = harness()
    const google = { ...(h.google as object), listFolder: async () => [] } as unknown as Google
    const r = await keepMedia(h.db, google, [record('unshared', { capture: 'whole_cut', media: plan({ masters: [
      { where: 'drive_path', ref: postsPath('synthetic-piece-one', 'synthetic-master.mp4') },
      { where: 'drive_path', ref: 'H:\\My Drive\\Somewhere Else\\synthetic-master.mp4' },
    ] }) })], FOLDER_FILES, true)
    // Only the path under 3 Posts could be found by sharing; neither root is visible to this engine.
    expect(r).toMatchObject({ unresolved: 2, unresolvedPaths: 1, rootsUnseen: 2 })
    const shared = harness({ byId: { [DRIVE.posts]: drive(DRIVE.posts, '3 Posts', { mimeType: FOLDER_MIME }), [DRIVE.archive]: drive(DRIVE.archive, 'Archive', { mimeType: FOLDER_MIME }) } })
    const seen = await keepMedia(shared.db, { ...(shared.google as object), listFolder: async () => [] } as unknown as Google, [record('shared', { capture: 'whole_cut', media: plan({ masters: [
      { where: 'drive_path', ref: postsPath('synthetic-piece-one', 'synthetic-master.mp4') },
    ] }) })], FOLDER_FILES, true)
    expect(seen).toMatchObject({ unresolvedPaths: 1, rootsUnseen: 0 })
  })

  it(`fetches at most ${MASTERS_PER_RUN} masters in one run and defers the rest`, async () => {
    const masters = Array.from({ length: MASTERS_PER_RUN + 2 }, (_, i) => drive(id(30 + i), `synthetic-master-${i}.mp4`))
    const h = harness({ byId: Object.fromEntries(masters.map(m => [m.id, m])) })
    const records = masters.map((m, i) => record(`many-${i}`, { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: m.id }] }) }))
    const r = await keepMedia(h.db, h.google, records, FOLDER_FILES, true, { cut: stubCut() })
    expect(r).toMatchObject({ masters: MASTERS_PER_RUN, deferred: 2, clips: MASTERS_PER_RUN, strips: MASTERS_PER_RUN, failed: 0 })
    expect(h.streamed.map(s => s.fileId)).toEqual(masters.slice(0, MASTERS_PER_RUN).map(m => m.id))
    // Each master was streamed under the cap and let go.
    for (const s of h.streamed) {
      expect(s.maxBytes).toBe(MASTER_MAX_BYTES)
      expect(existsSync(dirname(s.path))).toBe(false)
    }
  })

  it('starts no new master once the time budget is spent', async () => {
    const masters = [drive(id(50), 'synthetic-first.mp4'), drive(id(51), 'synthetic-second.mp4')]
    const h = harness({ byId: Object.fromEntries(masters.map(m => [m.id, m])) })
    let clock = 0
    const cut = stubCut()
    const r = await keepMedia(h.db, h.google, masters.map((m, i) => record(`late-${i}`, { capture: 'moment', moment: at(1000), media: plan({ masters: [{ where: 'drive_id', ref: m.id }] }) })),
      FOLDER_FILES, true, { now: () => clock, cut: async (p, a) => { clock += KEEP_BUDGET_MS + 1; return cut(p, a) } })
    expect(r).toMatchObject({ masters: 1, deferred: 1 })
    expect(h.streamed.map(s => s.fileId)).toEqual([masters[0]!.id])
  })

  it('points a whole cut at its original master, never at a copy in the Rejections folder', async () => {
    const across: string[] = []
    const h = harness()
    const records = [
      // A copy and the original: the original is pointed at, and the strip is taken from it.
      record('w1', { capture: 'whole_cut', theme: 'whole_cut', media: plan({ masters: [
        { where: 'folder', ref: 'assets/synthetic-w/synthetic-copy.mp4' },
        { where: 'drive_path', ref: postsPath('synthetic-piece-one', 'synthetic-master.mp4') },
      ] }) }),
      // Only the copy: nothing is pointed at, though a strip is still taken from what there is.
      record('w2', { capture: 'whole_cut', theme: 'whole_cut', media: plan({ masters: [{ where: 'folder', ref: 'assets/synthetic-w/synthetic-copy.mp4' }] }) }),
      // A path into the Rejections folder is a copy too.
      record('w3', { capture: 'whole_cut', theme: 'whole_cut', media: plan({ masters: [{ where: 'drive_path', ref: `${H}\\Video Engine\\Rejections\\assets\\synthetic-copy.mp4` }] }) }),
    ]
    const r = await keepMedia(h.db, h.google, records, FOLDER_FILES, true, {
      across: async path => { across.push(path); made++; return fake('strip', made) },
    })
    expect(r.pointed).toBe(1)
    expect(h.points()).toHaveLength(1)
    expect(h.points()[0]!.params).toEqual(['drive_dump', 'dump:synthetic-w1', 'synthetic-version-w1', ORIGINAL.id])
    for (const p of h.points()) expect(p.params).not.toContain(COPY.id)
    for (const p of h.points()) expect(p.params).not.toContain(IN_REJECTIONS.id)
    expect(h.streamed.map(s => s.fileId)).toEqual([ORIGINAL.id, COPY.id, IN_REJECTIONS.id])
    expect(across).toEqual(h.streamed.map(s => s.path))
    expect(r).toMatchObject({ strips: 3, masters: 3, failed: 0 })
  })

  it('takes no strip across a whole cut whose strip is already in the folder', async () => {
    const h = harness({ held: { [`${STRIP.id}:strip`]: ['synthetic-held-strip'] } })
    const r = await keepMedia(h.db, h.google, [record('w4', { capture: 'whole_cut', theme: 'whole_cut', media: plan({
      strips: ['assets/synthetic-b/synthetic - frames.jpg'], masters: [{ where: 'drive_id', ref: ORIGINAL.id }] }) })],
    FOLDER_FILES, true, { across: async () => { throw new Error('synthetic: should not be called') } })
    expect(r).toMatchObject({ pointed: 1, reused: 1, masters: 0, failed: 0 })
    expect(h.streamed).toEqual([])
    expect(h.attaches()[0]!.params[3]).toEqual(['synthetic-held-strip'])
  })

  it('lets the master go when the cut fails, and counts the failure by its class', async () => {
    const second = drive(id(60), 'synthetic-second.mp4')
    const h = harness({ byId: { [second.id]: second } })
    const r = await keepMedia(h.db, h.google, [
      record('f1', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: ORIGINAL.id }] }) }),
      record('f2', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: second.id }] }) }),
    ], FOLDER_FILES, true, {
      cut: async path => {
        expect(existsSync(path)).toBe(true)
        throw new Error('media: the clip does not fit the cap')
      },
    })
    expect(r).toMatchObject({ failed: 2, failures: { cap: 2 }, masters: 2, clips: 0 })
    for (const s of h.streamed) expect(existsSync(dirname(s.path))).toBe(false)
    expect(h.inserts()).toEqual([])
    expect(h.attaches()).toEqual([])
  })

  it('counts a master that passes the cap while streaming as too big, and still lets it go', async () => {
    const h = harness({
      downloadTo: async (_id, path) => {
        await writeFile(path, 'synthetic: part of a master')
        throw new Error('google download refused: file is over the size cap')
      },
    })
    const r = await keepMedia(h.db, h.google, [record('f3', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: ORIGINAL.id }] }) })],
      FOLDER_FILES, true, { cut: stubCut() })
    expect(r).toMatchObject({ failed: 1, failures: { too_big: 1 }, masters: 1 })
    expect(existsSync(dirname(h.streamed[0]!.path))).toBe(false)
  })
})

describe.skipIf(!hasFfmpeg)('keepMedia on a real run with ffmpeg', () => {
  it('keeps a still, cuts a moment and lets its master go, and reuses what it already holds', async () => {
    const image = readFileSync(smallPng())
    const masterBytes = readFileSync(master())
    const otherMaster = drive(id(70), 'synthetic-held-master.mp4')
    const h = harness({
      image, master: master(), byId: { [otherMaster.id]: otherMaster },
      held: { [`${HELD_STILL.id}:screenshot`]: ['synthetic-held-still'], [`${otherMaster.id}@3500`]: ['synthetic-held-clip', 'synthetic-held-cut-strip'] },
    })
    const records = [
      record('s', { capture: 'still', media: plan({ stills: ['assets/synthetic-a/synthetic still.png'] }) }),
      record('r', { capture: 'still', media: plan({ stills: ['assets/synthetic-r/synthetic held.png'] }) }),
      // A copy and the original: the cut is made from the original, the master he saw.
      record('m', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'folder', ref: 'assets/synthetic-w/synthetic-copy.mp4' }, { where: 'drive_id', ref: ORIGINAL.id }] }) }),
      record('h', { capture: 'moment', moment: at(3500), media: plan({ masters: [{ where: 'drive_id', ref: otherMaster.id }] }) }),
    ]
    const r = await keepMedia(h.db, h.google, records, FOLDER_FILES, true)
    expect(r).toEqual({
      stills: 1, strips: 1, clips: 1, reused: 2, missing: 0, unreachableLocal: 0, gone: 0, unresolved: 0, noMoment: 0,
      masters: 1, tooBig: 0, deferred: 0, pointed: 0, failed: 0, failedBefore: 0, unresolvedPaths: 0, rootsUnseen: 0, failures: {},
    })

    // Only what was not held was fetched.
    expect(h.downloads).toEqual([STILL.id])
    expect(h.streamed.map(s => s.fileId)).toEqual([ORIGINAL.id])

    // Each insert carries its own bytes under its own hash, the file it came from, and the recipe.
    const ins = h.inserts()
    expect(ins.map(c => c.params[1])).toEqual(['screenshot', 'clip', 'strip'])
    for (const c of ins) {
      expect(c.write).toBe(true)
      expect(sha(Buffer.from(c.params[3] as string, 'base64'))).toBe(c.params[0])
      expect(c.params[13]).toBe(CUT_REV)
    }
    const [still, clip, strip] = ins as [Call, Call, Call]
    expect(still.params.slice(11, 13)).toEqual([STILL.id, STILL.sha256Checksum!.toLowerCase()])
    expect(still.params[2]).toBe('image/jpeg')
    expect(clip.params.slice(2, 3)).toEqual(['video/mp4'])
    expect(clip.params.slice(7, 13)).toEqual([3500, 1500, 5500, null, ORIGINAL.id, sha(masterBytes)])
    expect(strip.params.slice(7, 13)).toEqual([3500, 1500, 5500, 6, ORIGINAL.id, sha(masterBytes)])

    // Each record's hashes are attached to it, held or new.
    const attached = new Map(h.attaches().map(c => [c.params[1], c.params[3]]))
    expect(attached.get('dump:synthetic-s')).toEqual([still.params[0]])
    expect(attached.get('dump:synthetic-r')).toEqual(['synthetic-held-still'])
    expect(attached.get('dump:synthetic-m')).toEqual([clip.params[0], strip.params[0]])
    expect(attached.get('dump:synthetic-h')).toEqual(['synthetic-held-clip', 'synthetic-held-cut-strip'])
    for (const c of h.attaches()) expect(c.write).toBe(true)

    // The master is gone from the runner, and so is the folder it was streamed into.
    const path = h.streamed[0]!.path
    expect(path.startsWith(join(tmpdir(), 'taste-master-'))).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(dirname(path))).toBe(false)
  }, 30_000)

  // Fails until src/rejection/keep.ts measures an end Drive has not: it cuts at 2 s, the opening, instead.
  it('cuts at the end of a master Drive has not measured when he points at its end', async () => {
    // Drive leaves videoMediaMetadata off a video it has not processed. "The last frame" is still the end of the cut,
    // so the moment has to come from the master's own length once it is on disk, not fall back to 2 s in.
    const unmeasured = drive(id(80), 'synthetic-unmeasured.mp4')
    const seen: number[] = []
    const h = harness({ master: master(), byId: { [unmeasured.id]: unmeasured } })
    const length = (await probe(master())).durationMs!
    await keepMedia(h.db, h.google, [record('end', { capture: 'moment', moment: at(null, 'end'), media: plan({ masters: [{ where: 'drive_id', ref: unmeasured.id }] }) })],
      FOLDER_FILES, true, { cut: stubCut(seen) })
    expect(seen).toEqual([length - 2000])
  }, 30_000)
})
