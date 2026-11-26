import { hasDefectWords } from '../rejection/defects.ts'

// What a session report is: taste, or a problem that belongs to the internal auditor (Krish, 2026-11-26: "Anything
// that isn't a matter of taste or creative preference should go to the internal auditor").
//
// Sessions are told to send only preferences to report_to_taste_engine and defects to record_harness_observation
// (Ruling, Krish, 2026-11-23), but reports still arrive that are about how a session, an engine or a pipeline behaved:
// a token that is missing, an approval queue, a board that does not save, how to report an error. Those are not taste.
// This sort keeps them out of the ledger and files them where the auditor reads failures (content-engine's
// engine_incidents, counted in Control Center's engine_failures feed).
//
// Fixed rules, never a model (AGENTS.md rule 3). When in doubt a report stays taste: a report that names both a
// process and how something should look, read or feel is `mixed`, kept whole as taste and also filed as an incident,
// so neither half is lost. Only a report with process words and no word of judgement leaves the ledger.

/** Bump when a rule below changes what is sorted where. */
export const REPORT_SORT_REV = 'reports-2026-11-26'

export type ReportClass = 'taste' | 'mixed' | 'not_taste'

// How a session, engine, pipeline or app behaved: the auditor's subject, never taste on its own.
const PROCESS_WORDS = new RegExp([
  '\\btokens?\\b', '\\bsecrets?\\b', '\\bcredentials?\\b', 'api key', '\\bcron\\b', 'github actions?', '\\bci\\b',
  '\\bdeploy(?:s|ed|ment)?\\b', '\\bmigrations?\\b', 'typecheck', '\\btests? pass', 'node_modules', 'merge(?:d)? (?:it )?to main',
  'pull requests?', '\\bprs?\\b', '\\bbranch(?:es)?\\b', '\\bcommits?\\b', '\\bcodex\\b', 'cloud sessions?', 'this session',
  'stale code', 'history (?:scrub|rewrite)', '\\bapprovals?\\b', 'the engine (?:refuses|won.t|does not|doesn.t|is stuck)',
  'board state', 'edits? (?:get |are |is )?saved', '(?:not|never|doesn.t|does not|won.t) sav(?:e|ing)',
  '(?:don.t|doesn.t|do not|does not|won.t) (?:show|load|open|play) (?:correctly|properly|at all)', '\\bcrash(?:es|ed)?\\b',
  '\\bbugs?\\b', '\\btimed? ?out\\b', 'exact error', 'error in one line', 'command fails', 'if anything fails',
  '\\bpipelines?\\b', '\\bwebhooks?\\b', '\\bendpoints?\\b', '\\bdatabase\\b', 'google drive (?:hyper)?link', 'download it directly',
  '\\b[\\w./-]+\\.(?:md|ts|tsx|js|mjs|json|ya?ml|py|sql)\\b',
].join('|'), 'i')

// A session's own working notes pasted as his words: a code span, a build result. Never his judgement of a piece,
// whatever else they mention.
const SESSION_NOTE = /`[^`\n]+`|node_modules|typechecks?\b/i

// Words of judgement: how a thing should look, read, sound or feel. Any one keeps a report in the ledger.
const TASTE_WORDS = new RegExp([
  'look(?:s|ed|ing)?\\b', 'feel(?:s|ing)?\\b', 'felt', 'visuals?', 'design', 'fonts?', 'typograph', 'colou?rs?', 'tone', 'voice',
  '\\bcopy\\b', 'premium', 'tacky', 'boring', 'hilarious', 'funny', '\\bfun\\b', 'style', 'animat', 'brand', 'aesthetic',
  'layout', 'spacing', 'music', 'audio', 'sound', 'title', 'cover', 'thumbnail', 'hook', 'story', 'angle', 'ugly',
  'beautiful', 'love', '\\blikes?\\b', 'hate', 'awful', 'terrible', 'cheap', 'cramped', 'clutter', 'clean', 'elegant',
  'intuitive', 'stunning', 'epic', 'magic', 'warm', 'playful', 'serious', 'cringe', 'lame', 'obnoxious', 'component',
  'screen', 'image', 'picture', 'photo', 'video', 'headline', 'caption', 'wording', 'phrase', 'sentence', 'writing',
  'unprofessional', 'professional', 'polish', 'stable', 'consistent', 'inconsistent', 'loading experience',
].join('|'), 'i')

export const hasProcessWords = (text: string): boolean => PROCESS_WORDS.test(text)
export const isSessionNote = (text: string): boolean => SESSION_NOTE.test(text)
export const hasTasteWords = (text: string): boolean => TASTE_WORDS.test(text)

/** Where one report belongs. Pure: the same words always sort the same way. */
export function classOfReport(body: string): ReportClass {
  if (SESSION_NOTE.test(body)) return 'not_taste'
  const process = hasProcessWords(body)
  const taste = hasTasteWords(body)
  if (process && !taste) return 'not_taste'
  if (process || hasDefectWords(body)) return 'mixed'
  return 'taste'
}

/** The incident a report leaves for the auditor, keyed so a report is filed at most once. */
export const incidentRefOf = (reportId: string): string => `taste-report:${reportId}`
