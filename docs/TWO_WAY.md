# Two-way: how a session reads Krish's taste and reports back

Every session, in every repository, reads his approved taste and reports his preferences through two Control Center
tools. This page is the contract. The design record of how it was built is
[`history/2026-10-26-two-way.md`](history/2026-10-26-two-way.md).

## Read

`get_approved_taste`, before writing or designing for him. Give the repository (owner/name), and the venture when the
repository serves several. It returns that venture's approved form rules only. Empty means none yet: never invent
one.

## Report

`report_to_taste_engine`, for taste and creative preference only.

- **`krish_words`**: his exact words, copied verbatim from a message he typed, with `said_where` and `said_at`. Only
  these count toward a rule. Never tidy, shorten or paraphrase them.
- **`observation`**: anything else about his taste (a paraphrase, a quote someone else wrote down, how a piece did).
  Context only.

Pick the lane: `strategy` (what to make), `production` (how it looks and is cut), `visibility` (rooms and stages),
`voice` (how it is written and said). Name the subject (`idea:`, `card:` or `piece:`) when it is about one thing.

## What does not belong here

Anything that is not taste goes to the internal auditor through `record_harness_observation`:

- something broke, failed or misfired: a bug, a crash, a run that failed, a page that does not load or save
- how a session, engine or pipeline should behave: approvals, tokens, error reporting, branches, merges, deploys
- a session's own working notes: file paths, code, test results

| Report | Goes to |
|---|---|
| "The cover feels cheap, make it bolder" | taste, `krish_words` |
| "The captions are misaligned and the font is tacky" | taste, and an incident for the auditor (mixed) |
| "Stop asking me for approvals, just run it" | auditor, `record_harness_observation` |
| "If anything fails, give me the exact error in one line" | auditor, `record_harness_observation` |

The engine enforces the split. A report that is not taste never enters the ledger: its words go to content-engine's
`engine_incidents`, which the auditor reads (`src/collect/reportSort.ts`). The sort uses fixed rules and keeps a
report as taste whenever it also carries a judgement.

## What happens to a report

The daily run files each report once (`src/collect/sessionReports.ts`): his words become `krish_words` evidence under
the report's venture, an observation becomes context, and a use his words name for an idea or a card becomes a feedback
cue. A report from a repository with no venture is held, never filed under a guess. A report of his words without where
or when is refused.
