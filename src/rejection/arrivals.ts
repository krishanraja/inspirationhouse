import type { Db } from '../db.ts'
import { clip } from '../evidence.ts'
import { contentHash } from '../hash.ts'
import { quoteKey, type Capture, type QuoteRow, type RecordRow } from './file.ts'
import { FORMATS, RULES_REV, formatsOf, type FormatSlug } from './vocab.ts'

// New rejections, arriving by themselves through doors that already exist. No Claude schedule and no session key:
// the engine runs on GitHub Actions and reads what sessions have already filed.
//
//   1. A session report of his words with polarity dislikes (Control Center's report_to_taste_engine, from any
//      repository, filed by the daily reports stage as taste_evidence source 'session_report'). It already says where
//      and when he said it.
//   2. The inbox (content-engine taste_rejection_inbox), filled by the one-step capture: his words, where and when,
//      and a screenshot, a master with the moment, or a whole cut. Read once and stamped collected_at.

export interface ReportEvidence {
  source_ref: string
  occurred_at: string
  lane: string
  title: string | null
  excerpt: string | null
  meta: Record<string, unknown>
}

/** Every standing report of his words that dislikes something. Read whole: a report withdrawn is a record withdrawn. */
export async function reportedDislikes(db: Db): Promise<ReportEvidence[]> {
  return db.query<ReportEvidence>(
    `select source_ref, occurred_at::text, lane, title, excerpt, meta
     from public.taste_evidence
     where source = 'session_report' and attribution = 'krish_words' and polarity = 'dislikes' and withdrawn_at is null
     order by occurred_at, source_ref`,
  )
}

const said = (e: { excerpt: string | null; meta: Record<string, unknown> }): string | null => {
  const whole = typeof e.meta.full_text === 'string' ? e.meta.full_text : null
  return (whole ?? e.excerpt)?.trim() || null
}

/** One report as a quote and a record. Pure. A report with no words, or no where and when, files nothing. */
export function fileReportDislike(e: ReportEvidence): { quote: QuoteRow; record: RecordRow } | null {
  const text = said(e)
  const where = typeof e.meta.said_where === 'string' ? e.meta.said_where.trim() : ''
  const at = new Date(e.occurred_at)
  if (!text || !where || Number.isNaN(at.getTime())) return null
  const quote: QuoteRow = {
    key: quoteKey(text, at.toISOString().slice(0, 10)), text, saidAt: at.toISOString(), precision: 'second',
    saidWhere: clip(where, 300) ?? where, source: 'session_report', attribution: 'krish_words',
  }
  // The session's line and his words say which maker a report is for; his words alone say whether he named a craft.
  const formats = formatsOf(e.title, { item: text })
  const craft = formatsOf(text, { item: text }).filter(f => f !== 'other' && f !== 'all')
  // A dislike in the strategy or visibility lane is about what to make or where it goes, never how it is made; one about
  // an idea or a card (its subject line names the idea) is too, unless his words name the craft they fault. Either is
  // kept and never served or made a standard (anti-echo).
  const aboutSubject = typeof e.meta.subject_ref === 'string' && /^(idea|card):/.test(e.meta.subject_ref)
  const ruleKind = e.lane === 'strategy' || e.lane === 'visibility' || (aboutSubject && !craft.length) ? 'subject' : 'form'
  const content = { k: 'rejected', q: [quote.key], t: e.title, f: formats, l: e.lane, rk: ruleKind, rules: RULES_REV }
  return {
    quote,
    record: {
      source: 'session_report', sourceRef: e.source_ref, version: contentHash(content), kind: 'rejected',
      // The session's subject line names the idea, so it is never shown as what was rejected: only his words are.
      rejectedAt: at.toISOString(), quoteKeys: [quote.key], attribution: 'krish_words', item: null,
      reason: null, wantedInstead: null, strength: 'unstated', theme: 'other', formats, ruleKind, capture: 'words',
      piece: null, media: { stills: [], strips: [], masters: [], texts: 0 }, moment: null,
      meta: { lane: e.lane, repository: e.meta.repository ?? null, report_id: e.meta.report_id ?? null, subject_ref: e.meta.subject_ref ?? null },
    },
  }
}

export interface InboxRow {
  id: string
  kind: 'rejected' | 'liked' | 'process'
  said: string
  said_where: string
  said_at: string
  piece: string | null
  formats: string[]
  note: string | null
  screenshot_b64: string | null
  screenshot_mime: string | null
  master_drive_id: string | null
  master_sha256: string | null
  at_ms: number | null
  whole_cut: boolean
  repository: string
  session_ref: string
}

export async function uncollectedInbox(db: Db, limit = 200): Promise<InboxRow[]> {
  return db.query<InboxRow>(
    `select id::text, kind, said, said_where, said_at::text, piece, formats, note,
            case when screenshot is null then null else encode(screenshot, 'base64') end as screenshot_b64,
            screenshot_mime, master_drive_id, master_sha256, at_ms, whole_cut, repository, session_ref
     from public.taste_rejection_inbox where collected_at is null order by reported_at limit $1`,
    [limit],
  )
}

/**
 * One capture as a quote and a record. Pure. The formats the capture named are kept where they are the engine's
 * vocabulary; anything else is read from the piece and the session's note.
 */
export function fileCapture(row: InboxRow): { quote: QuoteRow; record: RecordRow } {
  const at = new Date(row.said_at)
  const quote: QuoteRow = {
    key: quoteKey(row.said, at.toISOString().slice(0, 10)), text: row.said.trim(), saidAt: at.toISOString(), precision: 'second',
    saidWhere: clip(row.said_where, 300) ?? row.said_where, source: 'capture', attribution: 'krish_words',
  }
  const named = row.formats.filter((f): f is FormatSlug => Object.hasOwn(FORMATS, f) && f !== 'other')
  const formats = named.length ? [...new Set(named)].sort() : formatsOf(`${row.piece ?? ''} ${row.note ?? ''}`, { item: `${row.note ?? ''} ${row.said}` })
  const capture: Capture = row.screenshot_b64 ? 'still' : row.at_ms !== null ? 'moment' : row.whole_cut ? 'whole_cut' : 'words'
  const masters = row.master_drive_id ? [{ where: 'drive_id' as const, ref: row.master_drive_id }] : []
  const content = { k: row.kind, q: [quote.key], p: row.piece, f: formats, c: capture, at: row.at_ms, m: row.master_drive_id, rules: RULES_REV }
  return {
    quote,
    record: {
      source: 'inbox', sourceRef: `inbox:${row.id}`, version: contentHash(content), kind: row.kind,
      rejectedAt: at.toISOString(), quoteKeys: [quote.key], attribution: 'krish_words', item: clip(row.note, 4000),
      reason: null, wantedInstead: null, strength: row.kind === 'liked' ? 'liked' : 'unstated',
      theme: row.kind === 'liked' ? 'liked' : row.kind === 'process' ? 'process' : 'other', formats,
      ruleKind: row.kind === 'process' ? 'workflow' : 'form', capture, piece: clip(row.piece, 300),
      media: { stills: [], strips: [], masters, texts: 0 },
      moment: row.at_ms !== null ? { ms: row.at_ms, anchor: null, origin: 'krish' } : null,
      meta: { repository: row.repository, inbox_id: row.id },
    },
  }
}

export async function markCollected(db: Db, ids: string[], runId: string): Promise<number> {
  if (!ids.length) return 0
  const done = await db.query<{ id: string }>(
    `update public.taste_rejection_inbox set collected_at = now(), meta = meta || jsonb_build_object('run_id', $2::text)
     where id = any($1::uuid[]) and collected_at is null returning id::text`,
    [ids, runId],
    { write: true },
  )
  return done.length
}
