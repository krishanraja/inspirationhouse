import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { readHeard } from '../src/tag/watch.ts'

// scripts/transcribe.py run for real, with ffprobe, ffmpeg, numpy and the speech model stood in for: the fake ffprobe
// reports two sound tracks, the fake ffmpeg sends each track's own words (and, given no -map, only the first, as the
// real one picks one track), and the fake model reads back what it was given. Synthetic words only.
const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasPython)('transcribe.py', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'taste-transcribe-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}`); chmodSync(join(bin, name), 0o755) }
    script('ffprobe', 'printf "%s\\n" ${FAKE_STREAMS:-1 2}\n')
    script('ffmpeg', [
      'idx=1',
      'while [ $# -gt 0 ]; do if [ "$1" = "-map" ]; then idx="${2#0:}"; fi; shift; done',
      'for f in $FAKE_FAIL; do [ "$f" = "$idx" ] && exit 1; done',
      'for s in $FAKE_SHORT; do [ "$s" = "$idx" ] && printf "x" && exit 0; done',
      'printf "words from track %s" "$idx"',
      'head -c 40000 /dev/zero | tr "\\0" " "',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'py', 'numpy'), { recursive: true })
    writeFileSync(join(dir, 'py', 'numpy', '__init__.py'), [
      'float32 = "float32"',
      'class Samples:',
      '    def __init__(self, data): self.data = data; self.size = len(data) // 4',
      'def frombuffer(data, dtype=None): return Samples(data)',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'py', 'faster_whisper'))
    writeFileSync(join(dir, 'py', 'faster_whisper', '__init__.py'), [
      'class Segment:',
      '    def __init__(self, text): self.text = text',
      'class WhisperModel:',
      '    def __init__(self, *a, **k): pass',
      '    def transcribe(self, audio, vad_filter=True): return [Segment(audio.data.decode().strip())], None',
      '',
    ].join('\n'))
  })

  const hear = (env: Record<string, string> = {}) => readHeard(execFileSync('python3', ['scripts/transcribe.py', join(dir, 'clip')], {
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, PYTHONPATH: join(dir, 'py'), ...env },
  }).toString())

  it('hears every sound track, in order, and joins their words', () => {
    expect(hear()).toEqual({ transcript: 'words from track 1 words from track 2', heard: 'words', unheard: null })
    expect(hear({ FAKE_STREAMS: '2 5' }).transcript).toBe('words from track 2 words from track 5')
  })

  it('keeps the words of the tracks it could hear when one cannot be decoded or is too short', () => {
    expect(hear({ FAKE_FAIL: '1' }).transcript).toBe('words from track 2')
    expect(hear({ FAKE_SHORT: '2' }).transcript).toBe('words from track 1')
  })

  it('says why when no track has words', () => {
    expect(hear({ FAKE_FAIL: '1 2' })).toEqual({ transcript: null, heard: 'failed', unheard: 'decode' })
    expect(hear({ FAKE_SHORT: '1 2' })).toEqual({ transcript: null, heard: 'silent', unheard: null })
    expect(hear({ FAKE_STREAMS: ' ' })).toEqual({ transcript: null, heard: 'silent', unheard: null })
  })
})
