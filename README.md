# Taste engine (Inspiration House)

The ledger of Krish's taste. It keeps what he likes and dislikes, in his own words, works out why, and puts the
patterns to him as rules. Only the rules he approves reach the systems that write and make things for him. Each
venture keeps its own taste.

It holds **taste and creative preference only**: how a piece, a page, a voice or an idea should look, read, sound or
feel. Problems go to the internal auditor (below).

## Post to it

From any session, through the Control Center connector:

| What you have | Where it goes |
|---|---|
| His exact typed words about voice, design, a piece or an idea | `report_to_taste_engine`, kind `krish_words`, with `said_where` and `said_at` |
| Anything else about his taste (a paraphrase, what you noticed, how a piece did) | `report_to_taste_engine`, kind `observation`. Context only; it never counts toward a rule |
| A bug, a defect, a broken run, a missing token, an approval queue, how a session should behave | **Not here.** `record_harness_observation`, which the internal auditor reads |

The contract, with examples: [`docs/TWO_WAY.md`](docs/TWO_WAY.md).

The engine also enforces this split. Every report is sorted by fixed rules (`src/collect/reportSort.ts`):

- **Taste** becomes evidence.
- **Not taste** never enters the ledger. It is a report about how a session, an engine or a pipeline behaved, or a
  session's own working notes. His words are filed as an incident for the auditor.
- **Mixed** names a problem and a judgement. It is kept whole as taste and also filed for the auditor, so neither half
  is lost.

The incidents land in content-engine's `engine_incidents`, which the internal auditor reads through Control Center's
`engine_failures` feed. The Rejections side applies the same rule to defects (`src/rejection/defects.ts`; Ruling,
Krish, 2026-11-23).

## Read from it

| Reader | How |
|---|---|
| Any session, in any repository | `get_approved_taste` with the repository (and the venture, from a repository that serves several). Form rules only; empty means none yet |
| content-engine | Reads approved claims while drafting and revising, never while judging |
| ai-harness `krish-voice` and `krish-design` | `approved-taste.md` files, delivered by a pull request Krish merges (`pnpm engine harness`) |
| Make Your Mind Up's makers | The production floor: `config/rejection-floor.json` in content-engine, from the Rejections engine |

A rule exists only once Krish approves or rewords it. Nothing here decides for him.

## What it holds

1. **His words, whole.** Everything he typed, kept as written (`taste_evidence`).
2. **Signals.** His words as countable tags from a fixed vocabulary (`src/signal/vocab.ts`, `taste_signals`).
3. **Claims.** Whys grouped into rules a writer could apply tomorrow. At most three a week go to him as proposals.

The ceiling is what he saves and likes. The floor is what he rejected (`src/rejection/`).

## Run it

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm engine daily --dry-run --preview       # read only; the preview goes to preview/, which is gitignored
pnpm engine weekly --dry-run --preview
pnpm engine rejections --dry-run --preview
```

A dry run refuses every write. In a cloud session, route Node through the proxy:
`NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<the proxy's CA bundle> pnpm engine daily --dry-run`.

Runs happen on GitHub Actions, started by Control Center's clock, and are recorded in content-engine's
`content_engine_runs` (`taste_daily`, `taste_weekly`, `taste_harness`, `taste_cards`, `taste_rejections`). The tables
live in content-engine and change only by its migrations.

## Where the rest is

- [`AGENTS.md`](AGENTS.md): the rules every change keeps.
- [`NOW.md`](NOW.md): where it is right now.
- [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md): every stage in detail, the schema, setup and the backstop.
- [`docs/history/`](docs/history/): design records and older status, kept for reference.

The repository is public. Nothing Krish said is committed or logged; logs carry counts only.
