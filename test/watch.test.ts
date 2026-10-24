import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameTimes, readHeard, watchVideo, WATCH_FRAMES } from '../src/tag/watch.ts'

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe('frameTimes', () => {
  it('spreads the frames across the whole clip, never at the very ends', () => {
    expect(frameTimes(80)).toEqual([5, 15, 25, 35, 45, 55, 65, 75])
    expect(frameTimes(3)).toEqual([0.5, 1.5, 2.5])
    expect(frameTimes(0)).toEqual([0])
  })
})

describe('readHeard', () => {
  it('takes words only from the last line, and tells silence from a failure', () => {
    expect(readHeard('loading\n{"text": " ask not ", "heard": "words", "failure": null}\n')).toEqual({ transcript: 'ask not', heard: 'words', unheard: null })
    expect(readHeard('{"text": null, "heard": "silent", "failure": null}')).toEqual({ transcript: null, heard: 'silent', unheard: null })
    expect(readHeard('{"text": null, "heard": "failed", "failure": "decode"}')).toEqual({ transcript: null, heard: 'failed', unheard: 'decode' })
  })
  it('never reads an old or broken answer as silence', () => {
    // The transcriber before 2026-10-24 printed {"text": null} for every failure, which is how a day of videos went wordless.
    expect(readHeard('{"text": null}')).toEqual({ transcript: null, heard: 'failed', unheard: 'runner' })
    expect(readHeard('Traceback (most recent call last):')).toEqual({ transcript: null, heard: 'failed', unheard: 'runner' })
    expect(readHeard('')).toEqual({ transcript: null, heard: 'failed', unheard: 'runner' })
    expect(readHeard('{"text": null, "heard": "failed", "failure": "a message, not a class"}').unheard).toBe('runner')
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
    expect(w.heard).toBe('skipped')
  }, 60_000)
})
