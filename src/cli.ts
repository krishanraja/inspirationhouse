import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadConfig, DRIVE } from './config.ts'
import { connect, readOnly, type Db } from './db.ts'
import { writeEvidence, normalise, versionOf, withdrawUncollected, countVentureMismatch, type Evidence } from './evidence.ts'
import { collectGitTaste, githubFetcher } from './collect/gitTaste.ts'
import {
  collectIdeaTriage, collectVisibility, collectCreatorMoves, collectDriveArtifacts, collectFeedbackHistory,
} from './collect/supabaseSources.ts'
import { collectDrive, sheetEvidence } from './collect/drive.ts'
import { collectInstagram } from './collect/instagram.ts'
import { syncCues } from './collect/feedbackCues.ts'
import { syncReports } from './collect/sessionReports.ts'
import { connectGoogle, googleConfigured, type Google } from './google.ts'
import { anthropicLlm, staged, type Llm } from './llm.ts'
import { Meter } from './meter.ts'
import { syncItems, tagItems, answeredItemEvidence, type TagResult } from './tag/items.ts'
import { linkRequests } from './tag/links.ts'
import { machineStillShas, understandCards } from './tag/understand.ts'
import type { DriveFile } from './google.ts'
import { explainPending } from './explain/whys.ts'
import { extractSignals, patternsOf } from './signal/extract.ts'
import { distil } from './distil/claims.ts'
import { propose, syncDecisions } from './publish/propose.ts'
import { score } from './score/scoreboard.ts'
import { githubApi, syncHarness } from './publish/harness.ts'
import { recordRun, judgeRun, type RunStatus } from './runs.ts'
import { runRejections } from './rejection/job.ts'
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
  // Every machine still's sha256 (src/tag/understand.ts): bytes that are never his, so never a card or his action.
  machine: Set<string>
}

// What a real run would write, and how many rows already stored under the same identity carry another venture than
// src/venture.ts gives them now: "0 new rows" proves only that nothing is new, while 0 mismatched proves the code and
// the migration's backfill agree.
async function countNew(db: Db, rows: Evidence[], ledger: boolean): Promise<{ written: number; ventureMismatch: number }> {
  if (!rows.length) return { written: 0, ventureMismatch: 0 }
  if (!ledger) return { written: rows.length, ventureMismatch: 0 }
  const keys = rows.map(normalise).map(e => ({ s: e.source, r: e.sourceRef, v: versionOf(e) }))
  const [res] = await db.query<{ n: number }>(
    `select count(*)::int as n from jsonb_to_recordset($1::jsonb) as k(s text, r text, v text)
     where not exists (select 1 from public.taste_evidence e
                       where e.source = k.s and e.source_ref = k.r and e.source_version = k.v)`,
    [JSON.stringify(keys)],
  )
  return { written: Number(res?.n ?? 0), ventureMismatch: await countVentureMismatch(db, rows) }
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
    groups.push(['drive', () => collectDrive(g, ctx.machine)])
    groups.push(['what_i_like_sheet', async () => sheetEvidence(await g.readSheet(DRIVE.whatILikeSheet, 'A1:J500'), new Date().toISOString())])
    groups.push(['instagram', () => collectInstagram(g, new Date().toISOString())])
  }
  let seen = 0
  let written = 0
  let fullText = 0
  let mismatch = 0
  for (const [name, fn] of groups) {
    let rows: Evidence[]
    try {
      rows = await fn()
      const res = ctx.dry ? { seen: rows.length, ...await countNew(ctx.db, rows, ctx.ledger) } : await writeEvidence(ctx.db, rows, ctx.runId)
      ctx.counts[`seen_${name}`] = res.seen
      ctx.counts[`new_${name}`] = res.written
      seen += res.seen
      written += res.written
      fullText += 'fullText' in res ? res.fullText ?? 0 : 0
      mismatch += res.ventureMismatch ?? 0
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
  ctx.counts.evidence_full_text = fullText
  // A row keeps its venture, so a mismatch is never mended by a rewrite: the code or the backfill is wrong, and the run
  // says so.
  ctx.counts.venture_mismatch = mismatch
  if (mismatch) ctx.problems.push(`collect venture: ${mismatch} stored row(s) carry another venture than src/venture.ts gives them`)
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
  const t = await tagItems(ctx.db, ctx.google, staged(ctx.llm, 'tag'), files, limit, !ctx.dry, linked ? { linked, budgetMs: CARDS_BUDGET_MS } : {}).catch(err => {
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

/** The understanding pass (src/tag/understand.ts): measured production tags and machine stills on each card. No model. */
async function understand(ctx: Ctx, files: Map<string, DriveFile>): Promise<void> {
  const u = await understandCards(ctx.db, files, !ctx.dry).catch(err => {
    ctx.problems.push(`understand: ${(err as Error).name}`)
    log({ stage: 'understand', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!u) return
  Object.assign(ctx.counts, { items_understood_read: u.read, items_understood: u.understood, items_machine_stills: u.stills })
  log({ stage: 'understand', dry_run: ctx.dry, items: u.read, written: u.understood })
}

/**
 * His feedback on ideas and cards, and his presses on the publish board, as cues the Sunday session draws on
 * (src/collect/feedbackCues.ts). The cards are read only when the ledger's tables are there. Until content-engine's
 * feedback_cues migration is applied the stage writes nothing and says so in its counts (cues_table_missing), without
 * failing the run. A failure is recorded, never thrown. A stage that finishes puts cues_board in the run's counts, which
 * is how the next run knows when the board was last read.
 */
async function cues(ctx: Ctx): Promise<void> {
  const r = await syncCues(ctx.db, staged(ctx.llm, 'cues'), { write: !ctx.dry, cards: ctx.ledger }).catch(err => {
    ctx.problems.push(`cues: ${(err as Error).name}`)
    log({ stage: 'cues', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!r) return
  const counts = {
    cues_inputs: r.inputs, cues_open: r.cues, cues_inserted: r.inserted, cues_updated: r.updated, cues_withdrawn: r.withdrawn,
    cues_superseded: r.superseded, cues_guessed: r.guessed, cues_reused: r.reused, cues_skipped: r.skipped,
    cues_unclassified: r.unclassified, cues_failed: r.failed, cues_table_missing: r.missing ? 1 : 0,
    cues_board: r.board, cues_board_wordless: r.boardWordless, cues_offday: r.offday, cues_board_unfiled: r.boardUnfiled,
    cues_board_unfiled_new: r.boardUnfiledNew, cues_board_unread: r.boardUnread, cues_board_missing: r.boardMissing ? 1 : 0,
  }
  Object.assign(ctx.counts, counts)
  if (r.failed) ctx.problems.push(`cues: the model gave no guess for ${r.failed} answer(s)`)
  // His words on a press are never cut to fit or filed under a guess, so a press that cannot be filed is said: while its
  // board is live, and once when it is saved on an older one. After that it is counted (cues_board_unfiled), so one
  // document nobody edits never keeps every later run red and hides what else fails.
  if (r.boardUnfiledNew) ctx.problems.push(`cues: ${r.boardUnfiledNew} press(es) of his on the board not filed (no idea id, or words longer than a cue holds)`)
  log({ stage: 'cues', dry_run: ctx.dry, ...counts })
}

/**
 * What sessions in other repositories reported through Control Center's report_to_taste_engine tool, filed as his
 * words or as an observation (src/collect/sessionReports.ts). Needs the ledger, and content-engine's taste_reports
 * migration: until it is applied the stage reads nothing and counts reports_table_missing. A failure is recorded,
 * never thrown.
 */
async function reports(ctx: Ctx): Promise<void> {
  if (!ctx.ledger) return
  const r = await syncReports(ctx.db, ctx.runId, { write: !ctx.dry }).catch(err => {
    ctx.problems.push(`reports: ${(err as Error).name}`)
    log({ stage: 'reports', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!r) return
  const counts = {
    reports_read: r.read, reports_words: r.words, reports_observations: r.observations, reports_cues: r.cues,
    reports_refused: r.refused, reports_unassigned: r.unassigned, reports_venture_mismatch: r.ventureMismatch,
    reports_evidence_written: r.evidenceWritten, reports_table_missing: r.missing ? 1 : 0,
  }
  Object.assign(ctx.counts, counts)
  // A report held with no venture is never filed under a guess, and never quietly left: the run fails until the session's
  // repository is mapped (taste_venture_repositories) or the report names its venture.
  if (r.unassigned) ctx.problems.push(`reports venture: ${r.unassigned} report(s) held with no venture`)
  if (r.ventureMismatch) ctx.problems.push(`reports venture: ${r.ventureMismatch} filed report(s) whose evidence carries another venture`)
  log({ stage: 'reports', dry_run: ctx.dry, ...counts })
}

async function daily(ctx: Ctx, cfg: ReturnType<typeof loadConfig>): Promise<{ status: RunStatus; reason: string | null }> {
  // The page's own answers live in a ledger table too.
  if (!ctx.ledger) ctx.counts.ledger_missing = true
  await collect(ctx, cfg)
  // After collect, before cues: a report's evidence and cue are written in the same run. The cues stage never reads
  // or retires a session_report cue (it reads only its own sources).
  await reports(ctx)
  await cues(ctx)
  if (!ctx.ledger) return finish(ctx, Number(ctx.counts.seen ?? 0))
  if (ctx.google) {
    const items = await syncItems(ctx.db, ctx.google, !ctx.dry, ctx.machine).catch(err => { ctx.problems.push(`items: ${(err as Error).message.slice(0, 120)}`); return null })
    if (items) {
      ctx.counts.items_seen = items.seen
      ctx.counts.items_new = items.written
      ctx.counts.items_machine_skipped = items.machine
      ctx.counts.items_duplicates = items.duplicates
      // The same linking the cards job does, so no pasted link depends on Control Center's knock.
      await link(ctx, items.files)
      // His evidence is read either way, so the run still explains when tagging stops.
      await tag(ctx, items.files, 60, false)
      await understand(ctx, items.files)
    }
  }
  if (ctx.llm) {
    const ex = await explainPending(ctx.db, staged(ctx.llm, 'explain'), ctx.runId, { write: !ctx.dry })
    ctx.counts.explain_items = ex.items
    ctx.counts.whys = ex.whys
    ctx.counts.explain_repaired = ex.repaired
    if (ex.failed) ctx.problems.push(`explain failed on ${ex.failed} item(s)`)
    const judged = judgeRun(ex.items, ex.whys)
    if (judged.status === 'failed') ctx.problems.push(judged.reason!)
    await signals(ctx, staged(ctx.llm, 'signals'))
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
    const d = await distil(ctx.db, staged(ctx.llm, 'distil'), ctx.runId, !ctx.dry)
    Object.assign(ctx.counts, { distil_whys: d.whys, drafted: d.drafted, resolved: d.resolved, claims: d.written, distil_repaired: d.repaired,
      distil_ventures: d.ventures, distil_ventures_skipped: d.skipped })
    if (d.failed) ctx.problems.push('distil: the model answer was refused, cut off or unparsed')
  }
  const p = await propose(ctx.db, now, !ctx.dry)
  Object.assign(ctx.counts, { eligible: p.eligible, proposed: p.proposed })
  const sc = await score(ctx.db, now, !ctx.dry)
  Object.assign(ctx.counts, { score_weeks: sc.weeks, metrics: sc.metrics })
  if (ctx.dry) ctx.preview.scoreboard = sc.rows
  return finish(ctx, 1)
}

/**
 * Each answer of his as countable taste signals (src/signal/extract.ts). Until content-engine's taste_signals migration
 * is applied, a real run writes nothing and asks no model, and says so in its counts (signals_table_missing); a dry run
 * still reads, so its preview shows what the stage would keep. A failure is recorded, never thrown.
 */
async function signals(ctx: Ctx, llm: Llm): Promise<void> {
  const r = await extractSignals(ctx.db, llm, ctx.runId, { write: !ctx.dry }).catch(err => {
    ctx.problems.push(`signals: ${(err as Error).name}`)
    log({ stage: 'signals', status: 'failed', error_class: (err as Error).name })
    return null
  })
  if (!r) return
  const counts = {
    signals_items: r.items, signals_reread: r.reread, signals_written: r.signals, signals_krish: r.krish,
    signals_action: r.action, signals_guess: r.guess, signals_other: r.other, signals_dropped: r.dropped,
    signals_failed: r.failed, signals_repaired: r.repaired, signals_table_missing: r.missing ? 1 : 0,
  }
  Object.assign(ctx.counts, counts)
  if (r.failed) ctx.problems.push(`signals failed on ${r.failed} item(s)`)
  // Answers read and not one signal kept is a broken stage, never a quiet one.
  const judged = judgeRun(r.items - r.failed, r.signals)
  if (judged.status === 'failed') ctx.problems.push(`signals: ${judged.reason}`)
  if (ctx.dry) ctx.preview.signals = { patterns: patternsOf(r.preview.signals), other_labels: r.preview.otherLabels, signals: r.preview.signals }
  log({ stage: 'signals', dry_run: ctx.dry, ...counts })
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
  const items = await syncItems(ctx.db, ctx.google, !ctx.dry, ctx.machine).catch(err => { ctx.problems.push(`items: ${(err as Error).message.slice(0, 120)}`); return null })
  if (!items) return finish(ctx, 0)
  ctx.counts.items_seen = items.seen
  ctx.counts.items_new = items.written
  const linked = await link(ctx, items.files)
  const t = await tag(ctx, items.files, CARDS_LIMIT, true)
  await understand(ctx, items.files)
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

// The Rejections job (src/rejection/job.ts): the floor beside the ceiling. His Rejections folder, the dislikes sessions
// report and the capture inbox, filed with a frame, strip or clip kept and never a master; the standards drafted and,
// with --propose, put to him; the floor rendered and proposed to content-engine by pull request.
async function rejections(ctx: Ctx, cfg: ReturnType<typeof loadConfig>, now: Date, propose: boolean): Promise<{ status: RunStatus; reason: string | null }> {
  const r = await runRejections({ db: ctx.db, google: ctx.google, llm: staged(ctx.llm, 'rejections'), cfg, runId: ctx.runId, write: !ctx.dry, propose, now })
  Object.assign(ctx.counts, r.counts)
  ctx.problems.push(...r.problems)
  if (ctx.dry) Object.assign(ctx.preview, r.preview)
  log({ stage: 'rejections', dry_run: ctx.dry, ...r.counts })
  return finish(ctx, r.input)
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
  // Put the floor's standards to him (rejections only). Off unless asked: his yes comes before the first batch.
  const proposeFloor = args.includes('--propose')
  if (job !== 'daily' && job !== 'weekly' && job !== 'harness' && job !== 'cards' && job !== 'rejections') {
    console.error('usage: engine daily|weekly|harness|cards|rejections [--dry-run] [--no-model] [--cron] [--preview] [--propose]')
    process.exit(2)
  }
  const cfg = loadConfig()
  const started = new Date()
  const raw = await connect(cfg)
  const db = dry ? readOnly(raw) : raw
  // Every model call of the run, posted to Control Center's usage meter at the end (src/meter.ts).
  const meter = new Meter()
  const ctx: Ctx = {
    db, dry, runId: randomUUID(), google: null, llm: null, counts: { dry_run: dry }, ledger: false, problems: [], preview: {}, machine: new Set(),
  }
  const [reg] = await db.query<{ ok: boolean }>(
    `select to_regclass('public.taste_evidence') is not null and to_regclass('public.inspiration_items') is not null as ok`,
  )
  ctx.ledger = Boolean(reg?.ok)
  // Machine stills are never his, wherever a copy turns up. A read that fails is a problem, and the run goes on: the
  // stills sit outside his tree by design, so this is the second guard, not the first.
  if (job === 'daily' || job === 'cards') {
    try { ctx.machine = await machineStillShas(db) } catch (err) { ctx.problems.push(`items: machine stills unread (${(err as Error).name})`) }
    ctx.counts.machine_stills_known = ctx.machine.size
  }
  // The rejections job has its own tables (src/rejection/store.ts) and needs the ledger only for session reports.
  if (!ctx.ledger && !dry && job !== 'rejections') ctx.problems.push('taste ledger tables are missing: apply the taste_ledger migration')

  // A scheduled run without its credentials is a broken run, not a quiet one.
  // The harness job reads the database and GitHub only: no Google, no model.
  if (job !== 'harness') {
    if (googleConfigured(cfg)) ctx.google = await connectGoogle(cfg)
    else if (!dry) ctx.problems.push('Google service account not configured: Drive and Inspiration cards skipped')
    if (cfg.ANTHROPIC_API_KEY && !noModel) ctx.llm = anthropicLlm(cfg, meter, job)
    else if (!dry) ctx.problems.push(noModel ? 'run with --no-model: tagging and explaining skipped' : 'ANTHROPIC_API_KEY not configured: tagging and explaining skipped')
  }

  let outcome: { status: RunStatus; reason: string | null }
  try {
    outcome = job === 'daily' ? await daily(ctx, cfg) : job === 'weekly' ? await weekly(ctx, started) : job === 'cards' ? await cards(ctx)
      : job === 'rejections' ? await rejections(ctx, cfg, started, proposeFloor) : await harness(ctx, cfg)
  } catch (err) {
    outcome = { status: 'failed', reason: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 600) }
  }

  // What the run's model calls cost, on the meter that holds the chain to $15 a week. A dry run's calls cost the same,
  // so they are counted here too, but only a real run writes. A meter that cannot be written fails the run: a cost
  // that never reaches the figure is the gap this closes.
  const m = meter.totals()
  Object.assign(ctx.counts, { meter_calls: m.calls, meter_failed: m.failed, meter_usd: Math.round(m.usd * 1e4) / 1e4,
    meter_usd_uncached: Math.round(m.usdUncached * 1e4) / 1e4, meter_cache_read_tokens: m.cacheRead, meter_cache_write_tokens: m.cacheWrite })
  if (!dry) {
    try {
      ctx.counts.meter_rows = await meter.flush(raw, started.toISOString().slice(0, 10))
    } catch (err) {
      ctx.counts.meter_rows = 0
      const reason = `meter: ${(err as Error).name}`
      outcome = { status: 'failed', reason: [outcome.reason, reason].filter(Boolean).join('; ').slice(0, 600) }
      ctx.problems.push(reason)
    }
  }

  log({ stage: 'run', job: `taste_${job}`, status: outcome.status, dry_run: dry, ...ctx.counts })
  // Which stages had a problem, by their fixed names only; the messages stay out of the public log.
  if (outcome.reason) console.log(JSON.stringify({ reason_class: outcome.status, problems: ctx.problems.length, problem_at: [...new Set(ctx.problems.map(p => /^(collect \w+|withdraw \w+|reports venture|items|link|understand|cues|tagging|no words heard|explain|signals|distil|harness|rejections \w+|rejections|taste ledger|Google|ANTHROPIC_API_KEY|run with --no-model|meter)/.exec(p)?.[1] ?? 'other'))] }))
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
