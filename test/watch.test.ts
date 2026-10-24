import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameTimes, watchVideo, WATCH_FRAMES } from '../src/tag/watch.ts'

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe('frameTimes', () => {
  it('spreads the frames across the whole clip, never at the very ends', () => {
    expect(frameTimes(80)).toEqual([5, 15, 25, 35, 45, 55, 65, 75])
    expect(frameTimes(3)).toEqual([0.5, 1.5, 2.5])
    expect(frameTimes(0)).toEqual([0])
  })
})

describe.skipIf(!hasFfmpeg)('watchVideo', () => {
  it('pulls frames from across a real clip and reads its length', async () => {
    // A synthetic 10-second test pattern, made here; no real video is committed.
    const dir = mkdtempSync(join(tmpdir(), 'watch-test-'))
    const file = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=10', '-pix_fmt', 'yuv420p', file])
    const w = await watchVideo(readFileSync(file), { transcribe: false })
    expect(w.durationS).toBe(10)
    expect(w.frames.length).toBe(WATCH_FRAMES)
    expect(w.frames[0]!.bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(w.transcript).toBeNull()
  }, 60_000)
})
