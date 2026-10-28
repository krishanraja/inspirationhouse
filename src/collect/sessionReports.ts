import type { Db } from '../db.ts'
import { writeEvidence, type Evidence, type Lane, type Polarity } from '../evidence.ts'
import { ventureOf, type Venture } from '../venture.ts'
import { classify, type Reading } from './feedbackCues.ts'

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

export interface Filed {
  id: string
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
    return { id: r.id, evidence: null, cue: null, refused: 'words_without_where_or_when' }
  }
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
  return { id: r.id, evidence, cue, refused: null }
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
  /** content-engine's taste_reports migration is not applied yet: nothing is read or written. */
  missing: boolean
}

const BATCH = 500

/** The daily `reports` stage: file every report not yet filed. With write false it reports what it would do. */
export async function syncReports(db: Db, runId: string, opts: { write: boolean }): Promise<ReportResult> {
  const result: ReportResult = {
    read: 0, words: 0, observations: 0, cues: 0, refused: 0, unassigned: 0, ventureMismatch: 0, evidenceWritten: 0, missing: false,
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
    else if (f.evidence?.attribution === 'krish_words') result.words++
    else result.observations++
    if (f.cue) result.cues++
  }
  if (!opts.write || !rows.length) return result

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
  const stamps = filed.map(f => ({
    id: f.id,
    meta: f.refused ? { filed_as: 'refused', reason: f.refused } : {
      filed_as: f.evidence!.attribution, evidence_source_ref: f.evidence!.sourceRef, cue: f.cue ? f.cue.use : null,
    },
  }))
  await db.query(
    `update public.taste_reports r set collected_at = now(), meta = r.meta || x.meta
     from jsonb_to_recordset($1::jsonb) as x(id uuid, meta jsonb)
     where r.id = x.id and r.collected_at is null`,
    [JSON.stringify(stamps)], { write: true },
  )
  return result
}
