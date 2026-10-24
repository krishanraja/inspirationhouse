import type { Db } from '../db.ts'

// Krish's approved taste rules reach the ai-harness voice and design skills by
// pull request, never by a live read (Ruling, Krish, 2026-10-24: "Rules arrive
// by PR"). The harness's judge panel blocked a live database read because rules
// would change two shared skills without passing the harness's own review. So
// this renders the approved form rules into one file per skill and proposes the
// change as a pull request on ai-harness; nothing reaches a skill until he
// merges it. Each skill reads only its own file, since a packaged skill cannot
// read outside its directory, and the two files hold different lanes, so no
// rule lives in both.

export const HARNESS_FILES: ReadonlyArray<{ path: string; skill: string; lanes: readonly string[] }> = [
  { path: 'skills/krish-voice/references/approved-taste.md', skill: 'krish-voice', lanes: ['voice', 'strategy'] },
  { path: 'skills/krish-design/references/approved-taste.md', skill: 'krish-design', lanes: ['production', 'visibility'] },
]

export const SYNC_BRANCH = 'taste/approved-rules'

export interface ApprovedRule { id: string; lane: string; layer: string | null; statement: string; means: string | null; decided_at: string }

// Form rules only: the view already excludes subject claims (the anti-echo rule).
export const APPROVED_SQL = `
  select id::text, lane, layer, statement, means, decided_at::text
  from public.taste_profile_form
  order by decided_at asc, id asc`

/** The file one skill reads. Deterministic: the same approvals always render the same bytes. */
export function renderApproved(rules: ApprovedRule[], skill: string, lanes: readonly string[]): string {
  const mine = rules.filter(r => lanes.includes(r.lane))
  const last = mine.reduce<string | null>((m, r) => (m === null || r.decided_at > m ? r.decided_at : m), null)
  const head = [
    `# Approved taste rules for ${skill}`,
    '',
    'Krish approved or reworded each of these on the publish board, from what he saved and answered on the Inspiration page',
    '(the taste ledger, `krishanraja/inspirationhouse`). They arrive here only by a pull request he merges.',
    'They are about how a piece is made, never what it is about: apply them to form, never to choose a topic.',
    "The skill's own truth, privacy and safety rules rank above them; when one conflicts, follow the skill and name the conflict.",
    '',
    `Lanes: ${lanes.join(', ')}. Latest approval: ${last ? last.slice(0, 10) : 'none yet'}.`,
    '',
  ]
  if (!mine.length) return [...head, 'No rules approved yet.', ''].join('\n')
  const body = mine.map(r => {
    const layer = r.layer ? ` (${r.layer})` : ''
    const means = r.means?.trim() ? ` So: ${r.means.trim()}` : ''
    return `- [${r.lane}${layer}, approved ${r.decided_at.slice(0, 10)}] ${r.statement.trim()}${means}`
  })
  return [...head, ...body, ''].join('\n')
}

export interface GitHubApi {
  /** The file's text and blob sha on a ref, or null when it does not exist there. */
  readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null>
  /** Point the sync branch at the default branch's head, creating it if needed. */
  resetBranch(branch: string, base: string): Promise<void>
  writeFile(path: string, branch: string, text: string, sha: string | null, message: string): Promise<void>
  /** The number of the open pull request from the branch, or null. */
  openPull(branch: string): Promise<number | null>
  createPull(branch: string, base: string, title: string, body: string): Promise<number>
}

export interface HarnessSyncResult { rules: number; changed: number; pull: number | null }

export async function syncHarness(db: Db, gh: GitHubApi, write: boolean, base = 'main'): Promise<HarnessSyncResult> {
  const rules = await db.query<ApprovedRule>(APPROVED_SQL)
  const wanted = HARNESS_FILES.map(f => ({ ...f, text: renderApproved(rules, f.skill, f.lanes) }))
  const onBase = await Promise.all(wanted.map(f => gh.readFile(f.path, base)))
  const changed = wanted.filter((f, i) => onBase[i]?.text !== f.text)
  if (!changed.length || !write) return { rules: rules.length, changed: changed.length, pull: null }

  let pull = await gh.openPull(SYNC_BRANCH)
  // An open pull request is rebuilt from the default branch each time, so it always shows the whole current set.
  await gh.resetBranch(SYNC_BRANCH, base)
  for (const f of changed) {
    const cur = await gh.readFile(f.path, SYNC_BRANCH)
    await gh.writeFile(f.path, SYNC_BRANCH, f.text, cur?.sha ?? null, `Approved taste rules for ${f.skill}`)
  }
  if (pull === null) {
    pull = await gh.createPull(SYNC_BRANCH, base, 'Approved taste rules for the voice and design skills', [
      'The taste rules Krish approved on the publish board, rendered for the `krish-voice` and `krish-design` skills by the taste ledger (`krishanraja/inspirationhouse`, `engine harness`).',
      '',
      "Nothing reaches a skill until this is merged. This repository is public: each rule's wording, including any rewording in his own words, becomes public on merge.",
    ].join('\n'))
  }
  return { rules: rules.length, changed: changed.length, pull }
}

/** The GitHub REST client, on a token with contents and pull request write on the harness repository only. */
export function githubApi(repo: string, token: string, fetcher: typeof fetch = fetch): GitHubApi {
  const api = `https://api.github.com/repos/${repo}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetcher(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    // The status only: a response body could echo file text into a public log.
    if (!res.ok && res.status !== 404) throw new Error(`harness ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`)
    return res.status === 404 ? null : res.status === 204 ? {} : (await res.json()) as Record<string, any>
  }
  const owner = repo.split('/')[0]
  return {
    async readFile(path, ref) {
      const r = await call('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`)
      if (!r) return null
      return { text: Buffer.from(String(r.content ?? ''), 'base64').toString('utf8'), sha: String(r.sha) }
    },
    async resetBranch(branch, baseRef) {
      const head = await call('GET', `/git/ref/heads/${baseRef}`)
      if (!head) throw new Error(`harness base branch ${baseRef} not found`)
      const sha = head.object.sha
      const existing = await call('GET', `/git/ref/heads/${branch}`)
      if (existing) await call('PATCH', `/git/refs/heads/${branch}`, { sha, force: true })
      else await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha })
    },
    async writeFile(path, branch, text, sha, message) {
      await call('PUT', `/contents/${path}`, { message, branch, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) })
    },
    async openPull(branch) {
      const r = await call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
      const list = (r as unknown as Array<{ number: number }>) ?? []
      return Array.isArray(list) ? list[0]?.number ?? null : null
    },
    async createPull(branch, baseRef, title, body) {
      const r = await call('POST', '/pulls', { head: branch, base: baseRef, title, body })
      return Number(r?.number)
    },
  }
}
