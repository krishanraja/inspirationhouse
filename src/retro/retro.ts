import type { Db } from '../db.ts'
import { RETRO_VENTURE } from '../venture.ts'

// The retrospective (Wave 3, W3.6): what his scores say about how the pieces were made. Krish, 2026-10-29: "we need to
// test and learn". It joins his scores (content-engine piece_scores, W2.1: narrative and production out of 10, only
// his) and, where it has been read, engagement, to each piece's features: the choices under test it recorded (the
// opening, the lead picture, the big-moment sound, content_ideas.meta.making.production_choices, from
// config/reference-cuts.json under_test) and its format. It names one feature that scored well and one that scored
// badly, each with the pieces and numbers it rests on, and sends them to him as proposals only he decides (AGENTS.md
// rule 5).
//
// What it never does:
//   - rank topics. Taste shapes form, never subject (the anti-echo rule): no series, topic, angle or idea is a feature,
//     and featuresOf refuses one by name;
//   - claim beyond the data. Every number is computed here, never by a model (no model is called at all); a claim says
//     how many pieces it rests on, that it is an association and not a cause, and a feature seen on fewer than
//     RETRO_MIN_PIECES pieces makes no claim. With too little data the report says so and claims nothing;
//   - run on a timer of its own. Control Center's clock dispatches it (taste-retro.yml); it runs when a month has passed
//     since the last report or RETRO_EVERY newly scored pieces have arrived, and skips otherwise.

/** A feature value must be seen on at least this many scored pieces before it can carry a claim. */
export const RETRO_MIN_PIECES = 2
/** A new report after this many newly scored pieces... */
export const RETRO_EVERY = 4
/** ...or this many days, whichever comes first. */
export const RETRO_DAYS = 30

/** The features a piece is judged by. Never a topic: these name how it was made. */
export const FEATURE_KEYS = ['opening', 'lead_picture', 'big_moment_sound', 'format'] as const
export type FeatureKey = typeof FEATURE_KEYS[number]
// Anything naming what a piece is about. A feature by one of these names is refused, whatever its value.
const TOPIC_KEYS = /^(?:topic|topics|series|subject|angle|idea|theme|story|beat|category|lane|requested_topic|named_entities)$/i

export interface Engagement { reach: number; shares: number; saves: number }

export interface Piece {
  id: string
  /** When it went out, for the report's dates. */
  published_at: string | null
  narrative: number
  production: number
  basis: 'at_publish' | 'hindsight'
  features: Partial<Record<FeatureKey, string>>
  engagement: Engagement | null
}

/** The features of a piece, from what its making record says it used. Refuses any key that names a topic. */
export function featuresOf(raw: Record<string, unknown>): Partial<Record<FeatureKey, string>> {
  const out: Partial<Record<FeatureKey, string>> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (TOPIC_KEYS.test(k)) throw new Error(`retro: ${k} names what a piece is about, and the retrospective never ranks topics`)
    if (!(FEATURE_KEYS as readonly string[]).includes(k)) continue
    if (typeof v === 'string' && /^[a-z0-9][a-z0-9_]{0,59}$/.test(v)) out[k as FeatureKey] = v
  }
  return out
}

export interface FeatureStat {
  feature: FeatureKey
  value: string
  pieces: string[]
  narrative: number
  production: number
  /** Narrative and production together, out of 20. */
  score: number
  /** Shares and saves per reach, over the pieces whose engagement was read; null when none was. A hypothesis. */
  shares_per_reach: number | null
  saves_per_reach: number | null
  engaged: number
}

export interface Claim {
  verdict: 'scored_well' | 'scored_badly'
  feature: FeatureKey
  value: string
  text: string
  pieces: string[]
  numbers: { score: number; others: number; n: number; others_n: number; narrative: number; production: number }
  engagement: { shares_per_reach: number | null; saves_per_reach: number | null; engaged: number } | null
}

export interface Report {
  pieces: number
  scored: number
  engaged: number
  stats: FeatureStat[]
  claims: Claim[]
  /** Why there is no claim, or only one, when that is so. */
  held: string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function statOf(feature: FeatureKey, value: string, ps: Piece[]): FeatureStat {
  const engaged = ps.filter(p => p.engagement && p.engagement.reach > 0)
  const reach = engaged.reduce((a, p) => a + p.engagement!.reach, 0)
  return {
    feature, value, pieces: ps.map(p => p.id).sort(),
    narrative: r2(mean(ps.map(p => p.narrative))), production: r2(mean(ps.map(p => p.production))),
    score: r2(mean(ps.map(p => p.narrative + p.production))),
    shares_per_reach: reach ? r4(engaged.reduce((a, p) => a + p.engagement!.shares, 0) / reach) : null,
    saves_per_reach: reach ? r4(engaged.reduce((a, p) => a + p.engagement!.saves, 0) / reach) : null,
    engaged: engaged.length,
  }
}

const LABEL: Record<FeatureKey, string> = {
  opening: 'the opening', lead_picture: 'the lead picture', big_moment_sound: 'the big-moment sound', format: 'the format',
}

/**
 * The report, from the scored pieces. Pure and deterministic. A feature value is compared with the other scored pieces
 * that recorded the same feature, so a claim always says what it is better or worse than. The best and the worst are
 * picked by mean score, ties broken by more pieces, then by name; one feature value never makes both claims.
 */
export function retro(pieces: Piece[]): Report {
  const scored = pieces.filter(p => Number.isFinite(p.narrative) && Number.isFinite(p.production))
  const stats: FeatureStat[] = []
  for (const feature of FEATURE_KEYS) {
    const values = [...new Set(scored.map(p => p.features[feature]).filter((v): v is string => Boolean(v)))].sort()
    for (const value of values) stats.push(statOf(feature, value, scored.filter(p => p.features[feature] === value)))
  }
  const held: string[] = []
  // A value can only be compared when its feature has another value seen often enough too.
  const others = (s: FeatureStat) => scored.filter(p => p.features[s.feature] && p.features[s.feature] !== s.value)
  // Both sides of a comparison rest on RETRO_MIN_PIECES pieces or more.
  const comparable = scored.length < RETRO_MIN_PIECES * 2 ? []
    : stats.filter(s => s.pieces.length >= RETRO_MIN_PIECES && others(s).length >= RETRO_MIN_PIECES)
  if (scored.length < RETRO_MIN_PIECES * 2) held.push(`${scored.length} scored piece(s): too few to compare anything`)
  else if (!comparable.length) held.push(`no feature value is on ${RETRO_MIN_PIECES} or more scored pieces with ${RETRO_MIN_PIECES} or more beside it`)
  const order = [...comparable].sort((a, b) => b.score - a.score || b.pieces.length - a.pieces.length || `${a.feature}:${a.value}`.localeCompare(`${b.feature}:${b.value}`))
  const claims: Claim[] = []
  const claim = (s: FeatureStat, verdict: Claim['verdict']): Claim => {
    const rest = others(s)
    const restScore = r2(mean(rest.map(p => p.narrative + p.production)))
    const better = verdict === 'scored_well'
    const gap = r2(Math.abs(s.score - restScore))
    const eng = s.engaged ? ` Engagement, read for ${s.engaged} of them (a hypothesis until your own data confirms it): ${s.shares_per_reach} shares and ${s.saves_per_reach} saves per reach.` : ''
    return {
      verdict, feature: s.feature, value: s.value, pieces: s.pieces,
      numbers: { score: s.score, others: restScore, n: s.pieces.length, others_n: rest.length, narrative: s.narrative, production: s.production },
      engagement: s.engaged ? { shares_per_reach: s.shares_per_reach, saves_per_reach: s.saves_per_reach, engaged: s.engaged } : null,
      text: `${better ? 'Scored well' : 'Scored badly'}: ${LABEL[s.feature]} ${s.value}. Across the ${s.pieces.length} pieces you scored that used it, `
        + `narrative ${s.narrative} and production ${s.production} out of 10, ${s.score} of 20 together, ${gap} ${better ? 'above' : 'below'} the `
        + `${rest.length} scored piece(s) that used another ${LABEL[s.feature].replace(/^the /, '')} (${restScore}).${eng} `
        + `An association across ${s.pieces.length + rest.length} pieces, not a cause.`,
    }
  }
  const best = order[0]
  if (best && best.score > r2(mean(others(best).map(p => p.narrative + p.production)))) claims.push(claim(best, 'scored_well'))
  const worst = [...order].reverse().find(s => s !== best && !(s.feature === best?.feature && s.value === best?.value))
  if (worst && worst.score < r2(mean(others(worst).map(p => p.narrative + p.production)))) claims.push(claim(worst, 'scored_badly'))
  if (comparable.length && claims.length < 2) held.push(`only ${claims.length} feature value(s) differ from the pieces beside them`)
  return { pieces: pieces.length, scored: scored.length, engaged: scored.filter(p => p.engagement && p.engagement.reach > 0).length, stats, claims, held }
}

/** Whether a report is due: a month since the last one, or RETRO_EVERY newly scored pieces since. Pure. */
export function due(now: Date, last: Date | null, newlyScored: number): { due: boolean; why: string } {
  if (!last) return { due: newlyScored > 0, why: newlyScored > 0 ? 'first report' : 'no scored piece yet' }
  if (newlyScored >= RETRO_EVERY) return { due: true, why: `${newlyScored} newly scored pieces` }
  if (newlyScored > 0 && now.getTime() - last.getTime() >= RETRO_DAYS * 86_400_000) return { due: true, why: 'a month since the last report' }
  return { due: false, why: 'not yet due' }
}

// ---------------------------------------------------------------- the database

/** The scored pieces of the venture, with his latest score, the choices they recorded and, where read, engagement. */
export async function readPieces(db: Db): Promise<{ pieces: Piece[]; scoresMissing: boolean; engagementRead: boolean }> {
  const [reg] = await db.query<{ scores: boolean; engagement: boolean }>(
    `select to_regclass('public.piece_scores_current') is not null as scores, to_regclass('public.piece_engagement') is not null as engagement`,
  )
  if (!reg?.scores) return { pieces: [], scoresMissing: true, engagementRead: false }
  const engagementRead = Boolean(reg.engagement)
  // His latest score for each piece, whichever basis; only his (piece_scores_current holds only rows that count).
  const rows = await db.query<{ id: string; published_at: string | null; narrative: number; production: number; basis: Piece['basis']
    choices: Record<string, unknown> | null; format: unknown; reach: number | null; shares: number | null; saves: number | null }>(
    `select c.id::text, c.published_at::text, s.narrative, s.production, s.basis,
            c.meta->'making'->'production_choices' as choices, c.meta->'making'->'format' as format,
            ${engagementRead ? 'e.reach, e.shares, e.saves' : 'null::numeric as reach, null::numeric as shares, null::numeric as saves'}
     from (select distinct on (piece_id) piece_id, narrative, production, basis from public.piece_scores_current
           order by piece_id, scored_at desc) s
     join public.content_ideas c on c.id = s.piece_id
     ${engagementRead ? `left join (select piece_id, sum(reach)::float as reach, sum(shares)::float as shares, sum(saves)::float as saves
                                    from public.piece_engagement group by piece_id) e on e.piece_id = c.id` : ''}
     order by c.published_at nulls last, c.id`,
  )
  const pieces = rows.map(r => {
    const choices = r.choices && typeof r.choices === 'object' ? { ...r.choices } as Record<string, unknown> : {}
    delete choices.at
    return {
      id: r.id, published_at: r.published_at, narrative: Number(r.narrative), production: Number(r.production), basis: r.basis,
      features: featuresOf({ ...choices, ...(typeof r.format === 'string' ? { format: r.format } : {}) }),
      engagement: r.reach !== null ? { reach: Number(r.reach), shares: Number(r.shares ?? 0), saves: Number(r.saves ?? 0) } : null,
    }
  })
  return { pieces, scoresMissing: false, engagementRead }
}

/** When the last report was made, and how many pieces he has scored since. */
export async function sinceLast(db: Db): Promise<{ last: Date | null; newlyScored: number }> {
  const [row] = await db.query<{ last: string | null }>(
    `select max(started_at)::text as last from public.content_engine_runs where job = 'taste_retro' and status = 'ok'`,
  )
  const last = row?.last ? new Date(row.last) : null
  const [n] = await db.query<{ n: number }>(
    `select count(distinct piece_id)::int as n from public.piece_scores where counts and ($1::timestamptz is null or scored_at > $1)`,
    [last?.toISOString() ?? null],
  )
  return { last, newlyScored: Number(n?.n ?? 0) }
}

/**
 * Each claim to him as a proposal (mindmake_studio_learning_proposals), never a decision: a claim resting on his scores
 * is taste; one also resting on engagement for three or more pieces carries it as evidence. One batch per report day.
 */
export async function proposeRetro(db: Db, report: Report, now: Date, write: boolean): Promise<number> {
  if (!report.claims.length) return 0
  const batch = `retro-${now.toISOString().slice(0, 10)}`
  const [held] = await db.query<{ n: number }>(
    `select count(*)::int as n from public.mindmake_studio_learning_proposals where weekly_batch_id = $1 and scope->>'source' = 'retro'`, [batch],
  )
  if (Number(held?.n ?? 0) > 0 || !write) return write ? 0 : report.claims.length
  for (const c of report.claims) {
    await db.query(
      `insert into public.mindmake_studio_learning_proposals
         (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids, independent_session_count, independent_job_count,
          counterexamples, regression_cases, proposed_change)
       values ($1, 'taste', $2, $3::jsonb, $4::uuid[], $5, 0, '[]'::jsonb, $6::jsonb, $7::jsonb)`,
      [
        batch, c.text.slice(0, 1600),
        JSON.stringify({ key: `retro:${c.feature}:${c.value}`, level: 'global', source: 'retro', venture: RETRO_VENTURE,
          verdict: c.verdict, feature: c.feature, value: c.value, kind: 'form' }),
        c.pieces.slice(0, 100), c.pieces.length,
        JSON.stringify([{ pieces: c.pieces, numbers: c.numbers }]),
        JSON.stringify({ feature: c.feature, value: c.value, verdict: c.verdict, numbers: c.numbers, engagement: c.engagement }),
      ],
      { write: true },
    )
  }
  return report.claims.length
}
