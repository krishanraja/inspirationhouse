import type { Db } from './db.ts'
import { contentHash } from './hash.ts'

export type Lane = 'strategy' | 'production' | 'visibility' | 'voice'
export type Polarity = 'likes' | 'dislikes' | 'neutral'
// Only krish_words and krish_action count toward a claim (the database
// recounts them). An observation or a machine inference is context, never proof.
export type Attribution = 'krish_words' | 'krish_action' | 'observation' | 'machine_inference'

export type Source =
  | 'learnings_json' | 'title_verdicts' | 'golden_examples' | 'rejected_lines'
  | 'style_references' | 'style_bank' | 'drive_cold' | 'drive_video'
  | 'what_i_like_sheet' | 'idea_triage' | 'feedback_hist' | 'creator_move'
  | 'visibility_target' | 'drive_artifact' | 'inspiration_page'

export interface Evidence {
  source: Source
  sourceRef: string
  occurredAt: string
  attribution: Attribution
  polarity: Polarity
  lane: Lane
  layer: string | null
  title: string | null
  // Krish's own words when attribution is krish_words; otherwise a short
  // recorded reason. Never more than 400 characters (the column enforces it).
  excerpt: string | null
  meta: Record<string, unknown>
}

const LAYERS = new Set([
  'opening', 'structure', 'breakdown', 'proof', 'tone', 'close', 'packaging',
  'length', 'editing', 'camerawork', 'graphics', 'production', 'stage_format',
])

export function clip(text: unknown, max: number): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return space > max * 0.6 ? cut.slice(0, space) : cut
}

export function asLayer(value: unknown): string | null {
  return typeof value === 'string' && LAYERS.has(value) ? value : null
}

export function isoOr(value: unknown, fallback: string): string {
  if (typeof value === 'string' || value instanceof Date) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return fallback
}

// The version is a hash of the entry's own content: an edited entry is a new
// row, an unchanged one is never inserted twice.
export function versionOf(e: Evidence): string {
  return contentHash({
    a: e.attribution, p: e.polarity, l: e.lane, y: e.layer, t: e.title, x: e.excerpt, m: e.meta,
  })
}

export function normalise(e: Evidence): Evidence {
  return {
    ...e,
    sourceRef: e.sourceRef.slice(0, 300),
    layer: asLayer(e.layer),
    title: clip(e.title, 300),
    excerpt: clip(e.excerpt, 400),
  }
}

export interface WriteResult { seen: number; written: number }

export async function writeEvidence(db: Db, rows: Evidence[], runId: string): Promise<WriteResult> {
  if (!rows.length) return { seen: 0, written: 0 }
  const payload = rows.map(normalise).map(e => ({
    source: e.source,
    source_ref: e.sourceRef,
    source_version: versionOf(e),
    occurred_at: e.occurredAt,
    attribution: e.attribution,
    polarity: e.polarity,
    lane: e.lane,
    layer: e.layer,
    title: e.title,
    excerpt: e.excerpt,
    meta: e.meta,
    collected_run: runId,
  }))
  let written = 0
  for (let i = 0; i < payload.length; i += 200) {
    const batch = payload.slice(i, i + 200)
    const res = await db.query<{ n: number }>(
      `with ins as (
         insert into public.taste_evidence
           (source, source_ref, source_version, occurred_at, attribution, polarity, lane, layer, title, excerpt, meta, collected_run)
         select source, source_ref, source_version, occurred_at, attribution, polarity, lane, layer, title, excerpt, meta, collected_run
         from jsonb_to_recordset($1::jsonb) as x(
           source text, source_ref text, source_version text, occurred_at timestamptz, attribution text,
           polarity text, lane text, layer text, title text, excerpt text, meta jsonb, collected_run uuid)
         on conflict (source, source_ref, source_version) do nothing
         returning 1)
       select count(*)::int as n from ins`,
      [JSON.stringify(batch)],
      { write: true },
    )
    written += Number(res[0]?.n ?? 0)
  }
  return { seen: rows.length, written }
}
