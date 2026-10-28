import { DRIVE } from './config.ts'
import type { Source } from './evidence.ts'

// Which venture each row of the taste ledger is taste for: the one place it is decided, in code, never by a model
// (AGENTS.md rule 10). Krish, 2026-10-28: "The ledger is keyed by venture not repository. Makeyourmindup as a separate
// venture to mindmake". A venture is a public.venture_registry slug, and a row keeps the one it was filed under (the
// database refuses a change, content-engine 20261117090000_taste_ventures.sql).
//
// These rules are the migration's backfill (its section 3), so the rows it set and the rows the engine writes agree; a
// run counts every stored row whose venture differs from what this file computes now (venture_mismatch), and fails on
// one.

/** A public.venture_registry slug. */
export type Venture = string

/** Make Your Mind Up: the slug venture_formats, growth_engines and the North Star readings already use for it. */
export const MYMU = 'publication'
/** Krish's own stages, guests and lists. */
export const MINDMAKE = 'mindmake'
/**
 * The one venture whose rejection floor is distilled, proposed and rendered, since only it has a floor reader
 * (content-engine's config/rejection-floor.json). Every venture's rejections are still filed under their own venture,
 * so another's floor can start the day it gets a reader.
 */
export const FLOOR_VENTURE = MYMU

/** How a venture is named in what the engine renders. A slug not listed is shown as itself. */
export const VENTURE_NAMES: Readonly<Record<string, string>> = {
  publication: 'Make Your Mind Up',
  mindmake: 'Mindmake',
  heartside: 'Heartside',
  full_time: 'Full Time',
  legibility: 'Legibility',
  mm_ctrl: 'CTRL',
  fractionl_pulse: 'Pulse',
  fractionl_circle: 'Circle',
  signal_noise: 'Signal & Noise',
}

export function ventureName(slug: Venture): string {
  return Object.hasOwn(VENTURE_NAMES, slug) ? VENTURE_NAMES[slug]! : slug
}

/** Make Your Mind Up first, then by slug: the order every per-venture render and step uses. */
export function byVenture(a: Venture, b: Venture): number {
  return Number(b === MYMU) - Number(a === MYMU) || a.localeCompare(b)
}

// The sources whose every row is one venture's. Every source is listed here or decided below, so a new source cannot
// be written until someone says whose it is.
type ConstantSource = Exclude<Source, 'session_report' | 'visibility_target' | 'feedback_hist'>
export const SOURCE_VENTURE = {
  // content-engine's taste files: Make Your Mind Up's content.
  learnings_json: MYMU, title_verdicts: MYMU, golden_examples: MYMU, rejected_lines: MYMU, style_references: MYMU,
  style_bank: MYMU,
  // His Drive folders and the What I like sheet (Ventures > Inspiration), and the Inspiration page's cards made of them.
  drive_cold: MYMU, drive_video: MYMU, what_i_like_sheet: MYMU, inspiration_page: MYMU,
  // The idea queue, the creators he follows and the strategy folder's artifacts: what Make Your Mind Up makes.
  idea_triage: MYMU, creator_move: MYMU, drive_artifact: MYMU,
} as const satisfies Record<ConstantSource, Venture>

/** What a row's venture may depend on beyond its source: its visibility target's product, its agent, its report. */
export interface VentureFacts {
  /** visibility_targets.product_slug of the target (visibility_target rows). */
  product?: string | null
  /** feedback_queue.original_agent (feedback_hist rows). */
  agent?: unknown
  /** taste_reports.venture of the report (session_report rows): the map's, or the one the session named. */
  report?: Venture | null
}

/**
 * The venture of a row of this source. Null only for a session report that has none yet (an unmapped repository whose
 * session named no venture): such a report is held, never filed.
 */
export function ventureOf(source: Exclude<Source, 'session_report'>, facts?: VentureFacts): Venture
export function ventureOf(source: Source, facts?: VentureFacts): Venture | null
export function ventureOf(source: Source, facts: VentureFacts = {}): Venture | null {
  switch (source) {
    // The report's own venture: its repository's in taste_venture_repositories, or the one its session named.
    case 'session_report': return facts.report ?? null
    // A target is its product's; one with none is his own stage, Mindmake's (as Control Center reads it).
    case 'visibility_target': return facts.product ?? MINDMAKE
    // Nova's and Nell's feedback was on targets, contacts and guests: Mindmake's. Cleo's was on content.
    case 'feedback_hist': return facts.agent === 'nova' || facts.agent === 'nell' ? MINDMAKE : MYMU
    default: return SOURCE_VENTURE[source]
  }
}

/**
 * The venture of the cues the cues stage writes (src/collect/feedbackCues.ts): the idea queue and the Inspiration
 * cards are Make Your Mind Up's. A session report's cue takes its report's venture (src/collect/sessionReports.ts).
 */
export const CUE_VENTURE = { idea_queue: MYMU, inspiration_card: MYMU } as const satisfies Record<string, Venture>

/** The venture of each Drive folder the engine reads. Both Inspiration folders and Rejections are Make Your Mind Up's. */
export const FOLDER_VENTURE: Readonly<Record<string, Venture>> = {
  [DRIVE.coldIdeas]: MYMU,
  [DRIVE.videoInspiration]: MYMU,
  [DRIVE.rejections]: MYMU,
}

export function folderVenture(folderId: string): Venture {
  const v = FOLDER_VENTURE[folderId]
  if (!v) throw new Error('a Drive folder with no venture: add it to FOLDER_VENTURE first')
  return v
}
