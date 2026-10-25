import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadConfig, DRIVE } from './config.ts'
import { connect, readOnly, type Db } from './db.ts'
import { writeEvidence, normalise, versionOf, withdrawUncollected, type Evidence } from './evidence.ts'
import { collectGitTaste, githubFetcher } from './collect/gitTaste.ts'
import {
  collectIdeaTriage, collectVisibility, collectCreatorMoves, collectDriveArtifacts, collectFeedbackHistory,
} from './collect/supabaseSources.ts'
import { collectDrive, sheetEvidence } from './collect/drive.ts'
import { collectInstagram } from './collect/instagram.ts'
import { connectGoogle, googleConfigured, type Google } from './google.ts'
import { anthropicLlm, type Llm } from './llm.ts'
import { syncItems, tagItems, answeredItemEvidence, type TagResult } from './tag/items.ts'
import { linkRequests } from './tag/links.ts'
import type { DriveFile } from './google.ts'
import { explainPending } from './explain/whys.ts'
import { distil } from './distil/claims.ts'
import { propose, syncDecisions } from './publish/propose.ts'
import { score } from './score/scoreboard.ts'
import { githubApi, syncHarness } from './publish/harness.ts'
import { recordRun, judgeRun, type RunStatus } from './runs.ts'
import { log } from './log.ts'

type Counts = Record<string, number | boolean | string>

interface Ctx {
  db: Db
  dry: boolean
  runId: string
  google: Google | null
  llm: Llm | null
  counts: Counts
  // False until the taste_ledger migration is applied; a dry run then reports
  // what it would write instead of failing on a missing table.
  ledger: boolean
  problems: string[]
  preview: Record<string, unknown>
}

async function countNew(db: Db, rows: Evidence[], ledger: boolean): Promise<number> {
  if (!rows.length) return 0
  if (!ledger) return rows.length
  const keys = rows.map(normalise).map(e => ({ s: e.source, r: e.sourceRef, v: versionOf(e) }))
  const [res] = await db.query<{ n: number }>(
    `select count(*)::int as n from jsonb_to_recordset($1::jsonb) as k(s text, r text, v text)
     where not exists (select 1 from public.taste_evidence e
                       where e.source = k.s and e.source_ref = k.r and e.source_version = k.v)`,
    [JSON.stringify(keys)],
  )
  return Number(res?.n ?? 0)
}

async function collect(ctx: Ctx, cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const groups: Array<[string, () => Promise<Evidence[]>]> = [
    ['git_taste', () => collectGitTaste(githubFetcher(cfg))],
    ['idea_triage', () => collectIdeaTriage(ctx.db)],
    ['visibility', () => collectVisibility(ctx.db)],
    ['creator_moves', () => collectCreatorMoves(ctx.db)],
    ['drive_artifacts', () => collectDriveArtifacts(ctx.db)],
    ['feedback_hist', () => collectFeedbackHistory(ctx.db)],
  ]
  if (ctx.ledger) groups.push(['inspiration_page', () => answeredItemEvidence(ctx.db)])
  if (ctx.google) {
    const g = ctx.google
    groups.push(['drive', () => collectDrive(g)])
    groups.push(['what_i_like_sheet', async () => sheetEvidence(await g.readSheet(DRIVE.whatILikeSheet, 'A1:J500'), new Date().toISOString())])
    groups.push(['instagram', () => collectInstagram(g, new Date().toISOString())])
  }
  let seen = 0
  let written = 0
  for (const [name, fn] of groups) {
    let rows: Evidence[]
    try {
      rows = await fn()
      const res = ctx.dry ? { seen: rows.length, written: await countNew(ctx.db, rows, ctx.ledger) } : await writeEvidence(ctx.db, rows, ctx.runId)
      ctx.counts[`seen_${name}`] = res.seen
      ctx.counts[`new_${name}`] = res.written
      seen += res.seen
      written += res.written
      if (ctx.dry) ctx.preview[name] = rows.slice(0, 5)
      log({ stage: 'collect', source: name, seen: res.seen, written: res.written, dry_run: ctx.dry })
    } catch (err) {
      ctx.problems.push(`collect ${name}: ${(err as Error).message.slice(0, 120)}`)
      log({ stage: 'collect', source: name, status: 'failed', error_class: (err as Error).name })
      continue
    }
    // The page is read whole on every run, so an answer it no longer holds (Undo, or an edit) stops counting as his.
    // Only after its rows were collected and written: a failed read withdraws nothing.
    if (name === 'inspiration_page') {
      try {
        const w = await withdrawUncollected(ctx.db, 'inspiration_page', rows, !ctx.dry)
        ctx.counts.evidence_withdrawn = w.withdrawn
        ctx.counts.evidence_restored = w.restored
        ctx.counts.claims_recounted = w.recounted
        log({ stage: 'withdraw', source: name, evidence_withdrawn: w.withdrawn, evidence_restored: w.restored, claims: w.recounted, dry_run: ctx.dry })
      } catch (err) {
        ctx.problems.push(`withdraw ${name}: ${(err as Error).name}`)
        log({ stage: 'withdraw', source: name, status: 'failed', error_class: (err as Error).name })
      }
    }
    // The Instagram workbook is read whole too. A re-uploaded workbook (a new file id in every post's meta) gives each
    // post a new version, and the old one must stop standing beside it, or the feed's posts are read twice. A read
    // that found no rows withdraws nothing: an empty workbook is a broken read, never "every post is gone".
    if (name === 'instagram' && rows.length) {
      try {
        const w = await withdrawUncollected(ctx.db, 'drive_cold', rows, !ctx.dry)
        ctx.counts.feed_withdrawn = w.withdrawn
        ctx.counts.feed_restored = w.restored
        log({ stage: 'withdraw', source: name, feed_withdrawn: w.withdrawn, feed_restored: w.restored, dry_run: ctx.dry })
      } catch (err) {
        ctx.problems.push(`withdraw ${name}: ${(err as Error).name}`)
        log({ stage: 'withdraw', source: name, status: 'failed', error_class: (err as Error).name })
      }
    }
  }
  ctx.counts.seen = seen
  ctx.counts.written = written
}

/** Link the links he pasted to the cards their media became (src/tag/links.ts). A failure is recorded, never thrown. */
async function link(ctx: Ctx, files: Map<string, DriveFile>): Promise<number> {
  const l = await linkRequests(ctx.db, files, !ctx.dry).catch(err => {
    ctx.problems.push(`link: ${(err as Error).name}`)
    log({ stage: 'link', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!l) return 0
  ctx.counts.requests_linked = l.linked
  ctx.counts.slides_folded = l.slides
  ctx.counts.notes_kept = l.notes
  log({ stage: 'link', requests_linked: l.linked, slides_folded: l.slides, notes_kept: l.notes, dry_run: ctx.dry })
  return l.linked
}

/** Tag the cards that need it. A throw from tagging as a whole (the database, Drive) is recorded, never thrown. */
async function tag(ctx: Ctx, files: Map<string, DriveFile>, limit: number, linked: boolean): Promise<TagResult | null> {
  if (!ctx.google || !ctx.llm) return null
  // The class only: an error's message can quote a row.
  const t = await tagItems(ctx.db, ctx.google, ctx.llm, files, limit, !ctx.dry, linked ? { linked, budgetMs: CARDS_BUDGET_MS } : {}).catch(err => {
    ctx.problems.push(`tagging stopped: ${(err as Error).name}`)
    log({ stage: 'tag', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!t) return null
  ctx.counts.items_tagged = t.tagged
  ctx.counts.items_watched = t.watched
  ctx.counts.items_heard = t.heard
  ctx.counts.items_repaired = t.repaired
  ctx.counts.items_rehead = t.rehead
  ctx.counts.items_too_big = t.tooBig
  ctx.counts.items_gave_up = t.gaveUp
  ctx.counts.items_deferred = t.deferred
  ctx.counts.items_kinded = t.kinded
  ctx.counts.items_feeds = t.feeds
  ctx.counts.items_parts = t.parts
  ctx.counts.items_from_reading = t.fromReading
  ctx.counts.items_tag_failed = t.failed
  if (linked) ctx.counts.waiting_for_reading = t.waitingForReading
  if (t.failed) ctx.problems.push(`tagging failed on ${t.failed} item(s): ${Object.keys(t.failures).join(', ')}`)
  const unheard = Object.values(t.unheard).reduce((a, b) => a + b, 0)
  ctx.counts.items_unheard = unheard
  if (unheard) ctx.problems.push(`no words heard from ${unheard} video(s): ${Object.keys(t.unheard).join(', ')}`)
  return t
}

async function daily(ctx: Ctx, cfg: ReturnType<typeof loadConfig>): Promise<{ status: RunStatus; reason: string | null }> {
  // The page's own answers live in a ledger table too.
  if (!ctx.ledger) ctx.counts.ledger_missing = true
  await collect(ctx, cfg)
  if (!ctx.ledger) return finish(ctx, Number(ctx.counts.seen ?? 0))
  if (ctx.google) {
    const items = await syncItems(ctx.db, ctx.google, !ctx.dry).catch(err => { ctx.problems.push(`items: ${(err as Error).message.slice(0, 120)}`); return null })
    if (items) {
      ctx.counts.items_seen = items.seen
      ctx.counts.items_new = items.written
      // The same linking the cards job does, so no pasted link depends on Control Center's knock.
      await link(ctx, items.files)
      // His evidence is read either way, so the run still explains when tagging stops.
      await tag(ctx, items.files, 60, false)
    }
  }
  if (ctx.llm) {
    const ex = await explainPending(ctx.db, ctx.llm, ctx.runId, { write: !ctx.dry })
    ctx.counts.explain_items = ex.items
    ctx.counts.whys = ex.whys
    ctx.counts.explain_repaired = ex.repaired
    if (ex.failed) ctx.problems.push(`explain failed on ${ex.failed} item(s)`)
    const judged = judgeRun(ex.items, ex.whys)
    if (judged.status === 'failed') ctx.problems.push(judged.reason!)
  }
  const s = await syncDecisions(ctx.db, !ctx.dry)
  ctx.counts.retired = s.retired
  return finish(ctx, Number(ctx.counts.seen ?? 0))
}

async function weekly(ctx: Ctx, now: Date): Promise<{ status: RunStatus; reason: string | null }> {
  if (!ctx.ledger) { ctx.problems.push('taste ledger tables are missing: apply the taste_ledger migration'); return finish(ctx, 0) }
  const s = await syncDecisions(ctx.db, !ctx.dry)
  ctx.counts.retired = s.retired
  if (ctx.llm) {
    const d = await distil(ctx.db, ctx.llm, ctx.runId, !ctx.dry)
    Object.assign(ctx.counts, { distil_whys: d.whys, drafted: d.drafted, resolved: d.resolved, claims: d.written, distil_repaired: d.repaired })
    if (d.failed) ctx.problems.push('distil: the model answer was refused, cut off or unparsed')
  }
  const p = await propose(ctx.db, now, !ctx.dry)
  Object.assign(ctx.counts, { eligible: p.eligible, proposed: p.proposed })
  const sc = await score(ctx.db, now, !ctx.dry)
  Object.assign(ctx.counts, { score_weeks: sc.weeks, metrics: sc.metrics })
  if (ctx.dry) ctx.preview.scoreboard = sc.rows
  return finish(ctx, 1)
}

/** The most cards one cards run tags, and when it stops starting them: the job is cancelled at 15 minutes. */
const CARDS_LIMIT = 10
const CARDS_BUDGET_MS = 8 * 60_000

// The quick job for links he pasted on the Inspiration board: make the cards their media became, link each request to
// its card, and tag the linked cards from content-watcher's reading. No collecting, explaining or watching: a linked
// card with no reading yet is left for the daily job.
async function cards(ctx: Ctx): Promise<{ status: RunStatus; reason: string | null }> {
  if (!ctx.ledger) { ctx.problems.push('taste ledger tables are missing: apply the taste_ledger migration'); return finish(ctx, 0) }
  if (!ctx.google) return finish(ctx, 0)
  const items = await syncItems(ctx.db, ctx.google, !ctx.dry).catch(err => { ctx.problems.push(`items: ${(err as Error).message.slice(0, 120)}`); return null })
  if (!items) return finish(ctx, 0)
  ctx.counts.items_seen = items.seen
  ctx.counts.items_new = items.written
  const linked = await link(ctx, items.files)
  const t = await tag(ctx, items.files, CARDS_LIMIT, true)
  return finish(ctx, linked + (t ? t.tagged + t.failed + t.rehead + t.waitingForReading : 0))
}

// Propose the approved form rules to the ai-harness voice and design skills, by pull request.
async function harness(ctx: Ctx, cfg: ReturnType<typeof loadConfig>): Promise<{ status: RunStatus; reason: string | null }> {
  if (!ctx.ledger) { ctx.problems.push('taste ledger tables are missing: apply the taste_ledger migration'); return finish(ctx, 0) }
  if (!cfg.HARNESS_SYNC_TOKEN) { ctx.problems.push('harness: HARNESS_SYNC_TOKEN not configured'); return finish(ctx, 0) }
  const r = await syncHarness(ctx.db, githubApi(cfg.HARNESS_REPO, cfg.HARNESS_SYNC_TOKEN), !ctx.dry)
  Object.assign(ctx.counts, { approved_rules: r.rules, files_changed: r.changed, files_written: r.written,
    ...(r.pull ? { pull: r.pull } : {}), ...(r.declined ? { declined_pull: r.declined } : {}) })
  return finish(ctx, 1)
}

function finish(ctx: Ctx, input: number): { status: RunStatus; reason: string | null } {
  if (ctx.problems.length) return { status: 'failed', reason: ctx.problems.join('; ').slice(0, 600) }
  if (input === 0) return { status: 'skipped', reason: 'no input' }
  return { status: 'ok', reason: null }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const job = args[0]
  const dry = args.includes('--dry-run')
  // A dry run that costs nothing: collect and count, but call no model.
  const noModel = args.includes('--no-model')
  const trigger = args.includes('--cron') ? 'cron' : 'manual'
  if (job !== 'daily' && job !== 'weekly' && job !== 'harness' && job !== 'cards') {
    console.error('usage: engine daily|weekly|harness|cards [--dry-run] [--no-model] [--cron] [--preview]')
    process.exit(2)
  }
  const cfg = loadConfig()
  const started = new Date()
  const raw = await connect(cfg)
  const db = dry ? readOnly(raw) : raw
  const ctx: Ctx = {
    db, dry, runId: randomUUID(), google: null, llm: null, counts: { dry_run: dry }, ledger: false, problems: [], preview: {},
  }
  const [reg] = await db.query<{ ok: boolean }>(
    `select to_regclass('public.taste_evidence') is not null and to_regclass('public.inspiration_items') is not null as ok`,
  )
  ctx.ledger = Boolean(reg?.ok)
  if (!ctx.ledger && !dry) ctx.problems.push('taste ledger tables are missing: apply the taste_ledger migration')

  // A scheduled run without its credentials is a broken run, not a quiet one.
  // The harness job reads the database and GitHub only: no Google, no model.
  if (job !== 'harness') {
    if (googleConfigured(cfg)) ctx.google = await connectGoogle(cfg)
    else if (!dry) ctx.problems.push('Google service account not configured: Drive and Inspiration cards skipped')
    if (cfg.ANTHROPIC_API_KEY && !noModel) ctx.llm = anthropicLlm(cfg)
    else if (!dry) ctx.problems.push(noModel ? 'run with --no-model: tagging and explaining skipped' : 'ANTHROPIC_API_KEY not configured: tagging and explaining skipped')
  }

  let outcome: { status: RunStatus; reason: string | null }
  try {
    outcome = job === 'daily' ? await daily(ctx, cfg) : job === 'weekly' ? await weekly(ctx, started) : job === 'cards' ? await cards(ctx) : await harness(ctx, cfg)
  } catch (err) {
    outcome = { status: 'failed', reason: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 600) }
  }

  log({ stage: 'run', job: `taste_${job}`, status: outcome.status, dry_run: dry, ...ctx.counts })
  // Which stages had a problem, by their fixed names only; the messages stay out of the public log.
  if (outcome.reason) console.log(JSON.stringify({ reason_class: outcome.status, problems: ctx.problems.length, problem_at: [...new Set(ctx.problems.map(p => /^(collect \w+|withdraw \w+|items|link|tagging|no words heard|explain|distil|harness|taste ledger|Google|ANTHROPIC_API_KEY|run with --no-model)/.exec(p)?.[1] ?? 'other'))] }))
  if (dry && args.includes('--preview')) {
    // Readable, so local only: preview/ is gitignored and never uploaded.
    mkdirSync('preview', { recursive: true })
    writeFileSync(`preview/${job}-${started.toISOString().slice(0, 19).replace(/:/g, '-')}.json`,
      JSON.stringify({ outcome, counts: ctx.counts, problems: ctx.problems, preview: ctx.preview }, null, 2))
  }
  if (!dry) {
    await recordRun(raw, { job: `taste_${job}`, trigger, status: outcome.status, reason: outcome.reason, counts: ctx.counts, startedAt: started })
  }
  await raw.close()
  if (outcome.status === 'failed') process.exitCode = 1
}

// An error escaping main would print its whole object into a public Actions
// log. Print only what kind of failure it was, and fail the job.
await main().catch((err: unknown) => {
  const e = err as { code?: unknown; name?: unknown; errors?: Array<{ code?: unknown }> }
  const code = typeof e?.code === 'string' ? e.code : typeof e?.errors?.[0]?.code === 'string' ? e.errors[0].code : null
  const timedOut = /connection timeout|timed out/i.test(String((err as Error)?.message ?? ''))
  const hint = timedOut || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ENETUNREACH'
    ? 'database unreachable: use the session pooler URL'
    : code === '28P01' ? 'database password rejected: check the password in DATABASE_URL (URL-encode symbols)'
    : null
  log({ stage: 'run', status: 'failed', error_class: typeof e?.name === 'string' ? e.name : 'Error', code, hint })
  process.exitCode = 1
})
