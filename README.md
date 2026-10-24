# Inspiration House

The taste ledger. It turns what Krish saves and judges into a record of **why** he likes it, asks him to confirm the patterns, and gives the confirmed ones to the systems that write and produce for him, so their output gets closer to his taste every week.

It is headless: no UI of its own and nothing to host. It runs on GitHub Actions, keeps its state in the Mindmaker OS Supabase project, and is read by two consumers:

- **content-engine** reads approved claims while drafting and revising (never while judging or ranking).
- **ai-harness**'s `krish-voice` and `krish-design` skills read them from a file each, which arrives only by a pull request Krish merges (`pnpm engine harness`).
- **Control Center** shows the Inspiration page (one card per thing saved in Drive), and its Visibility scorer reads the cards he routed to "A room or stage to go for" as the kind of room he wants. An answer with that route counts as visibility-lane evidence here, whichever folder the card came from.

## How it works

| Stage | When | What |
|---|---|---|
| collect | daily | Reads, never writes, the places Krish's taste already lands: content-engine's taste files (learnings, title verdicts, golden and rejected lines, style references), idea triage, visibility decisions, creator moves, drive-scan's artifacts, the What I like sheet, both Drive folders, the Instagram workbook in Cold Ideas (each post as an observation, each theme as a machine inference; context, never proof), and his answers on the Inspiration page. |
| tag | daily | Gives each Drive item a card: a thumbnail, guessed tags, guessed one-tap answers, and facets (platform, format, source, creator, people, organisations, topics), with what the file name proves kept as fact (`src/tag/hints.ts`). A video is watched: eight frames spread across it and its words transcribed on the runner (`src/tag/watch.ts`, ffmpeg and faster-whisper), the words kept on the card. Whether the words were heard (`words`, `silent`, `too_big` for a file over the 150 MB fetch cap, or `failed` with its class) is kept on the card's facets with its tries. A run in which a try fails is a failed run; an unheard video is tried again on the next run, up to three tries (`HEAR_TRIES`), and a try on a card already tagged only writes the hearing, with no model call, unless it heard words. Tagging starts no new card after 25 minutes, so explaining and the run's record always run. A card tagged under an older revision (`TAG_PROMPT_REV`) is tagged again. A guess stays a guess until he answers. |
| explain | daily | Turns each piece of his evidence into one to three candidate whys, each tagged form (craft) or subject. |
| distil | weekly | Groups whys into claims. The model drafts; code checks every citation; the database counts the support. |
| propose | weekly | Puts at most three claims a week to Krish through the existing learning-proposals door. He decides; the engine never does. |
| harness | daily | Renders the approved form rules into `skills/krish-voice/references/approved-taste.md` and `skills/krish-design/references/approved-taste.md` and, when they differ from ai-harness `main`, opens or refreshes one pull request there (branch `taste/approved-rules`). Nothing reaches those skills until Krish merges it (Ruling, Krish, 2026-10-24: rules arrive by PR). |
| score | weekly | Computes the scoreboard. The moat metric is corrections per published piece: lower means the output needed him less. |

## Rules it keeps

- **Never writes to Drive.** Google scopes are read-only, checked in CI.
- **His words are his.** A claim can quote him only verbatim, enforced by the database. A tapped suggestion is recorded as his endorsement, never as his words.
- **Taste shapes form, never subject** (anti-echo). Readers only see `taste_profile_form`.
- **A model answer is read here, never by the SDK.** The API never receives a schema's length or count limits, so an answer that runs over one is repaired and counted (`src/repair.ts`), never thrown away; an answer that is the wrong shape still fails that one item.
- **Numbers are computed, never emitted by a model.** Support, confidence and every score come from SQL.
- **Silence is not feedback.** An unanswered proposal stays proposed, and a quiet week scores as no reading, never zero.
- **This repository is public.** Nothing Krish said is committed or logged; logs carry counts only (`src/log.ts`). Fixtures are synthetic.

## The schema

`supabase/migrations/20261104090000_taste_ledger.sql` lives in **content-engine**, which owns content DDL, and is applied with the Supabase MCP `apply_migration`, never `db push`.

## Running it

```bash
pnpm install
pnpm test && pnpm typecheck
pnpm engine daily --dry-run --preview    # read-only; a readable preview goes to preview/, which is gitignored
pnpm engine weekly --dry-run --preview
```

A dry run refuses every write. Without `DATABASE_URL` it reads through the Supabase Management API (`SUPABASE_ACCESS_TOKEN`).

## Turning it on

1. Apply the taste ledger migration (content-engine PR).
2. Add repository secrets: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `HARNESS_SYNC_TOKEN` (a fine-grained token with contents and pull request write on `krishanraja/ai-harness` only), and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` holding the service account's whole JSON key file (or the bare PEM, with `GOOGLE_SERVICE_ACCOUNT_EMAIL` beside it). Share both Drive folders and the What I like sheet with the service account as Viewer.
3. Run each workflow once by hand with `dry_run` on and `use_model` off: it proves every source is reachable and costs nothing. Then run it with both off for the first real run, and `use_model` on when it should tag and explain.
4. Set the repository variable `TASTE_ENABLED` to `true`. Until then the schedules do nothing.

Runs are recorded in `content_engine_runs` as `taste_daily` and `taste_weekly`, where Control Center's done-check reads them.

Karakeep, the bookmark app this repository was first rebuilt from, is preserved in history at commit `cb395e1`.
