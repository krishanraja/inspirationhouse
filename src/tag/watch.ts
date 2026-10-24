import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Watching a saved video, not judging it from one preview frame (Krish, 2026-10-24: "watching videos when they come
// in"). On the runner: frames spread across the whole clip, and the speech as words. Both feed the tagger and the
// words are kept on the card (inspiration_items.transcript) for every later reader. Each part fails soft: no ffmpeg
// or no speech model means fewer frames or no words, never a failed run.

const run = promisify(execFile)
export const WATCH_FRAMES = 8
const FRAME_WIDTH = 512

export interface Watched { frames: Array<{ bytes: Buffer; mime: 'image/jpeg' }>; transcript: string | null; durationS: number | null }

/** Evenly spaced moments across a clip of `durationS` seconds, skipping the very first and last frame. */
export function frameTimes(durationS: number, n = WATCH_FRAMES): number[] {
  if (!(durationS > 0)) return [0]
  const count = Math.max(1, Math.min(n, Math.floor(durationS)))
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationS / count) * 100) / 100)
}

export async function watchVideo(bytes: Buffer, opts: { transcribe?: boolean } = {}): Promise<Watched> {
  const dir = await mkdtemp(join(tmpdir(), 'taste-watch-'))
  const file = join(dir, 'clip')
  try {
    await writeFile(file, bytes)
    let durationS: number | null = null
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 })
      const d = Number.parseFloat(stdout.trim())
      durationS = Number.isFinite(d) && d > 0 ? Math.round(d * 10) / 10 : null
    } catch { /* no ffprobe: no frames either */ }

    const frames: Watched['frames'] = []
    if (durationS !== null) {
      for (const [i, t] of frameTimes(durationS).entries()) {
        const out = join(dir, `f${i}.jpg`)
        try {
          await run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '5', out], { timeout: 30_000 })
          frames.push({ bytes: await readFile(out), mime: 'image/jpeg' })
        } catch { /* one missed frame is fine */ }
      }
    }

    let transcript: string | null = null
    if (opts.transcribe !== false && durationS !== null) {
      try {
        const { stdout } = await run('python3', [join(process.cwd(), 'scripts', 'transcribe.py'), file], { timeout: 600_000, maxBuffer: 4_000_000 })
        const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}') as { text?: string | null }
        transcript = typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim().slice(0, 20000) : null
      } catch { /* no speech model on this machine */ }
    }
    return { frames, transcript, durationS }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
