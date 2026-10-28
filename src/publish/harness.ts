import type { Db } from '../db.ts'
import { contentHash } from '../hash.ts'
import { byVenture, ventureName, type Venture } from '../venture.ts'

// Krish's approved taste rules reach the ai-harness voice and design skills by
// pull request, never by a live read (Ruling, Krish, 2026-10-24: "Rules arrive
// by PR"). The harness's judge panel blocked a live database read because rules
// would change two shared skills without passing the harness's own review. So
// this renders the approved form rules into one file per skill and proposes the
// change as a pull request on ai-harness; nothing reaches a skill until he
// merges it. Each skill reads only its own file, since a packaged skill cannot
// read outside its directory, and the two files hold different lanes, so no
// rule lives in both.
//
// Each venture's rules are its own (AGENTS.md rule 10): a file holds one
// section per venture, headed by the repositories that venture's taste is for
// (content-engine's taste_venture_repositories), and a session applies only
// its own venture's section. There is no shared section and no fallback to
// another venture's rules.

export const HARNESS_FILES: ReadonlyArray<{ path: string; skill: string; lanes: readonly string[] }> = [
  { path: 'skills/krish-voice/references/approved-taste.md', skill: 'krish-voice', lanes: ['voice', 'strategy'] },
  { path: 'skills/krish-design/references/approved-taste.md', skill: 'krish-design', lanes: ['production', 'visibility'] },
]

export const SYNC_BRANCH = 'taste/approved-rules'

export interface ApprovedRule {
  id: string; lane: string; layer: string | null; statement: string; means: string | null; decided_at: string
  venture: Venture
  /** He reworded it ('corrected'): the statement is his own words, and the engine's means no longer goes with it. */
  reworded: boolean
}

// Form rules only: the view already excludes subject claims (the anti-echo rule). A reword's statement is his
// decision_note (taste_profile_current), and its decision is 'corrected'.
export const APPROVED_SQL = `
  select id::text, lane, layer, statement, means, decided_at::text, (decision = 'corrected') as reworded, venture
  from public.taste_profile_form
  order by decided_at asc, id asc`

/** Which repositories each venture's taste is for: the map the database fills reports from. */
export const REPOSITORIES_SQL = `select repository, venture from public.taste_venture_repositories order by repository`

/** The one rule a session follows to find its section. */
export const VENTURE_RULE = 'Apply only the section for the venture your repository serves; a repository not listed reads none of these.'

/**
 * The file one skill reads: a section per venture with an approved rule in the skill's lanes, Make Your Mind Up first
 * and then by slug, each headed by its name and its repositories. Pure and deterministic: the same approvals and the
 * same map always render the same bytes.
 */
export function renderApproved(rules: ApprovedRule[], skill: string, lanes: readonly string[], repositories: Readonly<Record<Venture, readonly string[]>> = {}): string {
  // In the order APPROVED_SQL reads them, whatever order they arrive in.
  const mine = rules.filter(r => lanes.includes(r.lane))
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.id.localeCompare(b.id))
  const last = mine.reduce<string | null>((m, r) => (m === null || r.decided_at > m ? r.decided_at : m), null)
  const head = [
    `# Approved taste rules for ${skill}`,
    '',
    'Krish approved or reworded each of these himself, from what the taste ledger (`krishanraja/inspirationhouse`) read of',
    'his taste. They arrive here only by a pull request he merges.',
    'They are about how a piece is made, never what it is about: apply them to form, never to choose a topic.',
    "The skill's own truth, privacy and safety rules rank above them; when one conflicts, follow the skill and name the conflict.",
    `Each venture's rules are its own. ${VENTURE_RULE}`,
    '',
    `Lanes: ${lanes.join(', ')}. Latest approval: ${last ? last.slice(0, 10) : 'none yet'}.`,
    '',
  ]
  if (!mine.length) return [...head, 'No rules approved yet.', ''].join('\n')
  const ventures = [...new Set(mine.map(r => r.venture))].sort(byVenture)
  const body = ventures.flatMap(v => {
    const repos = [...(repositories[v] ?? [])].sort()
    return [
      `## ${ventureName(v)}`,
      '',
      `Repositories: ${repos.length ? repos.join(', ') : 'none listed yet'}.`,
      '',
      ...mine.filter(r => r.venture === v).map(r => {
        const layer = r.layer ? ` (${r.layer})` : ''
        // A rule he reworded is his words alone: the engine's own "So:" line was written for the wording he replaced.
        const means = !r.reworded && r.means?.trim() ? ` So: ${r.means.trim()}` : ''
        return `- [${r.lane}${layer}, approved ${r.decided_at.slice(0, 10)}] ${r.statement.trim()}${means}`
      }),
      '',
    ]
  })
  return [...head, ...body].join('\n')
}

export interface GitHubApi {
  /** The file's text and blob sha on a ref, or null when it does not exist there. */
  readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null>
  /** Point the sync branch at the default branch's head, creating it if needed. */
  resetBranch(branch: string, base: string): Promise<void>
  writeFile(path: string, branch: string, text: string, sha: string | null, message: string): Promise<void>
  /** The number of the open pull request from the branch, or null. */
  openPull(branch: string): Promise<number | null>
  /** The pull requests from the branch that are closed, merged or not, newest first. */
  closedPulls(branch: string): Promise<Array<{ number: number; merged: boolean; body: string }>>
  createPull(branch: string, base: string, title: string, body: string): Promise<number>
  updatePull(pull: number, body: string): Promise<void>
}

export interface HarnessSyncResult {
  rules: number
  /** Files that differ from the default branch. */
  changed: number
  /** Files written to the sync branch this run: none when the open pull request already holds them. */
  written: number
  pull: number | null
  /** A pull request he closed without merging that holds this same set, so none is opened again for it. */
  declined: number | null
}

/** The line in a pull request's body that names the exact set of files it proposes. */
export const hashLine = (hash: string): string => `Taste rules hash: ${hash}`

/**
 * ai-harness's closeout check (scripts/closeout/check.mjs) asks every pull request that changes a file to update its
 * NOW.md, or to say why not with this line. The rules files change only by his approval, and NOW.md does not list them.
 */
export const CLOSEOUT_LINE = 'Closeout: not needed, the approved taste rules are rendered from what Krish approved; NOW.md does not list them.'

export function pullBody(hash: string): string {
  return [
    'The taste rules Krish approved, rendered per venture for the `krish-voice` and `krish-design` skills by the taste ledger (`krishanraja/inspirationhouse`, `engine harness`).',
    '',
    "Nothing reaches a skill until this is merged. This repository is public: each rule's wording, including any rewording in his own words, becomes public on merge.",
    '',
    'Closing this without merging declines this set: the same set is never proposed again, and a pull request opens only once the approved rules change.',
    '',
    CLOSEOUT_LINE,
    '',
    hashLine(hash),
  ].join('\n')
}

export async function syncHarness(db: Db, gh: GitHubApi, write: boolean, base = 'main'): Promise<HarnessSyncResult> {
  const rules = await db.query<ApprovedRule>(APPROVED_SQL)
  const repositories: Record<Venture, string[]> = {}
  for (const m of await db.query<{ repository: string; venture: Venture }>(REPOSITORIES_SQL)) {
    (repositories[m.venture] ??= []).push(m.repository)
  }
  const wanted = HARNESS_FILES.map(f => ({ path: f.path, text: renderApproved(rules, f.skill, f.lanes, repositories), message: `Approved taste rules for ${f.skill}` }))
  const r = await syncPull(gh, {
    files: wanted, branch: SYNC_BRANCH, base, write,
    title: 'Approved taste rules for the voice and design skills', body: pullBody,
  })
  return { rules: rules.length, ...r }
}

export interface PullFile { path: string; text: string; message: string }
export interface PullSyncResult { changed: number; written: number; pull: number | null; declined: number | null }

/**
 * Propose a set of rendered files to a repository by one pull request, the way the harness rules arrive (Ruling,
 * Krish, 2026-10-24: "Rules arrive by PR"). Nothing changes on the default branch until he merges. An open pull
 * request already holding the set is left alone, and a set he closed without merging is never proposed again: its
 * hash is in the body. Used for ai-harness's skills and for content-engine's rejection floor (src/rejection/publish.ts).
 */
export async function syncPull(gh: GitHubApi, opts: {
  files: PullFile[]; branch: string; base: string; write: boolean; title: string; body: (hash: string) => string
}): Promise<PullSyncResult> {
  const { files: wanted, branch, base } = opts
  const hash = contentHash(wanted.map(f => ({ path: f.path, text: f.text })))
  const onBase = await Promise.all(wanted.map(f => gh.readFile(f.path, base)))
  const changed = wanted.filter((f, i) => onBase[i]?.text !== f.text)
  const result: PullSyncResult = { changed: changed.length, written: 0, pull: null, declined: null }
  if (!changed.length || !opts.write) return result

  let pull = await gh.openPull(branch)
  if (pull !== null) {
    // The open pull request already holds exactly this set: its files are left alone, so his review is not reset every
    // morning. Only its body is written, so a pull request opened before the body named its set gains the hash line,
    // and closing it declines this set.
    const onBranch = await Promise.all(wanted.map(f => gh.readFile(f.path, branch)))
    if (wanted.every((f, i) => onBranch[i]?.text === f.text)) {
      await gh.updatePull(pull, opts.body(hash))
      return { ...result, pull }
    }
  } else {
    // He closed a pull request with this same set without merging it: he declined it, so it is not opened again.
    const declined = (await gh.closedPulls(branch)).find(p => !p.merged && p.body.includes(hashLine(hash)))
    if (declined) return { ...result, declined: declined.number }
  }

  // A pull request is rebuilt from the default branch each time the set changes, so it always shows the whole set.
  await gh.resetBranch(branch, base)
  for (const f of changed) {
    const cur = await gh.readFile(f.path, branch)
    await gh.writeFile(f.path, branch, f.text, cur?.sha ?? null, f.message)
  }
  if (pull === null) pull = await gh.createPull(branch, base, opts.title, opts.body(hash))
  // The body names the set the pull request now holds, so closing it declines this set and no older one.
  else await gh.updatePull(pull, opts.body(hash))
  return { ...result, written: changed.length, pull }
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
    async closedPulls(branch) {
      const r = await call('GET', `/pulls?state=closed&per_page=100&sort=created&direction=desc&head=${encodeURIComponent(`${owner}:${branch}`)}`)
      const list = r as unknown as Array<{ number: number; merged_at: string | null; body: string | null }> | null
      return Array.isArray(list) ? list.map(p => ({ number: Number(p.number), merged: Boolean(p.merged_at), body: String(p.body ?? '') })) : []
    },
    async createPull(branch, baseRef, title, body) {
      const r = await call('POST', '/pulls', { head: branch, base: baseRef, title, body })
      return Number(r?.number)
    },
    async updatePull(pull, body) {
      await call('PATCH', `/pulls/${pull}`, { body })
    },
  }
}
