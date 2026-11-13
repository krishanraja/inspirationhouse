import type { Db } from '../db.ts'
import type { Venture } from '../venture.ts'
import type { GitHubApi } from './harness.ts'

// The harness's North Star counts "corrections Krish had to give twice in a week, across the fleet" (ai-harness
// docs/NORTH_STAR.md). Its own ledger never measured it: NOW.md read "U4, not measured yet" on 2026-11-12. This
// ledger already holds his corrections of machine work as countable signals, each named by a fixed slug
// (src/signal/vocab.ts), so "the same correction given twice" can be counted here without a model deciding what
// counts as the same.
//
// A correction is a dislike in his own words (origin 'krish') about something a machine made. That rules in only the
// sources where he is reacting to the system's own output: what sessions in other repositories report of his typed
// corrections, his verdicts on drafted titles, ideas and lines, and the draft learnings content-engine keeps. It rules
// out everything he dislikes in someone else's work (the Inspiration page, his folders, the sheet): that is taste, not
// a correction. A slug ending `.other` names nothing fixed and subject signals are what a piece is about (anti-echo),
// so neither is grouped. The same slug from two or more pieces of his evidence dated in one ISO week (Monday, UTC) is
// one repeated correction, kept under the venture its evidence was filed under (AGENTS.md rule 10).
//
// Only counts and slugs leave this file: slugs are this repository's public vocabulary, never his words (rule 2).

export const CORRECTION_SOURCES = ['session_report', 'title_verdicts', 'learnings_json', 'rejected_lines', 'idea_triage'] as const

/** One slug's evidence count in one venture and week, with the lane most of that evidence was filed in. */
export interface SlugWeek { venture: Venture; attribute: string; week: string; evidence: number; lane?: string | null; kind?: string | null }

export const REPEATS_SQL = `
  select e.venture, s.attribute, to_char(date_trunc('week', e.occurred_at at time zone 'UTC'), 'YYYY-MM-DD') as week,
         count(distinct e.id)::int as evidence, mode() within group (order by e.lane) as lane, min(s.kind) as kind
  from public.taste_signals s
  join public.taste_evidence e on e.id = s.evidence_id
  where s.superseded_at is null and s.origin = 'krish' and s.polarity = 'dislikes' and s.kind <> 'subject'
    and s.attribute not like '%.other' and e.withdrawn_at is null and e.venture is not null
    and e.source = any($1::text[])
    and e.occurred_at >= $2::date and e.occurred_at < $3::date
  group by 1, 2, 3`

/** The Monday (UTC) of the ISO week that holds the day. */
export function mondayOf(day: Date): string {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface RepeatReading {
  /** The Monday of the last whole week: a reading is never taken from a week still running. */
  week: string
  /** Repeated corrections in that week, across ventures. */
  total: number
  byVenture: Record<Venture, number>
  /** The repeated slugs, most evidence first, as "venture:slug=n". */
  slugs: string[]
  /** The repeated rows themselves, most evidence first. */
  repeats: SlugWeek[]
}

/** Count the repeated corrections of one week from per-slug rows. Pure. */
export function readRepeats(rows: SlugWeek[], week: string): RepeatReading {
  const repeated = rows.filter(r => r.week === week && r.evidence >= 2)
    .sort((a, b) => b.evidence - a.evidence || a.venture.localeCompare(b.venture) || a.attribute.localeCompare(b.attribute))
  const byVenture: Record<Venture, number> = {}
  for (const r of repeated) byVenture[r.venture] = (byVenture[r.venture] ?? 0) + 1
  return { week, total: repeated.length, byVenture, slugs: repeated.map(r => `${r.venture}:${r.attribute}=${r.evidence}`), repeats: repeated }
}

/** The last whole week's reading: Monday to Sunday, ending before the Monday of the week that holds now. */
export async function repeatedCorrections(db: Db, now: Date): Promise<RepeatReading> {
  const week = addDays(mondayOf(now), -7)
  const rows = await db.query<SlugWeek>(REPEATS_SQL, [[...CORRECTION_SOURCES], week, addDays(week, 7)])
  return readRepeats(rows.map(r => ({ ...r, evidence: Number(r.evidence) })), week)
}

/** The reading as flat run counts (content_engine_runs.counts holds numbers, booleans and strings only). */
export function repeatCounts(r: RepeatReading): Record<string, number | string> {
  return {
    repeated_corrections_week: r.week,
    repeated_corrections: r.total,
    ...Object.fromEntries(Object.entries(r.byVenture).map(([v, n]) => [`repeated_corrections_${v}`, n])),
    ...(r.slugs.length ? { repeated_correction_slugs: r.slugs.slice(0, 20).join(', ') } : {}),
  }
}

// Each repeat goes to ai-harness's observation ledger, so the harness counts it toward its North Star and its weekly
// proposer (scripts/propose.mjs) can turn it into a change to the skill that owns it. It goes as one redacted envelope
// per repeated slug, by a repository_dispatch of type harness-observations (ai-harness scripts/intake-observations.mjs).
// The skill is the one that reads this lane's approved rules (HARNESS_FILES in ./harness.ts): voice and strategy are
// krish-voice's, production and visibility krish-design's, and how he wants the system to work with him is
// krish-principles'. The envelope carries the slug, the venture and the counts: never his words.

export function owningSkill(lane: string | null | undefined, kind: string | null | undefined): string {
  if (kind === 'workflow') return 'krish-principles'
  if (lane === 'production' || lane === 'visibility') return 'krish-design'
  return 'krish-voice'
}

export interface HarnessEnvelope {
  event_id: string; occurred_at: string; surface: 'github-actions'; kind: 'explicit_correction'
  summary: string; evidence_ref: string; related_skill_or_rule: string
  outcome: 'corrected'; severity: 'medium'; confidence: 'high'
}

/** One envelope per repeated slug. Its id is fixed by week, venture and slug, so a resend is recorded once. Pure. */
export function repeatEnvelopes(r: RepeatReading): HarnessEnvelope[] {
  return r.repeats.map(x => ({
    event_id: `taste-ledger:${r.week}:${x.venture}:${x.attribute}`,
    occurred_at: `${r.week}T00:00:00Z`,
    surface: 'github-actions',
    kind: 'explicit_correction',
    summary: `Krish gave the same correction (${x.attribute}) in ${x.evidence} pieces of evidence in the week of ${r.week} (venture ${x.venture}), counted by the taste ledger.`,
    evidence_ref: `inspirationhouse:taste_signals:${r.week}:${x.venture}:${x.attribute}`,
    related_skill_or_rule: owningSkill(x.lane, x.kind),
    outcome: 'corrected', severity: 'medium', confidence: 'high',
  }))
}

/** ai-harness's intake takes at most 100 envelopes a dispatch (scripts/intake-observations.mjs MAX_EVENTS). */
export const DISPATCH_MAX = 100

export async function sendRepeats(gh: GitHubApi, envelopes: HarnessEnvelope[]): Promise<void> {
  if (!gh.dispatch) throw new Error('this GitHub client cannot dispatch')
  for (let i = 0; i < envelopes.length; i += DISPATCH_MAX) {
    await gh.dispatch('harness-observations', { events: envelopes.slice(i, i + DISPATCH_MAX) })
  }
}
