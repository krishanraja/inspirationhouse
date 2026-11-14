---
repo: krishanraja/inspirationhouse
product: Inspiration House (the taste ledger)
as_of: 2026-11-14
head: 6be5686
lifecycle: live
production_url: none
state_doc: README.md
history_log: now-notes/
truth_files: [docs/NORTH_STAR.md, README.md, AGENTS.md]
authority_order: [docs/NORTH_STAR.md, AGENTS.md, README.md]
steward: https://github.com/krishanraja/ai-harness/blob/main/docs/steward/RUNBOOK.md
---

# inspirationhouse: where it is right now

## What it is

The taste ledger. It turns what Krish saves and judges into a record of why he likes it, asks him to confirm the patterns, and gives the confirmed rules to the systems that write and produce for him (content-engine, ai-harness's `krish-voice` and `krish-design`, and every session through Control Center's `get_approved_taste`). Headless: it runs on GitHub Actions and keeps its state in the Mindmaker OS database. `README.md` has the stages; `AGENTS.md` has the rules.

## Who it is for and why it matters for Mindmake

Krish, and every writer and maker in the fleet: output gets closer to his taste each week only through rules he approved, keyed by venture.

## Where it is right now (as of 2026-11-14)

<!-- north-star-state {"week_of":"2026-11-09","week_target":null,"current":null,"current_as_of":null,"current_source":null,"urgency":4,"urgency_reason":"no North Star of its own yet; Krish sets one"} --> **North Star number: U4, not measured.** inspirationhouse has no North Star of its own yet (`docs/NORTH_STAR.md`); Krish sets one.

- closeout notes now fold into NOW.md on the default branch (.github/workflows/closeout-fold.yml runs the harness's own fold, after checking the hook is the ai-harness copy by sha256). (2026-11-14)
- The harness job sends one reading marker a week (event id `taste-ledger:<week>:reading`) after the week's repeats, also when the total is 0, so ai-harness can tell a real 0 from a week not yet read (`counts.reading_marker_sent`). (2026-11-14)
- `taste-harness` takes a clock input; a run Control Center's clock dispatches is recorded as trigger `cron` with `counts.clock` = `control-center` instead of manual (audit harness-8). (2026-11-14)
- A failed distil names each failed venture and why its answer was not data (refusal, max_tokens or unparsed), in the run's problem line and in `counts.distil_failures`. (2026-11-14)
- A test fails when the main database's project address appears in any tracked file other than `src/config.ts`, where it stays as the one allowed runtime default because no workflow supplies `SUPABASE_PROJECT_REF` (fleet audit I-01). (2026-11-14)
- The daily `harness` job measures the number ai-harness had never measured: corrections Krish had to give twice in one week, in one venture, counted by fixed vocabulary slug (`src/publish/repeats.ts`). It records counts and slugs only, and sends each repeat to ai-harness's observation ledger as one redacted envelope. An open harness pull request's branch is never reset again (the 5 Nov reset closed ai-harness #193 and was misread as a decline). (2026-11-13)
- The approved-taste files rendered for `krish-voice` and `krish-design` say how each rule was approved and who asked for this path, naming each rule's claim. (2026-11-13)
- The cues stage files the ideas gate's Improve press as a `future_piece` cue; the tagger sends a full-size image only when it fits the API's 5 MB limit and retries once with the Drive thumbnail on a 400. (2026-11-12)
- The daily collect reads the Drive folder Krish named on 7 Nov for voices he finds inspiring, filing each saved post as his action in the voice lane under Mindmake, so writers he admires can become proposed voice rules on his yes. (2026-11-07)
- Waves 2 and 3 are merged: every model call posts to Control Center's `meter_daily` as `inspirationhouse-<stage>`, the tagger cache, the chat backstop hook, the drop zone and the three-layer floor, the retro, and the live link tests. (2026-10-29)

## What changed recently

- 2026-11-14 This `NOW.md` written in the steward's schema, folding the ten closeout notes of 29 Oct to 14 Nov; closeout notes fold into it on main from now on.
- 2026-11-07 A Drive folder Krish named for voices he finds inspiring became a collect source.

## What is next and what is waiting on Krish

- Next (2026-11-14): write each session's closeout as now-notes/YYYY-MM-DD-<slug>.md with Status:, Next: and the North Star check line, and let the fold place it.
- Read the next failed `taste_weekly` run's `counts.distil_failures`; if it says `max_tokens`, split that venture's whys into two calls.
- Read the next `taste_harness` run: `repeat_envelopes_sent` above 0 and no problems (a 404 means `HARNESS_SYNC_TOKEN` cannot dispatch to ai-harness).
- When a workflow passes `SUPABASE_PROJECT_REF` from a repository variable, drop the default in `src/config.ts` and the test's allowance.
- Waiting on Krish: a North Star for this repository; `TASTE_REJECTIONS_CLOCK=on` and the first real rejections floor run (fleet decisions, batch 3).
- North Star check (2026-11-14): holds.
