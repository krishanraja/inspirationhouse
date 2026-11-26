---
repo: krishanraja/inspirationhouse
product: Inspiration House (the taste ledger)
as_of: 2026-11-26
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

## Where it is right now (as of 2026-11-26)

<!-- north-star-state {"week_of":"2026-11-23","week_target":null,"current":null,"current_as_of":null,"current_source":null,"urgency":4,"urgency_reason":"no North Star of its own yet; Krish sets one"} --> **North Star number: U4, not measured.** inspirationhouse has no North Star of its own yet (`docs/NORTH_STAR.md`); Krish sets one.

- Only taste enters the ledger. Every report a session sends through `report_to_taste_engine` is sorted by fixed rules (`src/collect/reportSort.ts`): one about how a session, engine or pipeline behaved, or a session's own notes, never becomes taste, and his words go to content-engine's `engine_incidents`, where the internal auditor reads them; one that names a problem and a judgement stays taste and is filed for the auditor too. Reports filed earlier are sorted the same way on the next daily run. A live dry run on 2026-11-26 read 677 reports: 19 leave taste (18 filed earlier), 64 stay as mixed. (2026-11-26)
- The README says in one page how to post and how to read; `docs/TWO_WAY.md` is the posting contract with examples; the full stage detail is `docs/HOW_IT_WORKS.md`; design records and the old status log are in `docs/history/`. (2026-11-26)
- Defects leave the Rejections floor: on 2026-11-23 its run moved 109 records to content-engine's `engine_incidents` and logged 14 mixed ones there while keeping them as taste (Ruling, Krish, 2026-11-23: the taste system holds only preference and inspiration).
- The daily, weekly, harness, cards and rejections jobs run on GitHub Actions, dispatched by Control Center's clock; their own cron schedules stay off while `TASTE_ENABLED` is unset. The last daily run (2026-11-25 05:17 UTC) succeeded.
- Every reader of taste evidence skips rows marked reference material and withdrawn rows; the tagger reads each card's own words first and picks only from content-engine's style ids.

## What changed recently

- 2026-11-26 Krish asked that the ledger hold only taste and that anything else go to the internal auditor; session reports are now sorted on arrival and the docs were cut to what a reader needs.
- 2026-11-23 Krish ruled that the taste system holds only preference and inspiration.
- 2026-11-14 This `NOW.md` written in the steward's schema; closeout notes fold into it on main.

## What is next and what is waiting on Krish

- Next (2026-11-26): Read the next `taste_daily` run's counts: `reports_withdrawn_not_taste` 18, `reports_resort_incidents_filed` 55 and `reports_incidents_filed` 11 (as of 2026-11-26), then 0 re-sorted on the run after.
- Read the next failed `taste_weekly` run's `counts.distil_failures`; if it says `max_tokens`, split that venture's whys into two calls.
- When a workflow passes `SUPABASE_PROJECT_REF` from a repository variable, drop the default in `src/config.ts` and the test's allowance.
- Waiting on Krish: a North Star for this repository; `TASTE_REJECTIONS_CLOCK=on` for the rejections floor's daily run.
- North Star check (2026-11-26): holds.
