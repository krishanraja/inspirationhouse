import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// What is kept of a rejected asset (Krish, 2026-10-28): "A screenshot plus your reason: kept as is, roughly 100 KB per
// rejection. A timestamp plus your reason: the engine cuts a 4-second, low-resolution clip and a strip of 6 frames
// around that moment from the master, then lets the master go." All of it on the runner with ffmpeg, never a model
// (Krish, 2026-10-24: "The last thing I want is to burn all my AI Anthropic subscription tokens on watching a video").
// The caps match the database's (content-engine 20261116090000_rejections.sql), which refuses anything larger, so a
// master can never be kept by mistake.

const run = promisify(execFile)

/** The recipe. A better one is a new revision, and the media stage cuts again from what it still reaches. */
export const CUT_REV = 'cut-v1'
export const IMAGE_MAX_BYTES = 400_000
export const CLIP_MAX_BYTES = 1_600_000
export const CLIP_MS = 4000
export const STRIP_FRAMES = 6
const STEP_TIMEOUT_MS = 120_000

export interface Kept {
  role: 'screenshot' | 'strip' | 'clip'
  mime: 'image/jpeg' | 'video/mp4'
  bytes: Buffer
  sha256: string
  width: number
  height: number
  durationMs: number | null
  atMs: number | null
  windowFromMs: number | null
  windowToMs: number | null
  framesN: number | null
}

export interface Probe { width: number; height: number; durationMs: number | null }

export async function probe(path: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path], { timeout: 30_000 })
  const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } }
  const s = j.streams?.[0]
  const d = Number.parseFloat(j.format?.duration ?? '')
  if (!s?.width || !s?.height) throw new Error('media: no picture in the file')
  return { width: s.width, height: s.height, durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'taste-rejection-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

/**
 * A still as kept: a JPEG at most 1280 px wide and 400 KB. A still already under both is re-encoded anyway, so every
 * kept image is one format and none carries the source file's metadata (a phone's location, a desktop's name).
 */
export async function keepStill(bytes: Buffer): Promise<Kept> {
  return withDir(async dir => {
    const src = join(dir, 'src')
    await writeFile(src, bytes)
    for (const [width, q] of [[1280, 4], [1280, 7], [960, 9], [720, 12]] as const) {
      const out = join(dir, `still-${width}-${q}.jpg`)
      await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(q), '-map_metadata', '-1', out], { timeout: STEP_TIMEOUT_MS })
      const kept = await readFile(out)
      if (kept.length <= IMAGE_MAX_BYTES) {
        const p = await probe(out)
        return { role: 'screenshot', mime: 'image/jpeg', bytes: kept, sha256: sha(kept), width: p.width, height: p.height, durationMs: null, atMs: null, windowFromMs: null, windowToMs: null, framesN: null }
      }
    }
    throw new Error('media: the still does not fit the cap at any size')
  })
}

/** An existing six-frame strip (the dump's "frames.jpg"), kept as a strip under the image cap. */
export async function keepStrip(bytes: Buffer): Promise<Kept> {
  const k = await keepStill(bytes)
  return { ...k, role: 'strip', framesN: STRIP_FRAMES }
}

/** The 4 s window around a moment, inside the cut: centred where it can be, held to the start or the end where not. */
export function windowAround(atMs: number, durationMs: number | null): { from: number; to: number } {
  const len = durationMs ?? Number.POSITIVE_INFINITY
  const span = Math.min(CLIP_MS, len)
  let from = Math.max(0, Math.round(atMs - CLIP_MS / 2))
  if (from + span > len) from = Math.max(0, Math.round(len - span))
  return { from, to: Math.round(from + span) }
}

/**
 * A clip and a strip around a moment in a master on local disk: 4 s at 480 px and 15 fps, x264 at CRF 28 with mono
 * AAC (the sound stays, since a chopped word or drifting sync is heard), and six frames across the same window. The
 * caller deletes the master.
 */
export async function cutMoment(master: string, atMs: number): Promise<{ clip: Kept; strip: Kept }> {
  const p = await probe(master)
  const { from, to } = windowAround(atMs, p.durationMs)
  const seconds = ((to - from) / 1000).toFixed(3)
  const start = (from / 1000).toFixed(3)
  return withDir(async dir => {
    let clip: Kept | null = null
    for (const crf of [28, 34, 40]) {
      const out = join(dir, `clip-${crf}.mp4`)
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', start, '-i', master, '-t', seconds,
        '-vf', "scale='min(480,iw)':-2,fps=15", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', '-map_metadata', '-1', out], { timeout: STEP_TIMEOUT_MS })
      const bytes = await readFile(out)
      const c = await probe(out)
      if (bytes.length <= CLIP_MAX_BYTES && c.durationMs !== null && c.durationMs <= CLIP_MS + 500) {
        clip = { role: 'clip', mime: 'video/mp4', bytes, sha256: sha(bytes), width: c.width, height: c.height, durationMs: c.durationMs, atMs, windowFromMs: from, windowToMs: to, framesN: null }
        break
      }
    }
    if (!clip) throw new Error('media: the clip does not fit the cap')
    const strip = await stripOf(dir, master, from, to - from)
    return { clip, strip: { ...strip, atMs } }
  })
}

/** Six frames across a whole cut, for a fault that has no single moment. The master stays where it is, by id. */
export async function stripAcross(master: string): Promise<Kept> {
  const p = await probe(master)
  if (!p.durationMs) throw new Error('media: the master states no length')
  return withDir(dir => stripOf(dir, master, 0, p.durationMs!))
}

async function stripOf(dir: string, master: string, fromMs: number, spanMs: number): Promise<Kept> {
  for (const [width, q] of [[320, 5], [240, 8]] as const) {
    const out = join(dir, `strip-${width}.jpg`)
    // Six evenly spaced moments: the middle of each sixth of the window, each taken by a fast input seek.
    const times = Array.from({ length: STRIP_FRAMES }, (_, i) => (fromMs + ((i + 0.5) * spanMs) / STRIP_FRAMES) / 1000)
    const frames: string[] = []
    for (const [i, t] of times.entries()) {
      const f = join(dir, `f${i}-${width}.jpg`)
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', master, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', String(q), f], { timeout: STEP_TIMEOUT_MS })
      frames.push(f)
    }
    await run('ffmpeg', ['-v', 'error', '-y', ...frames.flatMap(f => ['-i', f]), '-filter_complex', `hstack=inputs=${STRIP_FRAMES}`, '-q:v', String(q), '-map_metadata', '-1', out], { timeout: STEP_TIMEOUT_MS })
    const bytes = await readFile(out)
    if (bytes.length <= IMAGE_MAX_BYTES) {
      const s = await probe(out)
      return { role: 'strip', mime: 'image/jpeg', bytes, sha256: sha(bytes), width: s.width, height: s.height, durationMs: null, atMs: null, windowFromMs: Math.round(fromMs), windowToMs: Math.round(fromMs + spanMs), framesN: STRIP_FRAMES }
    }
  }
  throw new Error('media: the strip does not fit the cap')
}
