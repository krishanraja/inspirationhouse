---
repo: krishanraja/inspirationhouse
product: Inspiration House (the taste ledger)
as_of: 2026-11-17
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

## Where it is right now (as of 2026-11-17)

<!-- north-star-state {"week_of":"2026-11-09","week_target":null,"current":null,"current_as_of":null,"current_source":null,"urgency":4,"urgency_reason":"no North Star of its own yet; Krish sets one"} --> **North Star number: U4, not measured.** inspirationhouse has no North Star of its own yet (`docs/NORTH_STAR.md`); Krish sets one.

- A tag answer that cannot be read now says where it broke (field names only, never its words), so the two cards that fail every run name their cause in the run's reason. (2026-11-17)
- The tagger reads no file in a reference set (facets.collection, such as the VEED thumbnail study) unless Krish wrote on it, so the daily run spends its model calls on his own drops; content-engine finds the set by its folder. (2026-11-17)
- The tagger writes `thumbnail` into content-engine's teaches column now that its migration 20261205090000 is applied (2026-11-17), so his thumbnail study set reaches content-engine's thumbnail references by role. (2026-11-17)
- the tagger (tag-v4) reads each card's own words (why_here, would_do, a typed why_like) as the ground truth of its reading and records which it stood on (facets.grounded_in); every reading picks only from content-engine's own style ids (caption themes, motion styles, transitions, camera, energy, script and production formats, series, roles) into facets.style as engine_read, and writes the roles content-engine's teaches column takes as engine_guess, never over his; a subfolder's files carry facets.collection, a tool's checksum, log or collection JSON is no card, and cards are tagged by value (his words, loose videos, loose images and documents, collections last) inside the unchanged caps. (2026-11-17)
- the branch sweep takes an approved list (branch@sha) on a hand run and deletes each named branch only at that exact commit, skipping and logging anything else; the weekly run is unchanged. Copied from ai-harness's canonical script and workflow. (2026-11-15)
- A weekly branch sweep (`.github/workflows/branch-sweep.yml`, Sunday 03:17 UTC, and by hand) deletes every remote branch whose work is already on main and lists each branch it keeps with why: unmerged work, an open pull request, protected (Ruling, Krish, 2026-11-15). The script is `.github/scripts/branch_sweep.py`, copied unchanged from ai-harness, which holds the canonical copy. (2026-11-15)
- the rejections engine's floor file now carries a top-level `groups` list: every group of standards Krish approved or reworded, with the words he decided for the whole group (his latest amendment in content-engine's `taste_floor_group_amendments` once that table exists, else his correction, else the group's never_beneath), its standing, decided_on and members by the file's standard keys. Until today no maker read a group's own words. (2026-11-15)
- the rejections engine reads Krish's decisions on groups of floor standards (content-engine `taste_floor_groups`): a standard he decided through its group is never rewritten, superseded or put to him again, and each run brings back any member of a group he approved or reworded that the engine superseded, with the check he was shown (`src/rejection/groups.ts`). The hand run of 2026-11-15 05:47 UTC had superseded 36 approved standards and rewritten 95 approved checks, so its floor pull request (content-engine #707, closed unmerged) dropped them; a read-only count of live data shows the next run brings back exactly those 36 and those 95. (2026-11-15)
- the daily run reads content-engine's chain cap verdict (job `chain_cap` in `content_engine_runs`, written by its 03:00 UTC triage sweep) and skips its tagging while this week's newest verdict is `skipped` and names `skip_inspirationhouse_tag` (Ruling, Krish, 2026-11-14: the chain cap as proposed, approved as written); no verdict, a failed one or an unreadable ledger skips nothing. (2026-11-14)
- the rejections engine reads Krish's rulings on the floor's wording from content-engine `config/floor-rulings.json` through the GitHub API and applies each to the line it names before it renders `config/rejection-floor.json`, so its floor pull requests carry "two to five" words a caption page (Ruling, Krish, 2026-11-14), matching content-engine #701; a new wording on a ruled record fails the run and waits on him, and a failed read proposes nothing. (2026-11-14)
- the weekly distil reads a venture whose answer is cut off at max_tokens again as two halves, cut between items, each shown the claims already drafted, until a half would fall under 12 whys; a claim both halves draft is written once on the evidence of both. Heartside's answer was cut off on 7 and 14 Nov (`counts.distil_failures` heartside:max_tokens), which failed `taste_weekly` both weeks. (2026-11-14)
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

- Next (2026-11-17): Read the next taste_daily run's reason and fix the field it names.
- Read the next failed `taste_weekly` run's `counts.distil_failures`; if it says `max_tokens`, split that venture's whys into two calls.
- Read the next `taste_harness` run: `repeat_envelopes_sent` above 0 and no problems (a 404 means `HARNESS_SYNC_TOKEN` cannot dispatch to ai-harness).
- When a workflow passes `SUPABASE_PROJECT_REF` from a repository variable, drop the default in `src/config.ts` and the test's allowance.
- Waiting on Krish: a North Star for this repository; `TASTE_REJECTIONS_CLOCK=on` and the first real rejections floor run (fleet decisions, batch 3).
- North Star check (2026-11-17): holds.
