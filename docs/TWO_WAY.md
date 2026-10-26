# Two-way: every repository reads Krish's taste and reports back

Handover for the build, written 2026-10-26 by the session that ran the audit. Krish, 2026-10-26: "start the two-way
build in a fresh session". This file is the whole brief: read it, then `README.md` and `AGENTS.md`, then each
repository's own `AGENTS.md` before you change it.

## What he asked, and the answer the audit gave

He asked which repositories can work with the inspiration engine both ways: read what he likes, and tell the engine
something back. An audit across the fleet (2026-10-24, each reading checked by a skeptic) found that no session in any
repository could do both. The state it found, corrected for what has landed since:

| Repository | Reads his taste today | Tells the engine anything back | The missing direction that matters most |
|---|---|---|---|
| control-center | The cards, the Inspiration tab's Ask, the Visibility scorer | Only his own presses on the Inspiration page (browser only since PR 553) | **Read.** Its writers (emails in his name, clip scripts, growth drafts) never see his approved rules |
| content-engine | Drafting reads approved rules (`apps/control-plane/api/_taste.ts`); the Sunday gather reads cards, readings, creator moves, claims and feedback cues | Only "taken" on a card; feedback cues come the other way (below) | **Write.** Which piece each card became, and whether it published and how it did |
| ai-harness | The voice and design skills read `approved-taste.md`, rendered here (`src/publish/harness.ts`) | Nothing: his voice and design corrections stop in its own notes | **Write.** Those corrections should reach the engine |
| content-watcher | Nothing; it feeds the engine | Links become readings (`content_reads`) through content-engine's watch routes | Built by its own session |
| AEO-Engine, growth-mindmake, growth-makeyourmindup | Nothing | Nothing | **Read.** His approved voice rules for what they draft |
| makeyourmindup, contentarchives | Nothing | Nothing | Little or nothing needed |

## The design (reported to Krish, not objected to; his go on 2026-10-26)

- **The procedure lives in one place: this repository.** No other repository keeps a copy of how taste works.
- **Every repository learns it from two Control Center tools**, so any session with the Control Center connector sees
  them in any repository: one reads his approved taste, one reports something back. Build them on Control Center's
  existing connector and house systems (its `AGENTS.md`, "House systems: extend, never fork"); never a new server.
- **One line in the canon** (krishanraja/ai-harness, the Krish canon block every repository's instructions copy) tells
  sessions to use the two tools. The canon changes only through ai-harness's own release process.
- **Code that runs without a session** gets his taste through the doors it already uses (content-engine drafting
  already reads `taste_profile_form`; a growth engine through its existing directive). No new door per repository.
- **Judges and scorers never read taste** (content-engine `scripts/check-judges.ts` guards it). Keep it so.
- **Only Krish answers a card or approves a rule.** The read tool returns approved rules only
  (`taste_profile_form`, form only, never subject: anti-echo).

## Rulings that settle the open questions (do not ask them again)

- **His exact typed words are his.** Krish, 2026-10-24: "exact typed quotes count as my opinions on what I think you
  should do with that content". So the report tool takes two kinds of report, never mixed:
  - his exact words, quoted verbatim from a message he typed, with where and when he typed them: stored as his words;
  - anything else (a paraphrase, a summary, what a session noticed, how a piece performed): stored as an
    `observation`, which is context only and never counts toward a claim (`AGENTS.md` rule 4).
- **Check before you ask.** A question his feedback already answers is not asked (content-engine `AGENTS.md`).
- **The Inspiration page holds only what he put there.** A link a session finds goes nowhere near his page and counts
  for nothing. A session never answers a card, never writes `answered_by` Krish, never approves or rewords a rule.

## What landed since the audit (build on these, never beside them)

- **Feedback cues** (another session, 2026-10-26; inspirationhouse PR 11, content-engine PR 175). Table
  `feedback_cues` (content-engine migration `20261111090000_feedback_cues.sql`, live, no rows yet). This repository's
  daily `cues` stage (`src/collect/feedbackCues.ts`) turns his decisions on ideas and his card answers into cues for
  future pieces; the Sunday gather reads open cues. It is already one path back into the engine: the report tool must
  feed or extend it where the fact is the same, never start a second home for the same fact.
- **Approved rules hold** (inspirationhouse PR 12, content-engine PR 176, migration
  `20261112090000_taste_quote_holds.sql`, live): a claim put to him is never rewritten, and a quote of his words is
  shown only while the answer it quotes stands. Every new reader of `taste_claims.krish` must gate the same way, or
  read `taste_profile_current` / `taste_profile_form`, which already do.
- **Control Center writes on the Inspiration route come only from his browser** (`hasBrowserSession`, PR 553). The
  report tool is a different route with session attribution; it must never be able to write as Krish.
- **Approved rules today: none.** `taste_profile_current` has 0 rows (22 claims, 3 put to him and waiting). The read
  tool must return an empty, well-formed answer and say so, never invent a rule.
- **The Anthropic API is at its usage limit until 2026-11-01.** Model calls fail. Nothing in this build should need one;
  never verify by a paid call without Krish's yes.

## What to build, in order

1. **The report tool and its store** (this repository's procedure, content-engine's migration for any table, Control
   Center's connector for the tool). Decide the shape from the rulings above. Reuse `feedback_cues` or
   `taste_evidence` where the fact already has a home; a session's report carries the session, the repository and
   when. Test that an observation never changes a claim's support and that his exact words are stored only with where
   and when he typed them.
2. **The read tool**: approved form rules, with their lane and his words where a quote stands. Empty is a valid
   answer.
3. **content-engine writes back** which piece a card became and whether it published (the making record already
   knows), through the report path or an existing door.
4. **ai-harness**: his voice and design corrections reach the engine through the report tool; the canon line.
5. **Control Center's writers** (email drafts in his name, clip scripts, growth drafts) read the approved rules through
   the read path, inside its house systems.
6. **AEO-Engine and the growth engines** read approved voice rules through the doors they already use.

Each step is its own pull request in its own repository, reviewed by fresh readers before merge, with CI green. Read
each repository's rules on merging (content-engine has no required checks: wait for green, then merge). Record any
ruling in the commit body as `Ruling (Krish, YYYY-MM-DD): ...`, and update that repository's `NOW.md`.

## Walls

- Nothing sends, publishes, spends, deletes or changes a permission without Krish's yes immediately before it. A new
  secret, token or connector permission is his to approve.
- No Claude artifact; no scheduled task that builds a publish board.
- This repository is public: synthetic fixtures, logs carry counts only.

## Done means

From a session in another repository with the Control Center connector: the read tool returns the approved rules
(empty today, and a synthetic approved rule in a test database proves the shape); a report of his exact words and a
report of an observation both land, labelled as what they are; an observation changes no claim; content-engine records
which piece a card became. Each proved by a test that fails without the change and by a live read-back.

## Progress

- **Step 1, the report tool and its store (2026-10-26).** content-engine `20261113090000_taste_reports.sql` (the inbox
  `taste_reports`, and the source `session_report` on `taste_evidence` and `feedback_cues`); this repository's daily
  `reports` stage (`src/collect/sessionReports.ts`), which files his words as `krish_words` and everything else as an
  `observation`; Control Center's `report_to_taste_engine` on the account connector (`api/harness/_taste-mcp.ts`).
  Proved by `test/pipeline.int.test.ts` ("what sessions in other repositories report"), which fails without the
  migration: an observation never changes a claim's support, and his words are kept only with where and when.
  Known gap, left for a follow-up: a cue made from a report stays open when his later verdict on the same idea
  contradicts it (the cues stage supersedes only within the queue and card threads it reads).
