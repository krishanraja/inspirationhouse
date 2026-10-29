import { DRIVE, type Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Google } from '../google.ts'
import type { Llm } from '../llm.ts'
import { githubApi, type GitHubApi } from '../publish/harness.ts'
import { judgeRun } from '../runs.ts'
import { FLOOR_VENTURE, type Venture } from '../venture.ts'
import { fileCapture, fileReportDislike, markCollected, reportedDislikes, uncollectedInbox, type InboxRow } from './arrivals.ts'
import { distilFloor, recountStandards } from './distil.ts'
import { fileDrop, readDropZone, type DropFile } from './dropzone.ts'
import { readDump, type Dump } from './dump.ts'
import { fileDump, holdQuote, nearOf, type QuoteRow, type RecordRow } from './file.ts'
import { attachMedia, insertMedia, keepMedia } from './keep.ts'
import { keepStill } from './media.ts'
import { proposeFloor, syncFloorDecisions } from './propose.ts'
import { publishFloor } from './publish.ts'
import { loadFloor, renderFloor, type RenderInput } from './render.ts'
import { capturedWords, fileNear, fileQuotes, fileRecords, rejectionTablesExist, type WholeRead } from './store.ts'

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
  /** For tests whose fixture holds one production: how many productions make a pattern (FLOOR_PATTERN_MIN otherwise). */
  floorPatternMin?: number
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
    // A line of his dump that will not parse is a record never filed: nothing of its kind is withdrawn (dump.whole),
    // and the run says so, since the engine cannot mend his folder.
    const bad = Object.values(dump.bad).reduce((a, n) => a + n, 0)
    if (bad) problems.push(`rejections read: ${bad} line(s) did not parse; nothing of their kind was withdrawn`)
    for (const kind of dump.empty) problems.push(`rejections read: the ${kind} file holds no record; nothing of its kind was withdrawn`)
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
  let reportsRead = false
  let inbox: Array<InboxRow & { venture: Venture }> = []
  const captured: RecordRow[] = []
  try {
    for (const e of await reportedDislikes(d.db)) {
      const f = fileReportDislike(e)
      if (!f) continue
      holdQuote(quotes, f.quote)
      reported.push(f.record)
    }
    counts.rejections_reports = reported.length
    reportsRead = true
  } catch (err) { problem('reports', err) }
  if (tables) {
    try {
      const read = await uncollectedInbox(d.db)
      inbox = read.rows
      for (const row of inbox) {
        const f = fileCapture(row)
        holdQuote(quotes, f.quote)
        captured.push(f.record)
      }
      counts.rejections_inbox = inbox.length
      // A capture with no venture is never filed under a guess, and never quietly left: the run fails until its
      // session's repository is mapped or the capture names its venture.
      counts.rejections_inbox_unassigned = read.unassigned
      if (read.unassigned) problems.push(`rejections inbox: ${read.unassigned} capture(s) held with no venture`)
    } catch (err) { problem('inbox', err) }
  }
  // The drop zone, Rejections/Inbox/ (src/rejection/dropzone.ts): a file is his words only when it is provably his
  // typing; anything else is an observation, kept as context and never counted.
  const dropped: RecordRow[] = []
  const dropFiles = new Map<string, DropFile['file']>()
  try {
    const z = await readDropZone(d.google)
    counts.rejections_drop_files = z.files.length
    counts.rejections_drop_waiting = z.more
    counts.rejections_drop_owner_unseen = z.files.length && !z.owner ? 1 : 0
    let skipped = 0
    for (const f of z.files) {
      dropFiles.set(f.path, f.file)
      counts[`rejections_drop_${f.proof}`] = Number(counts[`rejections_drop_${f.proof}`] ?? 0) + 1
      const x = fileDrop(f)
      if (!x) { skipped++; continue }
      if (x.quote) holdQuote(quotes, x.quote)
      dropped.push(x.record)
    }
    counts.rejections_drop_words = dropped.filter(r => r.attribution === 'krish_words').length
    counts.rejections_drop_observations = dropped.filter(r => r.attribution === 'observation').length
    counts.rejections_drop_empty = skipped
  } catch (err) { problem('drop', err) }
  const input = records.length + reported.length + captured.length + dropped.length

  // 3. Filed: his quotes, then each record, then what he liked nearby.
  let standing = 0
  if (tables && (quotes.size || reportsRead || dropped.length)) {
    try {
      // What a capture filed as his words stays his words, whatever a later read of the same words says.
      for (const q of await capturedWords(d.db, [...quotes.keys()])) holdQuote(quotes, q)
      const q = await fileQuotes(d.db, [...quotes.values()], d.runId, write)
      counts.rejections_quotes = quotes.size
      counts.rejections_quotes_new = q.inserted
      counts.rejections_quotes_reclassed = q.reclassed
      const ids = q.ids
      const sum = { inserted: 0, restored: 0, withdrawn: 0, ventureMismatch: 0 }
      // The folder and the reports are each read whole, so a record no longer in them is withdrawn; the inbox is read
      // once per capture and never withdraws. An empty folder files and withdraws nothing (fileRecords); the reports are
      // a query, so when it succeeds with none, his last report was taken back. Each source is filed on its own, so one
      // the database refuses never keeps the others out.
      const sources: Array<[string, RecordRow[], WholeRead | null, boolean]> = [
        ['dump', records, dump ? { source: 'drive_dump', kinds: dump.whole } : null, false],
        ['reports', reported, reportsRead ? { source: 'session_report', kinds: ['rejected'] } : null, reportsRead],
        ['inbox', captured, null, false],
        ['drop', dropped, null, false],
      ]
      if (dump) counts.rejections_read_whole = dump.whole.length
      for (const [name, rows, whole, emptyIsWhole] of sources) {
        try {
          const r = await fileRecords(d.db, rows, ids, d.runId, { write, whole, emptyIsWhole })
          sum.inserted += r.inserted; sum.restored += r.restored; sum.withdrawn += r.withdrawn; sum.ventureMismatch += r.ventureMismatch
          standing += rows.length
        } catch (err) { problem(`file ${name}`, err) }
      }
      counts.rejections_records_new = sum.inserted
      counts.rejections_records_restored = sum.restored
      counts.rejections_records_withdrawn = sum.withdrawn
      // Stored records of the same identity under another venture than src/venture.ts gives them: the proof the code and
      // the migration's backfill agree. A record keeps its venture, so one is a problem, never mended by a rewrite.
      counts.rejections_venture_mismatch = sum.ventureMismatch
      if (sum.ventureMismatch) problems.push(`rejections venture: ${sum.ventureMismatch} stored record(s) carry another venture than src/venture.ts gives them`)
      // What he liked nearby comes from the liked file, so it is filed only when that file was read whole: a liked file
      // missing or half read would clear it from every record.
      if (filed && dump?.whole.includes('liked')) counts.rejections_near = await fileNear(d.db, nearOf(records, filed.quotes), records, ids, write)
    } catch (err) { problem('file', err) }
  } else {
    counts.rejections_quotes = quotes.size
    counts.rejections_records_new = input
  }

  // 4. What is kept of each asset. A capture's master is reached by its Drive id, so it is cut even on a day the folder
  // could not be read.
  if (records.length || captured.length || dropped.length) {
    try {
      const m = await keepMedia(d.db, d.google, [...records, ...captured, ...dropped], new Map([...dropFiles, ...(dump?.files ?? new Map())]), write)
      for (const [k, v] of Object.entries(m)) if (typeof v === 'number') counts[`rejections_media_${snake(k)}`] = v
      if (m.failed) problems.push(`rejections media: ${m.failed} failed (${Object.keys(m.failures).join(', ')})`)
      if (m.rootsUnseen) problems.push(`rejections media: ${m.unresolvedPaths} master path(s) not found, and ${m.rootsUnseen} of the 3 Posts and Archive folders are not shared with the engine`)
    } catch (err) { problem('media', err) }
  }
  if (write && inbox.length) {
    try {
      let shots = 0
      let refused = 0
      for (const [i, row] of inbox.entries()) {
        if (!row.screenshot_b64) continue
        try {
          const k = await keepStill(Buffer.from(row.screenshot_b64, 'base64'))
          await insertMedia(d.db, k, null, null)
          await attachMedia(d.db, captured[i]!, [k.sha256])
          shots++
        } catch { refused++ }
      }
      counts.rejections_inbox_screenshots = shots
      if (refused) problems.push(`rejections inbox: ${refused} screenshot(s) could not be kept`)
      // A capture is collected only once what it asks for has landed: its record, and its still, its clip or its
      // master's pointer. Until then it is read again on the next run (filing it again changes nothing), so a cut that
      // waited on the budget, or a master not yet shared, is never lost.
      // One whose record stands but whose media has not landed in INBOX_WAIT_DAYS is collected with its words kept and
      // the reason noted, and the run says so: a master never shared must not hold the inbox for good.
      const { done, filedOnly } = await doneCaptures(d.db, captured)
      const cutoff = d.now.getTime() - INBOX_WAIT_DAYS * 86_400_000
      const gaveUp = inbox.filter((r, i) => filedOnly.has(captured[i]!.sourceRef) && new Date(r.reported_at).getTime() < cutoff)
      counts.rejections_inbox_collected = await markCollected(d.db, inbox.filter((_, i) => done.has(captured[i]!.sourceRef)).map(r => r.id), d.runId)
      counts.rejections_inbox_gave_up = await markCollected(d.db, gaveUp.map(r => r.id), d.runId, 'media_never_landed')
      if (gaveUp.length) problems.push(`rejections inbox: ${gaveUp.length} capture(s) kept as words only: their media did not land in ${INBOX_WAIT_DAYS} days`)
      counts.rejections_inbox_waiting = inbox.length - done.size - gaveUp.length
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
          rejections_standards_refused: r.refused, rejections_distil_calls: r.calls,
        })
        for (const [why, n] of Object.entries(r.failures)) counts[`rejections_distil_failed_${snake(why)}`] = n
        if (r.failed) problems.push(`rejections distil: ${r.failed} call(s) unanswered (${Object.keys(r.failures).sort().join(', ')})`)
        if (r.refused) problems.push(`rejections distil: ${r.refused} standard(s) refused by the database`)
        if (!write) preview.standards = r.preview
        const judged = judgeRun(r.skipped ? 0 : r.records, r.resolved)
        if (judged.status === 'failed') problems.push(`rejections distil: ${judged.reason}`)
      } catch (err) { problem('distil', err) }
    }
    try { counts.rejections_recounted = await recountStandards(d.db, write) } catch (err) { problem('recount', err) }
    if (d.propose) {
      try {
        const p = await proposeFloor(d.db, d.now, write, d.floorPatternMin)
        Object.assign(counts, { rejections_eligible: p.eligible, rejections_proposed: p.proposed, rejections_batch_waiting: p.waiting ? 1 : 0 })
      } catch (err) { problem('propose', err) }
    } else {
      try { counts.rejections_eligible = (await proposeFloor(d.db, d.now, false, d.floorPatternMin)).eligible } catch (err) { problem('propose', err) }
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

/** How long a filed capture waits for its still, clip or pointer before it is kept as words only. */
export const INBOX_WAIT_DAYS = 14

/** The captures whose record stands with everything its kind of capture needs (done), and those filed but still waiting. */
async function doneCaptures(db: Db, captured: RecordRow[]): Promise<{ done: Set<string>; filedOnly: Set<string> }> {
  if (!captured.length) return { done: new Set(), filedOnly: new Set() }
  const rows = await db.query<{ source_ref: string; done: boolean }>(
    `select source_ref,
            (capture = 'words'
             or (capture in ('still', 'moment') and cardinality(media_sha256) > 0)
             or (capture = 'whole_cut' and master_drive_id is not null)) as done
     from public.taste_rejections
     where source = 'inbox' and withdrawn_at is null and source_ref = any($1::text[])`,
    [captured.map(r => r.sourceRef)],
  )
  return {
    done: new Set(rows.filter(r => r.done).map(r => r.source_ref)),
    filedOnly: new Set(rows.filter(r => !r.done).map(r => r.source_ref)),
  }
}

/** Before the migration, the dry run's preview still shows the file the floor would be, from what it read. */
function inMemory(records: RecordRow[], quotes: Map<string, QuoteRow>): RenderInput {
  return {
    standards: [],
    records: records.filter(r => r.ruleKind !== 'subject' && r.venture === FLOOR_VENTURE).map(r => ({
      source: r.source, source_ref: r.sourceRef, kind: r.kind, rejected_at: r.rejectedAt, theme: r.theme, formats: r.formats,
      rule_kind: r.ruleKind, capture: r.capture, piece: r.piece, item: r.item, wanted_instead: r.wantedInstead,
      strength: r.strength, quote_ids: r.quoteKeys, near: [], media_sha256: [], pointed: false, moment_ms: r.moment?.ms ?? null,
    })),
    quotes: [...quotes.values()].map(q => ({ id: q.key, text: q.text, attribution: q.attribution, said_at: q.saidAt })),
    media: [],
  }
}
