import type { Db } from '../db.ts'
import { FLOOR_VENTURE, type Venture } from '../venture.ts'

// Defects leave the taste system (Ruling, Krish, 2026-11-23: the taste system holds only preference and inspiration).
//
// A defect is something that was wrong, broke or misfired: words off the frame, a cut out of sync, a session that did
// the wrong thing. Its event goes to content-engine's engine_incidents and its standard to engine_standards. A
// preference is what he likes or how something should feel, and stays here. A record that holds both is logged as an
// incident and stays in taste, so neither half is lost. The sort is fixed rules, never a model (AGENTS.md rule 3).
//
// Nothing is deleted: a moved row keeps its words, marked moved_to_engine_at, and clearing that and withdrawn_at puts
// it back. Makers still read every standard, through content-engine's production_floor view.

/** Bump when a rule below changes what is sorted where. */
export const DEFECT_REV = 'defects-2026-11-23'

export type DefectClass = 'defect' | 'mixed' | 'preference'

const DEFECT_WORDS = new RegExp([
  'fall(?:s|ing)? off', 'off the (?:page|screen|frame)', 'cut(?:s|ting)? off', 'clipped (?:speech|audio|words?)', 'overlap',
  'misalign', 'off[- ]cent', 'not (?:aligned|centred|centered)', 'out of sync', 'lip[- ]?sync', 'blurr?y', 'pixelat',
  'broken', '(?:button|link|download)s?\\b.{0,24}(?:did not|does not|didn.t|doesn.t) work', 'glitch', 'stutter', 'flicker',
  'garbled', 'mis-?transcri', '\\btypos?\\b', 'misspel', 'chopped', 'truncat',
  'missing (?:logo|image|picture|caption|word|file|asset|music|audio|wordmark|section)', 'no (?:burned|visible )?captions',
  'wrong (?:logo|mark|brand|date|name|figure|number|file|version|title|day)', 'hidden (?:under|behind)',
  'illegible', 'unreadable', 'too (?:small|tiny) to read', 'empty (?:image )?(?:slot|panel)', 'dead space', 'too quiet',
  '\\blufs\\b', 'music silent', 'different sizes', 'not the same size', 'see-through', 'double image',
].join('|'), 'i')

/** Themes that are his judgement of how a thing should feel or read: never a defect by their words alone. */
const PREFERENCE_THEMES = new Set(['voice_tone', 'words_on_screen', 'clipart_generic', 'decorative_motion', 'predictions_framing', 'unclear_copy', 'packaging'])

export const hasDefectWords = (text: string | null | undefined): boolean => DEFECT_WORDS.test(text ?? '')

export interface ClassableRecord { kind: string; theme: string; rule_kind: string; item: string | null; words: string }

/** Where one rejection record belongs. Pure. Something he liked is never a defect. */
export function classOfRecord(r: ClassableRecord): DefectClass {
  if (r.kind === 'liked') return 'preference'
  if (r.kind === 'process' || r.rule_kind === 'workflow' || r.theme === 'edit_av') return 'defect'
  if (PREFERENCE_THEMES.has(r.theme)) return 'preference'
  // An unsorted record is usually several complaints in his words: log the fault and keep the rest as taste.
  if (r.theme === 'other') return hasDefectWords(`${r.item ?? ''} ${r.words}`) ? 'mixed' : 'preference'
  if (hasDefectWords(r.item)) return 'defect'
  return hasDefectWords(r.words) ? 'mixed' : 'preference'
}

export interface ClassableStandard { kind: string; theme: string; statement: string }

/** Where one standard belongs. Pure. */
export function classOfStandard(s: ClassableStandard): 'defect' | 'preference' {
  if (s.kind === 'workflow' || s.theme === 'process' || s.theme === 'edit_av') return 'defect'
  if (PREFERENCE_THEMES.has(s.theme)) return 'preference'
  return hasDefectWords(s.statement) ? 'defect' : 'preference'
}

/** The engine_incidents stage a rejection's formats point at. */
export function stageOfFormats(formats: readonly string[], kind: string): 'brief' | 'script' | 'cut' | 'package' | 'board' | 'session' {
  if (kind === 'process') return 'session'
  const has = (...names: string[]) => names.some(n => formats.includes(n))
  if (has('short_video', 'long_video', 'captions', 'motion', 'audio', 'card', 'intro_outro')) return 'cut'
  if (has('cover', 'thumbnail', 'title', 'carousel', 'article')) return 'package'
  if (has('script')) return 'script'
  if (has('prediction')) return 'brief'
  if (has('board', 'site')) return 'board'
  return 'session'
}

export interface MoveResult {
  records_read: number; records_moved: number; records_mixed: number; incidents_filed: number
  standards_read: number; standards_moved: number; learnings_withdrawn: number
}

interface RecordRow extends ClassableRecord { id: string; formats: string[]; piece: string | null; rejected_at: string; source: string }
const INCIDENT_WORDS_MAX = 2000
const PIECE_MAX = 300
const MOVED_WHY = `Ruling (Krish, 2026-11-23): the taste system holds only preference and inspiration (${DEFECT_REV}).`

/**
 * Moves one venture's defects out of taste, standards first so a standard's words are copied while its records stand.
 * Idempotent: a second run moves nothing. A dry run reads and counts, and writes nothing. Only the publication's floor
 * has a failure log to move to, so other ventures' rows are never touched.
 */
export async function moveDefects(db: Db, write: boolean, venture: Venture = FLOOR_VENTURE): Promise<MoveResult> {
  const standards = await db.query<ClassableStandard & { id: string; fingerprint: string }>(
    `select id::text, fingerprint, kind, theme, statement from public.taste_floor where venture = $1`, [venture],
  )
  const movedStandards = standards.filter(s => classOfStandard(s) === 'defect')
  const records = await db.query<RecordRow>(
    `select r.id::text, r.kind, r.theme, r.rule_kind, r.item, r.piece, r.formats, r.rejected_at::text, r.source,
            coalesce((select string_agg(q.text, E'\\n' order by q.said_at, q.id) from public.taste_rejection_quotes q
                      where q.id = any(r.quote_ids) and q.attribution = 'krish_words'), '') as words
     from public.taste_rejections r
     where r.venture = $1 and r.withdrawn_at is null and r.moved_to_engine_at is null`,
    [venture],
  )
  const sorted = records.map(r => ({ r, cls: classOfRecord(r) })).filter(x => x.cls !== 'preference')
  const moved = sorted.filter(x => x.cls === 'defect').map(x => x.r)
  const learnings = await db.query<{ id: string; title: string | null; excerpt: string | null }>(
    `select id::text, title, excerpt from public.taste_evidence
     where venture = $1 and source = 'learnings_json' and withdrawn_at is null`, [venture],
  )
  const defectLearnings = learnings.filter(l => hasDefectWords(l.title))
  const result: MoveResult = {
    records_read: records.length, records_moved: moved.length, records_mixed: sorted.length - moved.length, incidents_filed: 0,
    standards_read: standards.length, standards_moved: movedStandards.length, learnings_withdrawn: defectLearnings.length,
  }
  if (!write) return result

  if (movedStandards.length) {
    const ids = movedStandards.map(s => s.id)
    await db.query(
      `insert into public.engine_standards
         (id, fingerprint, formats, theme, layer, kind, standing, statement, how_to_check, krish, support_n, action_n, quote_ids,
          record_refs, boundary_quote_ids, status, decided_at, venture, group_key, group_title, group_statement, group_amended_at, moved_why)
       select f.id, f.fingerprint, f.formats, f.theme, f.layer, f.kind, f.standing, f.statement, f.how_to_check, f.krish, f.support_n,
              f.action_n, f.quote_ids, f.record_refs, f.boundary_quote_ids, f.status, f.decided_at, f.venture, f.group_key, f.group_title,
              f.group_statement, f.group_amended_at, $2
       from public.taste_floor f where f.id = any($1::uuid[])
       on conflict (venture, fingerprint) do nothing`,
      [ids, MOVED_WHY], { write: true },
    )
    // Only a standard the engine now holds is marked moved, every version of it.
    await db.query(
      `update public.taste_floor_standards s set moved_to_engine_at = now()
       where s.venture = $1 and s.moved_to_engine_at is null and s.fingerprint = any($2::text[])
         and exists (select 1 from public.engine_standards e where e.venture = s.venture and e.fingerprint = s.fingerprint)`,
      [venture, movedStandards.map(s => s.fingerprint)], { write: true },
    )
  }

  if (sorted.length) {
    const rows = sorted.map(({ r, cls }) => ({
      client_ref: `taste-${cls === 'defect' ? 'move' : 'mixed'}:${r.id}`, at: r.rejected_at, piece_path: r.piece?.slice(0, PIECE_MAX) ?? null,
      stage: stageOfFormats(r.formats, r.kind), his_words: r.words.slice(0, INCIDENT_WORDS_MAX) || null,
      meta: { moved_from: 'taste_rejections', taste_id: r.id, theme: r.theme, class: cls, rev: DEFECT_REV },
    }))
    const filed = await db.query<{ id: string }>(
      `insert into public.engine_incidents (client_ref, at, piece_path, stage, maker, kind, his_words, meta)
       select client_ref, at, piece_path, stage, 'unknown', 'krish_reject', his_words, meta
       from jsonb_to_recordset($1::jsonb) as x(client_ref text, at timestamptz, piece_path text, stage text, his_words text, meta jsonb)
       on conflict (client_ref) do nothing returning id::text`,
      [JSON.stringify(rows)], { write: true },
    )
    result.incidents_filed = filed.length
  }

  if (moved.length) {
    // Only a record whose incident is on file leaves taste.
    await db.query(
      `update public.taste_rejections r set withdrawn_at = now(), moved_to_engine_at = now()
       where r.id = any($1::uuid[]) and r.moved_to_engine_at is null
         and exists (select 1 from public.engine_incidents i where i.client_ref = 'taste-move:' || r.id::text)`,
      [moved.map(r => r.id)], { write: true },
    )
  }

  if (defectLearnings.length) {
    await db.query(`update public.taste_evidence set withdrawn_at = now() where id = any($1::uuid[]) and withdrawn_at is null`,
      [defectLearnings.map(l => l.id)], { write: true })
  }
  return result
}
