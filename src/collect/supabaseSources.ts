import type { Db } from '../db.ts'
import type { Evidence } from '../evidence.ts'
import { clip } from '../evidence.ts'

// Signals that live in the Mindmaker OS database. Each query reads only rows
// that are Krish's own decisions, or labels the row as an observation.

export async function collectIdeaTriage(db: Db): Promise<Evidence[]> {
  const rows = await db.query<{ id: string; idea: string | null; triage: Record<string, unknown>; at: string }>(
    `select id::text, idea, meta->'queue'->'triage' as triage, coalesce(updated_at, created_at)::text as at
     from public.content_ideas
     where meta #>> '{queue,triage,decided_by}' = 'Krish'`,
  )
  return rows.map(r => {
    const verdict = String(r.triage.verdict ?? '')
    const said = typeof r.triage.said === 'string' ? r.triage.said : null
    const reason = typeof r.triage.reason === 'string' ? r.triage.reason : null
    return {
      source: 'idea_triage', sourceRef: r.id, occurredAt: String(r.triage.at ?? r.at),
      attribution: said ? 'krish_words' : 'krish_action',
      // story: he would run it. angle: he would, from an angle he names. cute:
      // he likes it but would not run it. curious: he needs a reason. drop: no.
      polarity: ['story', 'angle', 'cute'].includes(verdict) ? 'likes' : verdict === 'drop' ? 'dislikes' : 'neutral',
      lane: 'strategy', layer: null, title: r.idea, excerpt: said ?? reason,
      meta: { verdict, reason, angle: r.triage.angle ?? null },
    } satisfies Evidence
  })
}

// Applied and dropped are his moves. The scorer's own `rejected` verdict is
// not, so it is never read as his taste.
export async function collectVisibility(db: Db): Promise<Evidence[]> {
  const rows = await db.query<Record<string, string | number | null>>(
    `select id::text, title, status, type, format, pitch_type, audience_seniority, audience_size,
            coalesce(applied_at, updated_at)::text as at
     from public.visibility_targets
     where status in ('applied', 'dropped')`,
  )
  return rows.map(r => ({
    source: 'visibility_target', sourceRef: String(r.id), occurredAt: String(r.at),
    attribution: 'krish_action', polarity: r.status === 'applied' ? 'likes' : 'dislikes',
    lane: 'visibility', layer: 'stage_format', title: r.title === null ? null : String(r.title), excerpt: null,
    meta: { type: r.type, format: r.format, pitch_type: r.pitch_type, audience_seniority: r.audience_seniority, audience_size: r.audience_size },
  }) satisfies Evidence)
}

// A move read off a creator's post he saved. The saving was his; the reading
// of it is the machine's, so it is context and never counts toward a claim.
export async function collectCreatorMoves(db: Db): Promise<Evidence[]> {
  const rows = await db.query<{ id: string; slug: string | null; move: Record<string, unknown>; why: string | null; at: string }>(
    `select id::text, creator_slug as slug, move, why_it_works as why, created_at::text as at from public.creator_moves`,
  )
  return rows.map(r => ({
    source: 'creator_move', sourceRef: r.id, occurredAt: r.at,
    attribution: 'observation', polarity: 'likes', lane: 'strategy', layer: null,
    title: r.slug, excerpt: clip(r.why, 400), meta: { move: r.move },
  }) satisfies Evidence)
}

// What drive-scan read from the strategy folder, once it writes artifacts.
export async function collectDriveArtifacts(db: Db): Promise<Evidence[]> {
  const rows = await db.query<{ id: string; label: string | null; analysis: Record<string, unknown> | null; at: string; file_id: string | null }>(
    `select id::text, source_label as label, analysis, coalesce(analyzed_at, created_at)::text as at,
            source_meta->>'drive_file_id' as file_id
     from public.content_inspiration_artifacts
     where analysis is not null`,
  )
  return rows.map(r => ({
    source: 'drive_artifact', sourceRef: r.file_id ?? r.id, occurredAt: r.at,
    attribution: 'machine_inference', polarity: 'likes', lane: 'strategy', layer: null,
    title: r.label, excerpt: clip(r.analysis?.why_saved, 400),
    meta: { outcome: r.analysis?.outcome ?? null, idea: r.analysis?.the_idea ?? null },
  }) satisfies Evidence)
}

// History from June and July: rejections of Cleo (content) and Nova and Nell
// (visibility and guests). Lead rejections are sales, not taste.
//
// Read 2026-10-22: 300 of these 310 rows were written on one day, 2026-06-17,
// half with the machine phrase "bottom of queue (score N)". That was a bulk
// queue cleanup, not 300 judgements. So a machine-phrased row is dropped, a row
// from a bulk day (over 50 rows) is only an observation, and only an isolated
// rejection counts as his.
const BULK_DAY = 50

export async function collectFeedbackHistory(db: Db): Promise<Evidence[]> {
  const rows = await db.query<Record<string, string | number | null>>(
    `with days as (
       select created_at::date as d, count(*) as n from public.feedback_queue group by 1
     )
     select f.id, f.original_agent as agent, f.reason_code,
            coalesce(f.reason_text, f.rejection_reason, f.feedback_text) as said,
            f.created_at::text as at, days.n as day_rows
     from public.feedback_queue f join days on days.d = f.created_at::date
     where f.original_agent in ('cleo', 'nova', 'nell')
       and coalesce(f.reason_text, f.rejection_reason, f.feedback_text, f.reason_code) is not null
       and coalesce(f.reason_text, '') not like 'bottom of queue%'`,
  )
  return rows.map(r => {
    const bulk = Number(r.day_rows) > BULK_DAY
    return {
      source: 'feedback_hist', sourceRef: String(r.id), occurredAt: String(r.at),
      attribution: bulk ? 'observation' : r.said ? 'krish_words' : 'krish_action', polarity: 'dislikes',
      lane: r.agent === 'cleo' ? 'strategy' : 'visibility', layer: null,
      title: r.reason_code === null ? null : String(r.reason_code), excerpt: r.said === null ? null : String(r.said),
      meta: { agent: r.agent, reason_code: r.reason_code, bulk_day: bulk },
    } satisfies Evidence
  })
}
