import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/taste_backstop.py, the SessionEnd hook (W3.3), run for real on a synthetic transcript: only his flagged lines
// are kept, scrubbed, locally, once, under publication. Synthetic lines only.
const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const script = join(process.cwd(), 'scripts', 'taste_backstop.py')

const rec = (content: unknown, type = 'user', extra: object = {}) => ({ type, message: { role: type, content }, ...extra })
const TRANSCRIPT = [
  rec('Please build the drop-zone reader. No, not that folder, use the inbox instead.'),
  rec([{ type: 'text', text: "That's not on brand. My key is sk-ant-SYNTHETICsynthetic0123456789 by the way." }]),
  rec([{ type: 'tool_result', content: 'No, wrong file, this is tool output' }]),
  rec('<pasted_content id="1">No, never do this, pasted from elsewhere</pasted_content> Looks good.'),
  rec('<system-reminder>Never do X</system-reminder>'),
  rec('Never mention me. Write to synthetic.person@example.com for help.'),
  rec('No, wrong again.', 'assistant'),
  rec("Don't add AI notes.", 'user', { isMeta: true }),
]

describe.skipIf(!hasPython)('taste_backstop.py', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taste-backstop-'))
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, TRANSCRIPT.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n')

  it('a dry run prints only his flagged lines, with a planted secret and an address removed', () => {
    const out = execFileSync('python3', [script, '--dry-run', transcript], { encoding: 'utf8' }).trim().split('\n')
    expect(out).toEqual(['No, not that folder, use the inbox instead.', "That's not on brand.", 'Never mention me.'])
    const all = out.join(' ')
    for (const leak of ['sk-ant', 'example.com', 'tool output', 'pasted from elsewhere', 'Never do X', 'wrong again', 'AI notes']) {
      expect(all).not.toContain(leak)
    }
  })

  it('as the hook it keeps them in the ignored local file, once, under this repository and publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'taste-backstop-root-'))
    // The script writes under its own repository root; run a copy from a scratch root so the real one is untouched.
    const copy = join(root, 'scripts')
    execFileSync('mkdir', ['-p', copy])
    writeFileSync(join(copy, 'taste_backstop.py'), readFileSync(script))
    const hook = JSON.stringify({ transcript_path: transcript, session_id: 'synthetic-session' })
    const run = () => execFileSync('python3', [join(copy, 'taste_backstop.py')], { input: hook, encoding: 'utf8' })
    expect(run()).toContain('3 flagged lines kept locally; nothing sent')
    expect(run()).toContain('0 flagged lines kept locally')
    const file = join(root, '.scratch', 'taste', 'backstop.jsonl')
    expect(existsSync(file)).toBe(true)
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ repository: 'krishanraja/inspirationhouse', venture: 'publication', posted: false })
  })

  it('never fails the end of a session, whatever it is given', () => {
    expect(() => execFileSync('python3', [script], { input: 'not json', encoding: 'utf8' })).not.toThrow()
    expect(() => execFileSync('python3', [script], { input: '{"transcript_path": 3}', encoding: 'utf8' })).not.toThrow()
  })
})
