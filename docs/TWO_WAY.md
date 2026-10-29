# Two-way: every repository reads Krish's taste and reports back

Status: Built. All six steps landed on 2026-10-26; Progress, at the end, says what each one is and how it was proved. This file is kept as the design record. Everything before Progress is the original brief: it is in the future tense and describes the world on 2026-10-26, not now.

Changed on 2026-10-28: the read is per venture, no longer shared. Every repository still reads and reports through the same two tools, but it reads only its own venture's approved rules, and what it reports is filed under its own venture. The last entries in Progress say how; Control Center's half landed the same day (commit c705983 on its main).

Last verified: 2026-10-28 against this repository's code, Control Center's main (commit c705983, `api/harness/_taste-mcp.ts`) and a read-only read of the live database: every migration this engine reads is applied, through `taste_ventures`; `feedback_cues` holds 15 rows, all Make Your Mind Up's (`publication`); `taste_reports` holds 16 (12 Make Your Mind Up's, 4 Heartside's); approved rules are still none (`taste_profile_current` 0 rows; 36 taste proposals wait on him, among them 3 of the 22 claims and 30 floor standards). The pull requests cited in other repositories were not re-read.

Handover for the build, written 2026-10-26 by the session that ran the audit. Krish, 2026-10-26: "start the two-way
build in a fresh session". This file is the whole brief: read it, then `README.md` and `AGENTS.md`, then each
repository's own `AGENTS.md` before you change it.

## What he asked, and the answer the audit gave

He asked which repositories can work with the inspiration engine both ways: read what he likes, and tell the engine
something back. An audit across the fleet (2026-10-24, each reading checked by a skeptic) found that no session in any
repository could do both. The state it found, corrected on 2026-10-26 for what had landed by then and before any of steps 1 to 6 below:

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
  `feedback_cues` (content-engine migration `20261111090000_feedback_cues.sql`, live; no rows then, 15 on 2026-10-28).
  This repository's daily `cues` stage (`src/collect/feedbackCues.ts`) turns his decisions on ideas and his card answers into cues for
  future pieces; the Sunday gather reads open cues. It is already one path back into the engine: the report tool must
  feed or extend it where the fact is the same, never start a second home for the same fact.
- **Approved rules hold** (inspirationhouse PR 12, content-engine PR 176, migration
  `20261112090000_taste_quote_holds.sql`, live): a claim put to him is never rewritten, and a quote of his words is
  shown only while the answer it quotes stands. Every new reader of `taste_claims.krish` must gate the same way, or
  read `taste_profile_current` / `taste_profile_form`, which already do.
- **Control Center writes on the Inspiration route come only from his browser** (`hasBrowserSession`, PR 553). The
  report tool is a different route with session attribution; it must never be able to write as Krish.
- **Approved rules on 2026-10-26: none.** `taste_profile_current` had 0 rows (22 claims, 3 put to him and waiting). The read
  tool must return an empty, well-formed answer and say so, never invent a rule.

## What to build, in order (the original plan; all six are done, see Progress)

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
which piece a card became. Each proved by a test that fails without the change and by a live read-back. Progress records the tests for each step; a live read-back from a session in another repository is not recorded here.

## Progress

- **Step 1, the report tool and its store (2026-10-26).** content-engine `20261113090000_taste_reports.sql` (the inbox
  `taste_reports`, and the source `session_report` on `taste_evidence` and `feedback_cues`); this repository's daily
  `reports` stage (`src/collect/sessionReports.ts`), which files his words as `krish_words` and everything else as an
  `observation`; Control Center's `report_to_taste_engine` on the account connector (`api/harness/_taste-mcp.ts`).
  Proved by `test/pipeline.int.test.ts` ("what sessions in other repositories report"), which fails without the
  migration: an observation never changes a claim's support, and his words are kept only with where and when.
  Known gap, left for a follow-up: a cue made from a report stays open when his later verdict on the same idea
  contradicts it (the cues stage supersedes only within the queue and card threads it reads).
- **Step 2, the read tool (2026-10-26).** Control Center's `get_approved_taste` on the account connector
  (`api/harness/_taste-mcp.ts`, PR 559) reads `taste_profile_form` by lane: only rules Krish approved or reworded,
  form only, his quote only while the answer it quotes stands. It says which words are his and which the engine
  wrote, and an empty list says none is approved yet and not to invent one. Proved by `tests/api/tasteMcp.test.ts`.
- **Step 3, which piece a card became (2026-10-26).** content-engine keeps a Sunday option's `covers` on the piece
  (`meta.covers`) and adds the view `inspiration_card_pieces` (`20261114090000`): each card's piece, `krish` (he named
  it) or `plan` (a picked piece whose option covered it), and whether it published. Proved by
  `test/pipeline.int.test.ts` ("which piece each card became").
- **Step 4, ai-harness (2026-10-26).** The canon block's Taste line (PR 165): where the connector offers them,
  read approved rules before writing or designing; send his exact typed corrections to `report_to_taste_engine`
  with where and when, and anything else only as an observation. Ruling (Krish, 2026-10-26): "reports to my taste
  ledger are exempt from the approval wall". `krish-voice` and `krish-design` carry the same, with their copies as
  the fallback without the connector. Proved by `scripts/test-canon-sync.mjs`. A repository receives the Taste line only when its rendered canon block is next synced to a release that carries it (ai-harness's own block does, at release v2026.10.26.1); the release stamp is at the top of the canon block in each repository's `AGENTS.md`.
- **Step 5, Control Center writers (2026-10-26).** Every writer (the email drafts in his name, video and clip
  scripts, growth stall drafts) reads approved voice rules after the voice block, through `api/_voice.ts` and
  `api/_content.ts` (PR 560). No judge or scorer may read them (`tests/api/approvedTaste.test.ts`).
- **Step 6, the engines (2026-10-26).** Control Center's growth directive carries `taste` from protocol 1.5.0
  (PR 561): approved voice rules, an empty list until he approves one, never used to judge. growth-mindmake (PR 9)
  and growth-makeyourmindup (PR 12) draft with them; AEO-Engine (PR 24) adds a wording-only voice step that runs
  only when at least one rule is approved, about $0.03 a subject, and keeps the rules out of its judging digest.
  Each engine's tests prove the rules reach drafting and never a score.
- **After the two-way build: signals (2026-10-27).** Every report of his words is `krish_words` evidence, so the daily
  `signals` stage (`src/signal/extract.ts`, content-engine `20261115090000_taste_signals.sql`) breaks it into countable
  tags like any other answer of his, with where it was said kept in its context. A report never needs a new path to
  count: filing it as evidence is enough. Proved by `test/pipeline.int.test.ts` ("his answers as countable taste
  signals"), which runs once the migration is listed.
- **The ledger keyed by venture (2026-10-28).** Krish, 2026-10-28: "each repository builds its own taste ledger and
  reads from its own taste ledger, and not the central makeyourmindup one", and "The ledger is keyed by venture not
  repository. Makeyourmindup as a separate venture to mindmake". Until then every reader read the whole ledger, so a
  Heartside session's report counted in Make Your Mind Up's patterns and floor. Now the read is per venture, not
  shared: content-engine `20261117090000_taste_ventures.sql` puts a venture (a `venture_registry` slug; Make Your Mind
  Up is `publication`) on every row and freezes it, and fills a report's venture from its repository
  (`taste_venture_repositories`), or takes the one the session named from a repository that serves several. This
  repository decides every other row's venture in code (`src/venture.ts`), distils claims per venture, renders the
  harness files with one section per venture, and reads only Make Your Mind Up's rules for the tagger and only its
  floor. A report with no venture is held and fails the run until it has one. Control Center's half is built (commit
  c705983 on its main, 2026-10-28): `report_to_taste_engine` files a report under its repository's venture, or the one
  a session names from a repository that serves several, and refuses a contradiction or an unknown venture;
  `get_approved_taste` takes the repository and returns only that venture's rules, never another's as a fallback; the
  growth engines, mail in his name and the content loaders each pass the venture they serve. The migration is applied
  live (2026-10-28). This repository's part is proved by `test/venture.int.test.ts`, which applies the migration over
  synthetic rows of every class it moves and then runs the engine's own stages on the migrated schema; Control
  Center's by its `tests/api/tasteMcp.test.ts`.
- **His presses on the publish board (2026-10-28).** Krish, 2026-10-28, the board's presses: "pick an idea for a
  specific day AND add any optional comments easily ... OR mark an idea as being useful in a future wider piece OR ...
  stored for a future trend OR queue it for next week OR reject it." The daily `cues` stage reads the board documents
  he wrote himself (content-engine `board_documents`, `updated_by` 'Krish'). A queue press that names a use is his tap,
  so its cue is `use_origin` 'krish' with `decided_by` 'Krish' in meta, never a rule or a guess; `next_week` is filed as
  `future_piece`. A press joins its idea's queue answers, so the answer in the queue that relays the same words, written
  after the press, is never read again by the verdict rules: one press, one cue. A note on a pick is a `week_pick` cue
  (the source the cues migration reserved); the tap names a day, not a use, so reading the note as his brief is a rule
  (`use_origin` 'rule', `decided_by` 'Krish'). Every pick of his also joins the idea's queue answers as a yes, so it
  retires a `not_for_us` cue before it. An `offday` press is Growth's and only counted. A press that cannot be filed (no
  idea id, or words longer than a cue holds) fails the run while its board is this week's or next week's, or once when
  it is saved since the last run that read the board; after that it is counted (`cues_board_unfiled`). Proved by
  `test/feedback-cues.test.ts` ("his presses on the publish board", "the stage with the board") and, on a real
  database, `test/pipeline.int.test.ts` ("his presses on the publish board, as cues").

  **Which week a "Next week" idea is for has one home:** `target_week` on the idea's queue mark (content-engine
  `apps/control-plane/api/_ideaQueue.ts`, `content_ideas.meta.queue`), as plan W1 sets it. The Sunday gather orders by
  that. The cue's `meta.target_week` is context only: the Monday the press that carried his words named, kept only when
  it is a Monday and never guessed, and a later re-queue with no words does not change it. The gather must never order
  by it.

  Still to land in content-engine, built against what this reader expects:
  - The board package writes his presses in this shape. `queue/<idea id>` (the document id is the idea's `content_ideas`
    id, or the body carries it as `idea_id`): `use`, one of `wider_piece_context`, `track_over_time`, `next_week`,
    `not_for_us`, `offday`; optional `note` and `reason`, his words, whole (together at most 4000 characters, which a
    cue holds; a longer one is never cut, it is counted unfiled); `target_week`, a Monday, `next_week` only; `day`
    (`tue`, `thu`, `sat` or `sun`) and `approved` (boolean), `offday` only; `at`, when he pressed. `picks/<day>`: the
    pick as today, plus `idea_id` (the idea's `content_ideas` id) and an optional `note`. A queue document of his with a
    note or a reason but no `use` this reader knows is counted (`cues_board_unread`) and never read, so a renamed field
    shows in the run's counts.
  - Both are his-only writes: `hisOnlyRefusal` (`apps/control-plane/api/board/_contracts.ts`) refuses a queue document
    with a `use` and a pick with a `note` from any writer but Krish. Today it covers neither, so an `engine_operator`
    write over his document would set `updated_by` to the operator and withdraw the cue his press made.
  - The board's Next week press writes `target_week` onto the queue mark too, and the Sunday gather
    (`apps/control-plane/api/_feedbackCues.ts`) lists the ideas whose queue mark is for that week first.
