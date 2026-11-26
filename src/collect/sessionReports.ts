import type { Db } from '../db.ts'
import { writeEvidence, type Evidence, type Lane, type Polarity } from '../evidence.ts'
import { ventureOf, type Venture } from '../venture.ts'
import { classify, type Reading } from './feedbackCues.ts'
import { classOfReport, incidentRefOf, REPORT_SORT_REV, type ReportClass } from './reportSort.ts'

/**
 * What a session in any repository reported to the taste engine (content-engine's taste_reports, written only by
 * Control Center's report_to_taste_engine tool), filed where the fact already lives. This is the procedure; the tool
 * and the table hold only what the session said.
 *
 * Two kinds, never mixed (Ruling, Krish, 2026-10-24: "exact typed quotes count as my opinions on what I think you
 * should do with that content"):
 * - krish_words: his exact words, with where and when he typed them. Filed as krish_words evidence, so they can count
 *   toward a claim like anything else he said. A report of his words without where or when is refused (the database
 *   refuses it too) and never filed as his.
 * - observation: everything else a session reports (a paraphrase, a summary, what it noticed, how a piece did). Filed
 *   as observation evidence: context the explainer can read, never counted toward a claim (AGENTS.md rule 4).
 *
 * When his words name what to do with an idea or a card ("keep an eye on this", "for a bigger piece on chips"), the
 * report also becomes a feedback cue, by the cues stage's own word rules only (use_origin 'krish'). No model is asked
 * here, and a verdict or route is never inferred for a report.
 *
 * Only taste stays (Krish, 2026-11-26: "Anything that isn't a matter of taste or creative preference should go to the
 * internal auditor"). Each report is sorted by fixed rules (./reportSort.ts): a report about how a session, engine or
 * pipeline behaved is `not_taste` and never becomes taste evidence; one that names both a problem and a judgement is
 * `mixed` and is kept whole. Either way his words are also filed as an engine incident (content-engine's
 * engine_incidents), which the internal auditor reads through Control Center's engine_failures feed. A report filed
 * before this sort is sorted again by `sortFiledReports`, so what reached the ledger earlier leaves it the same way.
 *
 * Each report is filed once: the engine stamps collected_at and what it became, and a report is never edited.
 *
 * A report is its venture's (content-engine 20261117090000_taste_ventures.sql): its repository's, from
 * taste_venture_repositories, or the one its session named from a repository that serves several. Everything it
 * becomes carries that venture. A report with none (an unmapped repository whose session named no venture) is held:
 * never filed, never stamped, and counted as unassigned, which fails the run until it has one.
 */

export interface ReportRow {
  id: string
  kind: 'krish_words' | 'observation'
  body: string
  said_where: string | null
  said_at: string | null
  lane: Lane
  polarity: Polarity
  subject_ref: string | null
  subject: string | null
  session_ref: string
  repository: string
  surface: string
  reported_at: string
  /** taste_reports.venture: null is a report held unassigned. */
  venture: Venture | null
}

export interface CueInsert {
  source: 'session_report'
  source_ref: string
  subject_ref: string
  subject: string
  said: string
  said_at: string
  use: string
  theme: string | null
  use_origin: 'krish'
  status: 'open'
  meta: Record<string, unknown>
  venture: Venture
}

export interface IncidentInsert {
  client_ref: string
  at: string
  stage: 'session'
  his_words: string
  session_ref: string
  meta: Record<string, unknown>
}

export interface Filed {
  id: string
  /** Where the report belongs; null for a refused report. */
  sorted: ReportClass | null
  /** His words left for the internal auditor: a not_taste or mixed report of his words. */
  incident: IncidentInsert | null
  evidence: Evidence | null
  cue: CueInsert | null
  /** Why a report was not filed as anything: only a report of his words that does not say where or when. */
  refused: string | null
}

export const sourceRefOf = (id: string): string => `report:${id}`

/** The id a cue is about: the idea or card id after its prefix. A piece is a made thing, never a cue's subject. */
function cueSubject(ref: string | null): { kind: 'idea' | 'card'; id: string } | null {
  const m = /^(idea|card):(.+)$/.exec(ref ?? '')
  return m ? { kind: m[1] as 'idea' | 'card', id: m[2]! } : null
}

/** What one report with a venture becomes. Pure: the same report always files the same way. */
export function fileReport(r: ReportRow & { venture: Venture }): Filed {
  const words = r.kind === 'krish_words'
  if (words && (!r.said_where?.trim() || !r.said_at)) {
    return { id: r.id, sorted: null, incident: null, evidence: null, cue: null, refused: 'words_without_where_or_when' }
  }
  const sorted = classOfReport(r.body)
  const incident = incidentOf(r, sorted)
  if (sorted === 'not_taste') return { id: r.id, sorted, incident, evidence: null, cue: null, refused: null }
  const meta: Record<string, unknown> = {
    report_id: r.id, session_ref: r.session_ref, repository: r.repository, surface: r.surface, reported_at: r.reported_at,
  }
  if (words) meta.said_where = r.said_where
  if (r.subject_ref) meta.subject_ref = r.subject_ref
  const evidence: Evidence = {
    source: 'session_report',
    sourceRef: sourceRefOf(r.id),
    // His words date from when he typed them; an observation from when it was reported.
    occurredAt: new Date(words ? r.said_at! : r.reported_at).toISOString(),
    attribution: words ? 'krish_words' : 'observation',
    polarity: r.polarity,
    lane: r.lane,
    layer: null,
    title: r.subject,
    excerpt: r.body,
    meta,
    venture: ventureOf('session_report', { report: r.venture })!,
  }
  let cue: CueInsert | null = null
  const subject = cueSubject(r.subject_ref)
  if (words && subject && r.subject) {
    const reading = classify({
      source: subject.kind === 'card' ? 'inspiration_card' : 'idea_queue',
      subjectRef: subject.id, subject: r.subject, said: r.body, saidAt: r.said_at!,
      verdict: null, field: 'report', routes: [],
    })
    // Only a use his own words name. A rule that reads a verdict or route never fires here (a report has neither).
    if (reading && reading !== 'skip' && (reading as Reading).origin === 'krish') {
      cue = {
        source: 'session_report', source_ref: sourceRefOf(r.id), subject_ref: subject.id, subject: r.subject,
        said: r.body, said_at: new Date(r.said_at!).toISOString(), use: reading.use, theme: reading.theme,
        use_origin: 'krish', status: 'open',
        meta: { rule: reading.rule, report_id: r.id, session_ref: r.session_ref, repository: r.repository, said_where: r.said_where },
        venture: evidence.venture,
      }
    }
  }
  return { id: r.id, sorted, incident, evidence, cue, refused: null }
}

/** The incident a report of his words leaves for the auditor, or null when it is taste or not his words. Pure. */
export function incidentOf(r: ReportRow, sorted: ReportClass): IncidentInsert | null {
  if (sorted === 'taste' || r.kind !== 'krish_words' || !r.said_at) return null
  return {
    client_ref: incidentRefOf(r.id),
    at: new Date(r.said_at).toISOString(),
    stage: 'session',
    his_words: r.body,
    session_ref: r.session_ref.slice(0, 300),
    meta: {
      moved_from: 'taste_reports', report_id: r.id, class: sorted, rev: REPORT_SORT_REV, repository: r.repository,
      lane: r.lane, polarity: r.polarity, venture: r.venture,
    },
  }
}

const INSERT_INCIDENTS = `insert into public.engine_incidents (client_ref, at, stage, maker, kind, his_words, session_ref, meta)
  select client_ref, at, stage, 'unknown', 'krish_reject', his_words, session_ref, meta
  from jsonb_to_recordset($1::jsonb) as x(client_ref text, at timestamptz, stage text, his_words text, session_ref text, meta jsonb)
  on conflict (client_ref) do nothing returning id::text`

/** Files incidents for the auditor. Without content-engine's engine_incidents it fails, so a report that is not taste
 *  is never stamped filed with nowhere to go. */
async function fileIncidents(db: Db, rows: IncidentInsert[]): Promise<number> {
  if (!rows.length) return 0
  const [reg] = await db.query<{ ok: boolean }>(`select to_regclass('public.engine_incidents') is not null as ok`)
  if (!reg?.ok) throw new Error('engine_incidents is missing: reports that are not taste have nowhere to go')
  return (await db.query(INSERT_INCIDENTS, [JSON.stringify(rows)], { write: true })).length
}

export interface ReportResult {
  read: number
  words: number
  observations: number
  cues: number
  refused: number
  /** Reports held with no venture: not filed, and a run problem until each has one. */
  unassigned: number
  /** Filed reports whose evidence carries another venture than the report: 0 unless the backfill and the code disagree. */
  ventureMismatch: number
  evidenceWritten: number
  /** Reports sorted out of taste (never filed as evidence) and reports kept whole but also left for the auditor. */
  notTaste: number
  mixed: number
  incidentsFiled: number
  /** content-engine's taste_reports migration is not applied yet: nothing is read or written. */
  missing: boolean
}

const BATCH = 500

/** The daily `reports` stage: file every report not yet filed. With write false it reports what it would do. */
export async function syncReports(db: Db, runId: string, opts: { write: boolean }): Promise<ReportResult> {
  const result: ReportResult = {
    read: 0, words: 0, observations: 0, cues: 0, refused: 0, unassigned: 0, ventureMismatch: 0, evidenceWritten: 0,
    notTaste: 0, mixed: 0, incidentsFiled: 0, missing: false,
  }
  const [reg] = await db.query<{ ok: boolean }>(`select to_regclass('public.taste_reports') is not null as ok`)
  if (!reg?.ok) return { ...result, missing: true }
  // Held reports are counted, never read into the batch, so they can never keep a filed one waiting.
  const [held] = await db.query<{ n: number; mismatch: number }>(
    `select (select count(*)::int from public.taste_reports where collected_at is null and venture is null) as n,
            (select count(*)::int from public.taste_evidence e join public.taste_reports r on e.source_ref = 'report:' || r.id::text
             where e.source = 'session_report' and e.venture is distinct from r.venture) as mismatch`,
  )
  result.unassigned = Number(held?.n ?? 0)
  result.ventureMismatch = Number(held?.mismatch ?? 0)
  const rows = await db.query<ReportRow & { venture: Venture }>(
    `select id::text, kind, body, said_where, said_at::text, lane, polarity, subject_ref, subject, session_ref,
            repository, surface, reported_at::text, venture
     from public.taste_reports where collected_at is null and venture is not null order by reported_at, id limit ${BATCH}`,
  )
  const filed = rows.map(fileReport)
  result.read = rows.length
  for (const f of filed) {
    if (f.refused) result.refused++
    else if (f.sorted === 'not_taste') result.notTaste++
    else if (f.evidence?.attribution === 'krish_words') result.words++
    else result.observations++
    if (f.cue) result.cues++
    if (f.sorted === 'mixed') result.mixed++
  }
  if (!opts.write || !rows.length) return result

  // The incident first: a report that leaves taste is stamped only once the auditor's copy is on file.
  const incidents = filed.flatMap(f => f.incident ? [f.incident] : [])
  result.incidentsFiled = await fileIncidents(db, incidents)
  const evidence = filed.flatMap(f => f.evidence ? [f.evidence] : [])
  result.evidenceWritten = (await writeEvidence(db, evidence, runId)).written
  const cues = filed.flatMap(f => f.cue ? [f.cue] : [])
  if (cues.length) {
    await db.query(
      `insert into public.feedback_cues (source, source_ref, subject_ref, subject, said, said_at, use, theme, use_origin, status, meta, venture)
       select source, source_ref, subject_ref, subject, said, said_at, use, theme, use_origin, status, meta, venture
       from jsonb_to_recordset($1::jsonb) as x(source text, source_ref text, subject_ref text, subject text, said text,
         said_at timestamptz, use text, theme text, use_origin text, status text, meta jsonb, venture text)
       on conflict (source, source_ref, subject_ref) do nothing`,
      [JSON.stringify(cues)], { write: true },
    )
  }
  // Stamped only after its evidence and cue are written, so a failed write leaves the report to the next run.
  const sortMeta = (f: Filed) => f.sorted ? { sorted: f.sorted, sort_rev: REPORT_SORT_REV, incident_ref: f.incident?.client_ref ?? null } : {}
  const stamps = filed.map(f => ({
    id: f.id,
    meta: f.refused ? { filed_as: 'refused', reason: f.refused }
      : !f.evidence ? { filed_as: 'not_taste', ...sortMeta(f) }
      : { filed_as: f.evidence.attribution, evidence_source_ref: f.evidence.sourceRef, cue: f.cue ? f.cue.use : null, ...sortMeta(f) },
  }))
  await db.query(
    `update public.taste_reports r set collected_at = now(), meta = r.meta || x.meta
     from jsonb_to_recordset($1::jsonb) as x(id uuid, meta jsonb)
     where r.id = x.id and r.collected_at is null`,
    [JSON.stringify(stamps)], { write: true },
  )
  return result
}

export interface SortResult {
  /** Filed reports read and sorted again. */
  read: number
  /** Filed as taste before, not taste now: their evidence is withdrawn. */
  withdrawn: number
  /** Incidents filed for the auditor this run, for reports filed before the sort. */
  incidentsFiled: number
  missing: boolean
}

/**
 * Sorts every report filed before this sort (or under an older rev) the way fileReport sorts a new one. A not_taste
 * report's evidence is withdrawn from taste, never deleted (clearing withdrawn_at puts it back), and only once its
 * incident is on file when it is his words. Idempotent: a second run withdraws and files nothing.
 */
export async function sortFiledReports(db: Db, opts: { write: boolean }): Promise<SortResult> {
  const result: SortResult = { read: 0, withdrawn: 0, incidentsFiled: 0, missing: false }
  const [reg] = await db.query<{ ok: boolean }>(`select to_regclass('public.taste_reports') is not null as ok`)
  if (!reg?.ok) return { ...result, missing: true }
  const rows = await db.query<ReportRow>(
    `select id::text, kind, body, said_where, said_at::text, lane, polarity, subject_ref, subject, session_ref,
            repository, surface, reported_at::text, venture
     from public.taste_reports
     where collected_at is not null and coalesce(meta->>'filed_as', '') <> 'refused'
       and coalesce(meta->>'sort_rev', '') <> $1`,
    [REPORT_SORT_REV],
  )
  result.read = rows.length
  const sorted = rows.map(r => ({ r, cls: classOfReport(r.body) }))
  const out = sorted.filter(x => x.cls === 'not_taste')
  result.withdrawn = out.length
  if (!opts.write || !rows.length) return result

  const incidents = sorted.flatMap(({ r, cls }) => { const i = incidentOf(r, cls); return i ? [i] : [] })
  result.incidentsFiled = await fileIncidents(db, incidents)
  if (out.length) {
    // His words leave taste only once the auditor holds them; an observation has no incident and leaves directly.
    await db.query(
      `update public.taste_evidence e set withdrawn_at = now()
       from public.taste_reports r
       where r.id = any($1::uuid[]) and e.source = 'session_report' and e.source_ref = 'report:' || r.id::text
         and e.withdrawn_at is null
         and (r.kind <> 'krish_words' or exists (select 1 from public.engine_incidents i where i.client_ref = 'taste-report:' || r.id::text))`,
      [out.map(x => x.r.id)], { write: true },
    )
  }
  const stamps = sorted.map(({ r, cls }) => ({
    id: r.id,
    meta: {
      sorted: cls, sort_rev: REPORT_SORT_REV, incident_ref: incidentOf(r, cls)?.client_ref ?? null,
      ...(cls === 'not_taste' ? { filed_as: 'not_taste' } : {}),
    },
  }))
  await db.query(
    `update public.taste_reports r set meta = r.meta || x.meta
     from jsonb_to_recordset($1::jsonb) as x(id uuid, meta jsonb) where r.id = x.id`,
    [JSON.stringify(stamps)], { write: true },
  )
  return result
}
