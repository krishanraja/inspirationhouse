import { DRIVE, type Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Google } from '../google.ts'
import type { Llm } from '../llm.ts'
import { githubApi, type GitHubApi } from '../publish/harness.ts'
import { judgeRun } from '../runs.ts'
import { fileCapture, fileReportDislike, markCollected, reportedDislikes, uncollectedInbox, type InboxRow } from './arrivals.ts'
import { distilFloor, recountStandards } from './distil.ts'
import { readDump, type Dump } from './dump.ts'
import { fileDump, nearOf, type QuoteRow, type RecordRow } from './file.ts'
import { attachMedia, insertMedia, keepMedia } from './keep.ts'
import { keepStill } from './media.ts'
import { proposeFloor, syncFloorDecisions } from './propose.ts'
import { publishFloor } from './publish.ts'
import { loadFloor, renderFloor, type RenderInput } from './render.ts'
import { fileNear, fileQuotes, fileRecords, rejectionTablesExist } from './store.ts'

// The Rejections job (`pnpm engine rejections`): the floor beside the ceiling. Krish, 2026-10-28: "I want this
// repository to house a separate side engine called Rejections (where all the working rejected production work goes,
// with the reason why I rejected it - acting as the floor, whilst Inspiration acts as the Ceiling)."
//
// It runs on GitHub Actions (taste-rejections.yml), never on a Claude schedule. In order: read his Rejections folder
// whole; file his quotes and each record; file what arrived from sessions (a report of his words, a capture in the
// inbox); keep a frame, a strip or a clip of each, never a master; draft the standards (text only); put them to him;
// render the floor and propose it to content-engine by pull request. Each stage's failure is recorded by class and
// fails the run, and the stages after it still run where they can.

export interface RejectionsDeps {
  db: Db
  google: Google | null
  llm: Llm | null
  cfg: Config
  runId: string
  write: boolean
  propose: boolean
  now: Date
  /** For tests: the GitHub client the floor is proposed through. */
  gh?: GitHubApi | null
}

export interface RejectionsResult {
  counts: Record<string, number | boolean | string>
  problems: string[]
  preview: Record<string, unknown>
  /** Real input read: the records in the folder plus what arrived. Zero is a skip. */
  input: number
}

const CAPTURES = ['still', 'moment', 'whole_cut', 'words'] as const

export async function runRejections(d: RejectionsDeps): Promise<RejectionsResult> {
  const counts: Record<string, number | boolean | string> = {}
  const problems: string[] = []
  const preview: Record<string, unknown> = {}
  const problem = (stage: string, err: unknown) => problems.push(`rejections ${stage}: ${(err as Error)?.name ?? 'Error'}`)

  const tables = await rejectionTablesExist(d.db)
  counts.rejections_table_missing = tables ? 0 : 1
  if (!tables && d.write) problems.push('rejections tables are missing: apply the rejections migration')
  if (!d.google) {
    if (d.write) problems.push('rejections: Google service account not configured')
    return { counts, problems, preview, input: 0 }
  }
  // A real run without the tables writes nothing, and a dry run reads everything it can.
  const write = d.write && tables

  // 1. The folder, read whole.
  let dump: Dump | null = null
  try {
    dump = await readDump(d.google, DRIVE.rejections)
    counts.rejections_read_rejected = dump.rejected.length
    counts.rejections_read_liked = dump.liked.length
    counts.rejections_read_process = dump.process.length
    counts.rejections_ambiguous_paths = dump.ambiguous
    for (const [k, n] of Object.entries(dump.bad)) counts[`rejections_bad_${k}`] = n
  } catch (err) { problem('read', err) }
  const filed = dump ? fileDump(dump) : null
  const records: RecordRow[] = filed ? [...filed.records] : []
  const quotes = new Map<string, QuoteRow>(filed?.quotes ?? [])
  if (filed) {
    counts.rejections_collisions = filed.collisions
    for (const c of CAPTURES) counts[`rejections_capture_${c}`] = filed.records.filter(r => r.kind === 'rejected' && r.capture === c).length
    counts.rejections_format_other = filed.records.filter(r => r.formats.includes('other')).length
    counts.rejections_theme_other = filed.records.filter(r => r.theme === 'other').length
  }

  // 2. What arrived from sessions.
  const reported: RecordRow[] = []
  let inbox: InboxRow[] = []
  const captured: RecordRow[] = []
  try {
    for (const e of await reportedDislikes(d.db)) {
      const f = fileReportDislike(e)
      if (!f) continue
      if (!quotes.has(f.quote.key)) quotes.set(f.quote.key, f.quote)
      reported.push(f.record)
    }
    counts.rejections_reports = reported.length
  } catch (err) { problem('reports', err) }
  if (tables) {
    try {
      inbox = await uncollectedInbox(d.db)
      for (const row of inbox) {
        const f = fileCapture(row)
        if (!quotes.has(f.quote.key)) quotes.set(f.quote.key, f.quote)
        captured.push(f.record)
      }
      counts.rejections_inbox = inbox.length
    } catch (err) { problem('inbox', err) }
  }
  const input = records.length + reported.length + captured.length

  // 3. Filed: his quotes, then each record, then what he liked nearby.
  let standing = 0
  if (tables && quotes.size) {
    try {
      const q = await fileQuotes(d.db, [...quotes.values()], d.runId, write)
      counts.rejections_quotes = quotes.size
      counts.rejections_quotes_new = q.inserted
      counts.rejections_quotes_reclassed = q.reclassed
      const ids = q.ids
      const sum = { inserted: 0, restored: 0, withdrawn: 0 }
      // The folder and the reports are each read whole, so a record no longer in them is withdrawn; the inbox is read
      // once per capture and never withdraws. An empty read files and withdraws nothing (fileRecords).
      const sources: Array<[RecordRow[], 'drive_dump' | 'session_report' | null]> = [[records, 'drive_dump'], [reported, 'session_report'], [captured, null]]
      for (const [rows, whole] of sources) {
        const r = await fileRecords(d.db, rows, ids, d.runId, { write, whole })
        sum.inserted += r.inserted; sum.restored += r.restored; sum.withdrawn += r.withdrawn
      }
      counts.rejections_records_new = sum.inserted
      counts.rejections_records_restored = sum.restored
      counts.rejections_records_withdrawn = sum.withdrawn
      if (filed) counts.rejections_near = await fileNear(d.db, nearOf(records, filed.quotes), records, ids, write)
      standing = records.length + reported.length + captured.length
    } catch (err) { problem('file', err) }
  } else {
    counts.rejections_quotes = quotes.size
    counts.rejections_records_new = input
  }

  // 4. What is kept of each asset.
  if (dump && (records.length || captured.length)) {
    try {
      const m = await keepMedia(d.db, d.google, [...records, ...captured], dump.files, write)
      for (const [k, v] of Object.entries(m)) if (typeof v === 'number') counts[`rejections_media_${snake(k)}`] = v
      if (m.failed) problems.push(`rejections media: ${m.failed} failed (${Object.keys(m.failures).join(', ')})`)
    } catch (err) { problem('media', err) }
  }
  if (write && inbox.length) {
    try {
      let shots = 0
      for (const [i, row] of inbox.entries()) {
        if (!row.screenshot_b64) continue
        const k = await keepStill(Buffer.from(row.screenshot_b64, 'base64'))
        await insertMedia(d.db, k, null, null)
        await attachMedia(d.db, captured[i]!, [k.sha256])
        shots++
      }
      counts.rejections_inbox_screenshots = shots
      counts.rejections_inbox_collected = await markCollected(d.db, inbox.map(r => r.id), d.runId)
    } catch (err) { problem('inbox', err) }
  }

  // 5. The standards (text only), and his decisions on them.
  if (tables) {
    try { counts.rejections_retired = await syncFloorDecisions(d.db, write) } catch (err) { problem('decisions', err) }
    if (d.llm) {
      try {
        const r = await distilFloor(d.db, d.llm, d.runId, write)
        Object.assign(counts, {
          rejections_distil_records: r.records, rejections_distil_groups: r.groups, rejections_drafted: r.drafted,
          rejections_standards: r.resolved, rejections_standards_written: r.written, rejections_superseded: r.superseded,
          rejections_distil_skipped: r.skipped ? 1 : 0, rejections_distil_failed: r.failed, rejections_distil_repaired: r.repaired,
        })
        if (r.failed) problems.push(`rejections distil: ${r.failed} group(s) unanswered`)
        if (!write) preview.standards = r.preview
        const judged = judgeRun(r.skipped ? 0 : r.records, r.resolved)
        if (judged.status === 'failed') problems.push(`rejections distil: ${judged.reason}`)
      } catch (err) { problem('distil', err) }
    }
    try { counts.rejections_recounted = await recountStandards(d.db, write) } catch (err) { problem('recount', err) }
    if (d.propose) {
      try {
        const p = await proposeFloor(d.db, d.now, write)
        Object.assign(counts, { rejections_eligible: p.eligible, rejections_proposed: p.proposed, rejections_batch_waiting: p.waiting ? 1 : 0 })
      } catch (err) { problem('propose', err) }
    } else {
      try { counts.rejections_eligible = (await proposeFloor(d.db, d.now, false)).eligible } catch (err) { problem('propose', err) }
    }
  }

  // 6. The floor, rendered and proposed to content-engine.
  try {
    const input: RenderInput = tables ? await loadFloor(d.db) : inMemory(records, quotes)
    const text = renderFloor(input)
    counts.rejections_floor_bytes = Buffer.byteLength(text)
    if (!d.write) preview.floor = JSON.parse(text)
    const gh = d.gh !== undefined ? d.gh : d.cfg.FLOOR_SYNC_TOKEN ? githubApi(d.cfg.FLOOR_REPO, d.cfg.FLOOR_SYNC_TOKEN) : null
    if (!gh) counts.rejections_floor_token_missing = 1
    else if (tables) {
      const p = await publishFloor(gh, text, write)
      counts.rejections_floor_changed = p.changed
      counts.rejections_floor_written = p.written
      if (p.pull) counts.rejections_floor_pull = p.pull
      if (p.declined) counts.rejections_floor_declined = p.declined
    }
  } catch (err) { problem('render', err) }

  // Records read and not one standing is a broken run, never a quiet one.
  if (tables && write) {
    const judged = judgeRun(input, standing)
    if (judged.status === 'failed') problems.push(`rejections: ${judged.reason}`)
  }
  return { counts, problems, preview, input }
}

const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)

/** Before the migration, the dry run's preview still shows the file the floor would be, from what it read. */
function inMemory(records: RecordRow[], quotes: Map<string, QuoteRow>): RenderInput {
  return {
    standards: [],
    records: records.filter(r => r.ruleKind !== 'subject').map(r => ({
      source: r.source, source_ref: r.sourceRef, kind: r.kind, rejected_at: r.rejectedAt, theme: r.theme, formats: r.formats,
      rule_kind: r.ruleKind, capture: r.capture, piece: r.piece, item: r.item, wanted_instead: r.wantedInstead,
      strength: r.strength, quote_ids: r.quoteKeys, near: [], media_sha256: [], pointed: false, moment_ms: r.moment?.ms ?? null,
    })),
    quotes: [...quotes.values()].map(q => ({ id: q.key, text: q.text, attribution: q.attribution, said_at: q.saidAt })),
    media: [],
  }
}
