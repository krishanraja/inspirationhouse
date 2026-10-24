import { describe, it, expect } from 'vitest'
import { renderApproved, syncHarness, HARNESS_FILES, SYNC_BRANCH, type ApprovedRule, type GitHubApi } from '../src/publish/harness.ts'
import type { Db } from '../src/db.ts'

// Synthetic rules only. No real taste data is ever committed here.
const rules: ApprovedRule[] = [
  { id: 'a', lane: 'voice', layer: 'opening', statement: 'Open on the concrete thing.', means: 'no preamble', decided_at: '2026-10-25T09:00:00Z' },
  { id: 'b', lane: 'production', layer: null, statement: 'One idea per shot.', means: null, decided_at: '2026-10-26T09:00:00Z' },
  { id: 'c', lane: 'strategy', layer: null, statement: 'Name the trade-off.', means: 'say what it costs', decided_at: '2026-10-27T09:00:00Z' },
]
const db = (rows: ApprovedRule[]): Db => ({ query: async () => rows as never, close: async () => {} }) as unknown as Db

function fakeGitHub(files: Record<string, string>, open: number | null = null) {
  const calls: string[] = []
  const gh: GitHubApi = {
    readFile: async (path, ref) => (ref === 'main' && path in files ? { text: files[path]!, sha: `sha-${path}` } : null),
    resetBranch: async (b) => { calls.push(`reset ${b}`) },
    writeFile: async (path) => { calls.push(`write ${path}`) },
    openPull: async () => open,
    createPull: async () => { calls.push('create'); return 7 },
  }
  return { gh, calls }
}

describe('renderApproved', () => {
  it('gives each skill only its own lanes, so no rule lives in both files', () => {
    const voice = renderApproved(rules, 'krish-voice', ['voice', 'strategy'])
    const design = renderApproved(rules, 'krish-design', ['production', 'visibility'])
    expect(voice).toContain('Open on the concrete thing. So: no preamble')
    expect(voice).toContain('Name the trade-off.')
    expect(voice).not.toContain('One idea per shot.')
    expect(design).toContain('One idea per shot.')
    expect(design).not.toContain('Open on the concrete thing.')
  })
  it('is deterministic and dated by the latest approval, not the run', () => {
    expect(renderApproved(rules, 'krish-voice', ['voice', 'strategy'])).toBe(renderApproved([...rules], 'krish-voice', ['voice', 'strategy']))
    expect(renderApproved(rules, 'krish-voice', ['voice', 'strategy'])).toContain('Latest approval: 2026-10-27')
    expect(renderApproved([], 'krish-voice', ['voice'])).toContain('No rules approved yet.')
  })
})

describe('syncHarness', () => {
  it('does nothing when the harness already holds the rendered files', async () => {
    const files = Object.fromEntries(HARNESS_FILES.map(f => [f.path, renderApproved(rules, f.skill, f.lanes)]))
    const { gh, calls } = fakeGitHub(files)
    expect(await syncHarness(db(rules), gh, true)).toEqual({ rules: 3, changed: 0, pull: null })
    expect(calls).toEqual([])
  })
  it('proposes changed files on the sync branch and opens one pull request', async () => {
    const { gh, calls } = fakeGitHub({})
    const r = await syncHarness(db(rules), gh, true)
    expect(r).toEqual({ rules: 3, changed: 2, pull: 7 })
    expect(calls).toEqual([`reset ${SYNC_BRANCH}`, ...HARNESS_FILES.map(f => `write ${f.path}`), 'create'])
  })
  it('reuses an open pull request and writes nothing on a dry run', async () => {
    const open = fakeGitHub({}, 12)
    expect((await syncHarness(db(rules), open.gh, true)).pull).toBe(12)
    expect(open.calls).not.toContain('create')
    const dry = fakeGitHub({})
    expect(await syncHarness(db(rules), dry.gh, false)).toEqual({ rules: 3, changed: 2, pull: null })
    expect(dry.calls).toEqual([])
  })
})
