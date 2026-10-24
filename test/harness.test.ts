import { describe, it, expect } from 'vitest'
import { renderApproved, syncHarness, githubApi, hashLine, pullBody, HARNESS_FILES, SYNC_BRANCH, APPROVED_SQL, type ApprovedRule, type GitHubApi } from '../src/publish/harness.ts'
import { contentHash } from '../src/hash.ts'
import type { Db } from '../src/db.ts'

// Synthetic rules only. No real taste data is ever committed here.
const rules: ApprovedRule[] = [
  { id: 'a', lane: 'voice', layer: 'opening', statement: 'Open on the concrete thing.', means: 'no preamble', decided_at: '2026-10-25T09:00:00Z', reworded: false },
  { id: 'b', lane: 'production', layer: null, statement: 'One idea per shot.', means: null, decided_at: '2026-10-26T09:00:00Z', reworded: false },
  { id: 'c', lane: 'strategy', layer: null, statement: 'Name the trade-off.', means: 'say what it costs', decided_at: '2026-10-27T09:00:00Z', reworded: false },
]
const db = (rows: ApprovedRule[]): Db => ({ query: async () => rows as never, close: async () => {} }) as unknown as Db
const rendered = (rs: ApprovedRule[]) => Object.fromEntries(HARNESS_FILES.map(f => [f.path, renderApproved(rs, f.skill, f.lanes)]))
const setHash = (rs: ApprovedRule[]) => contentHash(HARNESS_FILES.map(f => ({ path: f.path, text: renderApproved(rs, f.skill, f.lanes) })))

type Closed = Array<{ number: number; merged: boolean; body: string }>
function fakeGitHub(files: Record<string, string>, open: number | null = null, opts: { branch?: Record<string, string>; closed?: Closed } = {}) {
  const calls: string[] = []
  const bodies: string[] = []
  const gh: GitHubApi = {
    readFile: async (path, ref) => {
      const on = ref === 'main' ? files : ref === SYNC_BRANCH ? opts.branch ?? {} : {}
      return path in on ? { text: on[path]!, sha: `sha-${path}` } : null
    },
    resetBranch: async (b) => { calls.push(`reset ${b}`) },
    writeFile: async (path) => { calls.push(`write ${path}`) },
    openPull: async () => open,
    closedPulls: async () => { calls.push('closed'); return opts.closed ?? [] },
    createPull: async (_b, _base, _t, body) => { calls.push('create'); bodies.push(body); return 7 },
    updatePull: async (n, body) => { calls.push(`update ${n}`); bodies.push(body) },
  }
  return { gh, calls, bodies }
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
  it('renders a rule he reworded in his words alone, with no So: line from the engine', () => {
    const reworded = [{ ...rules[0]!, statement: 'Start with the thing itself.', reworded: true }]
    const voice = renderApproved(reworded, 'krish-voice', ['voice'])
    expect(voice).toContain('Start with the thing itself.')
    expect(voice).not.toContain('So:')
    expect(voice).not.toContain('no preamble')
    expect(APPROVED_SQL).toContain(`(decision = 'corrected') as reworded`)
  })
  it('is deterministic and dated by the latest approval, not the run', () => {
    expect(renderApproved(rules, 'krish-voice', ['voice', 'strategy'])).toBe(renderApproved([...rules], 'krish-voice', ['voice', 'strategy']))
    expect(renderApproved(rules, 'krish-voice', ['voice', 'strategy'])).toContain('Latest approval: 2026-10-27')
    expect(renderApproved([], 'krish-voice', ['voice'])).toContain('No rules approved yet.')
  })
})

describe('syncHarness', () => {
  it('does nothing when the harness already holds the rendered files', async () => {
    const { gh, calls } = fakeGitHub(rendered(rules))
    expect(await syncHarness(db(rules), gh, true)).toEqual({ rules: 3, changed: 0, written: 0, pull: null, declined: null })
    expect(calls).toEqual([])
  })
  it('proposes changed files on the sync branch and opens one pull request that names its set', async () => {
    const { gh, calls, bodies } = fakeGitHub({})
    const r = await syncHarness(db(rules), gh, true)
    expect(r).toEqual({ rules: 3, changed: 2, written: 2, pull: 7, declined: null })
    expect(calls).toEqual(['closed', `reset ${SYNC_BRANCH}`, ...HARNESS_FILES.map(f => `write ${f.path}`), 'create'])
    expect(bodies[0]).toContain(hashLine(setHash(rules)))
    expect(bodies[0]).toBe(pullBody(setHash(rules)))
  })
  it('leaves the files of an open pull request alone when its branch already holds them, and names the set in its body', async () => {
    const { gh, calls, bodies } = fakeGitHub({}, 12, { branch: rendered(rules) })
    expect(await syncHarness(db(rules), gh, true)).toEqual({ rules: 3, changed: 2, written: 0, pull: 12, declined: null })
    // No reset and no file written, so his review stands; a body from older code gains the hash line.
    expect(calls).toEqual(['update 12'])
    expect(bodies).toEqual([pullBody(setHash(rules))])
  })
  it('rebuilds an open pull request whose set changed, and names the new set in its body', async () => {
    const older = rules.slice(0, 1)
    const { gh, calls, bodies } = fakeGitHub({}, 12, { branch: rendered(older) })
    expect((await syncHarness(db(rules), gh, true)).pull).toBe(12)
    expect(calls).toEqual([`reset ${SYNC_BRANCH}`, ...HARNESS_FILES.map(f => `write ${f.path}`), 'update 12'])
    expect(bodies).toEqual([pullBody(setHash(rules))])
  })
  it('never opens again a set he closed without merging', async () => {
    const closed: Closed = [{ number: 9, merged: false, body: pullBody(setHash(rules)) }]
    const { gh, calls } = fakeGitHub({}, null, { closed })
    expect(await syncHarness(db(rules), gh, true)).toEqual({ rules: 3, changed: 2, written: 0, pull: null, declined: 9 })
    expect(calls).toEqual(['closed'])
  })
  it('opens a pull request for a set he has not declined: a changed set, or one only merged before', async () => {
    const otherSet = fakeGitHub({}, null, { closed: [{ number: 9, merged: false, body: pullBody(setHash(rules.slice(1))) }] })
    expect((await syncHarness(db(rules), otherSet.gh, true)).pull).toBe(7)
    const merged = fakeGitHub({}, null, { closed: [{ number: 8, merged: true, body: pullBody(setHash(rules)) }] })
    expect((await syncHarness(db(rules), merged.gh, true)).pull).toBe(7)
  })
  it('writes nothing on a dry run', async () => {
    const dry = fakeGitHub({})
    expect(await syncHarness(db(rules), dry.gh, false)).toEqual({ rules: 3, changed: 2, written: 0, pull: null, declined: null })
    expect(dry.calls).toEqual([])
  })
})

describe('githubApi', () => {
  it('reads closed pull requests with whether each was merged, and updates a body', async () => {
    const seen: Array<{ method: string; url: string; body?: string }> = []
    const fetcher = (async (url: string, init: { method: string; body?: string }) => {
      seen.push({ method: init.method, url, body: init.body })
      if (init.method === 'GET') {
        return new Response(JSON.stringify([
          { number: 3, merged_at: null, body: 'a body' },
          { number: 2, merged_at: '2026-10-20T00:00:00Z', body: null },
        ]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const gh = githubApi('owner/repo', 'token', fetcher)
    expect(await gh.closedPulls(SYNC_BRANCH)).toEqual([{ number: 3, merged: false, body: 'a body' }, { number: 2, merged: true, body: '' }])
    expect(seen[0]!.url).toContain('state=closed')
    expect(seen[0]!.url).toContain(encodeURIComponent(`owner:${SYNC_BRANCH}`))
    await gh.updatePull(3, 'new body')
    expect(seen[1]).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/owner/repo/pulls/3', body: JSON.stringify({ body: 'new body' }) })
  })
})
