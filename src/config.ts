import { z } from 'zod'

// Names only. Values come from the environment (GitHub Actions secrets in
// production) and are never logged, written to a file, or put in a prompt.
const Env = z.object({
  // Postgres connection for scheduled runs (one project's database).
  DATABASE_URL: z.string().optional(),
  // Supabase Management API SQL endpoint, used for local dry runs. A session
  // proxy may inject the credential, so the token is optional.
  SUPABASE_ACCESS_TOKEN: z.string().optional(),
  SUPABASE_PROJECT_REF: z.string().regex(/^[a-z]{20}$/).default('gojpffsrxybbpbdzzrvs'),
  SUPABASE_API_URL: z.url().default('https://api.supabase.com'),

  ANTHROPIC_API_KEY: z.string().optional(),
  // Control Center's SYNTHESIS_MODEL tier (api/_models.ts): judgment surfaces a
  // human reads. Change it there first, then here.
  TASTE_MODEL: z.string().default('claude-sonnet-5'),

  CONTENT_ENGINE_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('krishanraja/content-engine'),
  CONTENT_ENGINE_REF: z.string().default('main'),
  CONTENT_ENGINE_READ_TOKEN: z.string().optional(),

  // The harness the approved taste rules are proposed to, by pull request
  // (src/publish/harness.ts). The token needs contents and pull request write
  // on that one repository and nothing else.
  HARNESS_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('krishanraja/ai-harness'),
  HARNESS_SYNC_TOKEN: z.string().optional(),

  // Google service account with read-only scopes. Both folders and the sheet
  // are shared with it as Viewer. The key may be the bare PEM, or the whole
  // JSON key file Google downloads, in which case the email comes from it.
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
})

export type Config = z.infer<typeof Env>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env)
}

// The two Drive folders Krish drops things into, and the sheet where he says
// what he likes about a video. Fixed ids, not secrets.
// Since 2026-10-24 both sit in Ventures > Inspiration (Krish: "one for the content I like ... and one for production
// quality I like. Can you ensure absolutely everywhere recalibrates to this moving forward first?"):
// coldIdeas is Content Inspo (the same folder, renamed from Cold Ideas & Inspo), videoInspiration is Production Inspo
// (the clips of the old Video Engine > Inspiration, whose ID is gone). The keys and the folder values
// ('cold_ideas', 'video_inspiration') stay, because inspiration_items and content-watcher's media carry them.
export const DRIVE = {
  coldIdeas: '1FNztJOU82M8zb6IIbUAbvuI6Kr0pF5Hu',
  videoInspiration: '1QxrzxISYFXq0er0DG0XSapm7qhvuRmh-',
  // Now in Content Inspo; it is read as a sheet, never made a card, whichever folder holds it.
  whatILikeSheet: '1_XBxxMUcU4CFHB5iJqWc1WtYKmJCftMOe5UlZYSM-_U',
  // An uploaded Excel workbook in Cold Ideas: the posts of the Instagram
  // accounts he follows for strategy, captured one row per post.
  instagramInspo: '1KawZr2R3Bi1zWJ1F2rPeGdBeVkc1gQTD',
} as const

// Read-only, and nothing else. CI fails if a write scope appears in the repo.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
] as const

// At most this many claims go to Krish in one week.
export const WEEKLY_PROPOSAL_CAP = 3
