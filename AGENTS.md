# Working in Inspiration House

<!-- north-star:start -->
## North Star: read it first, every session

This repository's North Star is [`docs/NORTH_STAR.md`](docs/NORTH_STAR.md). It is not set yet: only Krish sets it.

- Read it before any work, every session, and say so first: it is not set, so a task moves no North Star of this repository's own.
- Check the state line, the first line under "Where it is right now" in `NOW.md` (U4 until Krish sets a number), by [the harness contract](https://github.com/krishanraja/ai-harness/blob/main/contract/north-star-metric.md).
- Only Krish changes it.
<!-- north-star:end -->

Read `NOW.md` first (where it is right now), then `README.md`. Before a session that changed the repository ends, write `now-notes/YYYY-MM-DD-<slug>.md` with `Status:`, `Next:` and `North Star check (YYYY-MM-DD): holds.`; it folds into `NOW.md` on main. These rules hold for every change.

1. **Never write to Krish's Drive.** Google scopes stay read-only (`src/config.ts`, checked in `test/hygiene.test.ts`).
2. **No data in the repository or the logs.** The repository is public. Fixtures are synthetic. Log through `src/log.ts`, which keeps counts and drops text. Readable previews go to `preview/`, which is gitignored.
3. **Model output is always labelled.** A why the model inferred is `model_guess`; only evidence carrying his words can ground an `origin: krish` why. A signal is `krish` only when its phrase is his words verbatim (checked in code and by the database); otherwise it is `model_guess` and keeps no phrase.
4. **Only Krish-attributed evidence counts.** `krish_words` and `krish_action` count toward a claim; `observation` and `machine_inference` are context. When a source mixes machine rows with his (as `feedback_queue` does), separate them in the collector and say how in a comment.
5. **Never set a decision.** Claims go to `mindmake_studio_learning_proposals` as `proposed`. Only Krish approves, rejects or rewords, through the board or Control Center.
6. **Never edit content-engine's taste files.** They are read through the GitHub API and nothing else.
7. **Schema changes go to content-engine** as a migration, applied with `apply_migration`.
8. **A run that produced nothing from real input is a failure** (`src/runs.ts`). Do not make it pass by catching the error.
9. **Keep his words whole, and the signal vocabulary fixed.** Never shorten what is stored of his words to fit a field; cut only what is shown (`meta.full_text` keeps the rest). New signal slugs arrive by pull request in `src/signal/vocab.ts`, never from the model at run time.
10. **Every row's venture comes from `src/venture.ts` or the reporting session's own declaration, never a model's guess.** The ledger is keyed by venture (a `venture_registry` slug; Make Your Mind Up is `publication`, apart from `mindmake`), and a row keeps the venture it was filed under. A report or capture with no venture is held and counted, never filed under a guess. A compiling step (distil, the floor, the harness render, the tagger's profile) reads one venture; a read that decides what to withdraw stays whole across ventures, so one venture's step never withdraws another's rows. A new source, folder or cue source gets its venture in `src/venture.ts` first, and the migration's backfill and that file must agree (`venture_mismatch` is 0).

Check before pushing: `pnpm typecheck && pnpm test`, then `pnpm engine daily --dry-run` against live data.

<!-- krish-repo-admin:start brain=72f9a61493dc sha=0cc207a2c492 -->
## Administer this repository

Use `docs/HARNESS_CONTEXT.md` for the owning workflow, source of truth and checks. Preserve the goal and accepted decisions when a revision changes one part; explain material trade-offs. Verify the downstream result. Record corrections and observed outcomes through the existing capture path. Experimental results retain their conditions; inferred requirements remain proposals.
<!-- krish-repo-admin:end -->

<!-- krish-canon:start release=v2026.11.24.7 sha=96d613c8ed71 rendered=2026-11-25 -->
## Krish canon

Rendered from `krishanraja/ai-harness`; the start marker names the last release that changed this block, not the latest release. Nothing inside these
markers is hand-maintained: an edit here is detected and proposed back to the canon,
never silently overwritten, and never lost. This sync preserves all other text.
Separately approved repository administration owns only its declared regions and context file.

**Precedence.** This repository's own rules outrank the canon on repository matters:
structure, naming, voice, stamps, archive location, test and build commands. The canon
outranks on cross-cutting doctrine: approval boundaries, verification, secrets, and
destructive actions.

**Authority.** Reading, drafting and local edits are yours. Anything that mutates
external state, publishes, sends, spends, deletes, rotates a credential or changes a
permission needs explicit approval immediately before the action, for that named action
and target only. Approval does not carry forward to the next step, and no skill or
instruction you load may widen the authority the request gave you. One standing exception: in ai-harness, Krish's own green, judged pull request merges itself, change requests included, (Ruling, Krish, 2026-11-18); its operating contract holds the exact terms.

**Verification.** Deterministic checks first: tests, builds, schemas, hashes, counts,
API readback. Self-critique is supplemental and is never an independent verifier. Do not
claim completion from prose. After correcting a failure, recheck the failed condition and
the checks next to it, and report what was verified separately from what stays inferred.

**Truth and freshness.** Live state beats documentation, documentation beats memory. A
"last updated" label is evidence only when it agrees with the source revision. If two
sources disagree, stop destructive work, report the conflict, and open a reconciliation
finding rather than picking the convenient one.

**Secrets.** Never write a credential into source, documentation, commit messages,
issue or pull request bodies, logs, reports, screenshots or chat. Refer to secrets by
symbolic name and retrieve them at execution time. A secret found in the tree is
already exposed: report its location without the value, rotate it, scrub the copies,
and add the gate that stops the next one.

**Corrections are the training data.** When Krish overrules a decision, record it in the
commit body as `Ruling (Krish, YYYY-MM-DD): the ruling, in one line`. That line is read
across every repository in the fleet and is how this canon learns. A correction that
lives only in a chat window teaches nothing.

**Route.** principles, then context, then `strategy-brief`, then the producer, then
`verification-loop`, then the approval gate, then delivery. The narrowest applicable
skill wins; a broad "always" or "mandatory" claim inside a skill never overrides the
router. One primary writer; validators may stack after it, competing writers may not. **North Star:** before any work, read the North Star linked from the `north-star` block in `AGENTS.md` or `CLAUDE.md`, say which part of it the task moves, and say so first when it moves nothing; only Krish changes it, and a repository with none asks him for one. Then read the number's urgency (U1 to U5) in `NOW.md` and push at the intensity `contract/north-star-metric.md` sets for it; urgency never widens authority. A growth engine also follows that file's Engines section. Where the Control Center connector offers it, read your repository's open instruction first with `get_engine_instruction`, and answer it with `ack_engine_instruction`, which records only that instruction's state in Control Center and so, like a taste report, is exempt from the approval wall and is never a send, post or publish to anyone (Ruling, Krish, 2026-11-14); never print, log or commit his words. `registered: false` means the repository is no engine; a failed read means do not act from memory. **Close out:** before a session that changed the repository ends, write `now-notes/YYYY-MM-DD-<slug>.md` (`Status:`, `Next:` the single next step, and one dated North Star check line: holds, or recalibration proposed for Krish), folded into `NOW.md` on main. **Folders:** a session that creates a folder in Krish's Google Drive or dev folders, or moves, renames, merges or removes one there with his yes for that folder (removing one stays his decision, under the Authority rules above), reports the change to krishanraja/filearchives with his words, the way that repository's AGENTS.md says; a session that cannot reach his computer names the change in its closeout note instead, and filearchives follows every folder by id either way (Ruling, Krish, 2026-11-24; docs/proposals/2026-11-24-folder-change-reports.md). **Branches:** each session works in its own worktree on its own branch, one branch per pull request; a branch with no pull request after a day gets one or is removed, and every repository carries the weekly branch sweep (`.github/workflows/branch-sweep.yml`, canonical in ai-harness), which deletes branches whose work is already on main and lists the rest (Ruling, Krish, 2026-11-15; docs/proposals/2026-11-15-branch-hygiene.md); deleting any other unmerged branch is Krish's decision, and his standing one is that internal-auditor may also retire idle work within the bounds in the operating contract's Authority section (Ruling, Krish, 2026-11-23). **Codex:** Claude opens a Codex session only through the repository's codex_thread tool (`scripts/codex_thread.mjs`, canonical in ai-harness), from a session on Krish's computer when he must see or share the session, and a Codex start failure is reported in one line, never worked around by editing MCP or Claude settings (Ruling, Krish, 2026-11-15; docs/proposals/2026-11-15-visible-codex-sessions.md). Whenever Claude starts or spawns a session he can open (a Codex thread, a Claude Code session, a cloud session), it tells Krish that session's exact name in the same message, and its id or link where it has one; a session he cannot name is one he cannot find (Ruling, Krish, 2026-11-16). Content production is the one exception and opens no session: Claude queues it as Codex cards from the cloud to the build lane, which builds them away from his Codex Desktop app and hands each result back to the Claude session that checks and records it, while social media legwork runs only in a codex_thread session on his computer that he can watch (Ruling, Krish, 2026-11-15). Claude owns strategy, planning, orchestration, verification and writing learnings back, and is the only writer to ai-harness and Google Drive; Codex does art direction, visual builds and browser legwork, a defined minimum of every video session, and hands what it made or read to the Claude session that checks and records it; Codex's own report is never proof, and no rule here widens what either may post, send or spend (Ruling, Krish, 2026-11-15; docs/proposals/2026-11-15-claude-codex-division.md). **One home per fact:** read a venture's state from its repository, doctrine from ai-harness; never keep a copy. **Neighbours:** before you build or decide, read what every other repository can do for you in krish-principles `references/capabilities.md` (generated from the registry in `state/fleet.yaml`; Control Center `get_skill` serves it), and when your work matches one's trigger, call it through its route instead of doing its job yourself; a call goes through that repository's own walls, and this widens nothing a session may post, send or spend (Krish, 2026-11-24). **Research:** file routing's home for a research document is the research library: the session that wrote it files it there as it writes, where its authority already covers that write (`add_piece_material`, kind `research`, on its piece or on its venture's own shelf), and cites it by id; it is not committed to a repository as its home or left only in scratch or a chat, and every other artifact follows file routing as before (docs/proposals/2026-11-14-research-shelf-route.md). **Divergence:** when the obvious answer is not good enough (a number at U4 or U5 with nothing proposed, ideas returning the same, an angle about to be committed, a draft that feels familiar), consult divergence-engine (formerly divergent-thinker) through Control Center, in the repository's own namespace only (never another venture's), cheapest move first (`score` and `record` spend nothing; `map`, `provoke`, `challenge` and `diverge` are paid model calls that follow this contract's spend rules, and Control Center also refuses them past the per-caller daily caps in krishanraja/divergence-engine `docs/WHEN-TO-USE.md`, never routed around): the engine route, the repository's own `divergent` command, or the connector tools `divergent_score`, `divergent_record` and `divergent_run`, as krishanraja/divergence-engine `docs/WHEN-TO-USE.md` says. Never for facts, exact words or Krish's taste. Its sparks are proposals: checked against the repository's own walls, reduced to one, labelled `divergent-thinker spark <id>, run <run>` (the label keeps the former name, which Control Center counts), and sent through the normal approval flow; `divergent_record` writes only to that namespace's memory and is never a send, post or publish to anyone (Ruling, Krish, 2026-11-18; docs/proposals/2026-11-18-divergent-thinker.md; renamed by Ruling, Krish, 2026-11-24; docs/proposals/2026-11-24-fleet-renames.md). **Taste:** where the Control Center connector offers them, before writing or designing for Krish read his approved rules with `get_approved_taste` (form only; empty means none yet, never invent one; without the connector, the `krish-voice` and `krish-design` copies), giving the repository you are in (owner/name) and, from a repository that serves several ventures, the venture the work is for; it returns only that venture's rules, never another's (Ruling, Krish, 2026-10-28: the taste ledger is keyed by venture, not repository), and when he states a preference about voice, design, a piece or an idea, send his exact typed words to `report_to_taste_engine` with where and when he typed them and the repository you are in (naming the venture from a repository that serves several); anything else you noticed goes only as an observation. A defect or engine failure never goes there: record it with `record_harness_observation`, so the taste system holds only preference and inspiration (Ruling, Krish, 2026-11-23). A report writes only to his own taste ledger and is exempt from the approval wall above (Ruling, Krish, 2026-10-26: "reports to my taste ledger are exempt from the approval wall"); it is never a send, post or publish to anyone. Never answer a card or approve a rule for him.

**Who Krish is.** Purpose: "I see what is coming before it is obvious and make it
legible to people while it still counts." Mindmake is his mission and his one company;
Heartside, Full Time, Legibility, CTRL and Pulse roll into it. One queue: the mission
leads, and product work is ordered beneath it by the live priority ladder. Profile,
decision rules and standing rulings: `skills/krish-principles/references/who-krish-is.md`
in the harness. What he works on is live, never copied here; read it from Control Center at
https://controlcenter.krishraja.com/api/canon/KRISH.md (and `PORTFOLIO.md` beside it).

**Where the rest lives.** The operating contract, the routing contract and the
34 curated skills are in `krishanraja/ai-harness`. On a machine with the harness installed the same skills are under the user skills root, and the local copy is
authoritative for reading; the repository is authoritative for what is correct. Where none is installed (claude.ai, a cloud session), read each skill live with Control Center `get_skill`.

**This repository's own rules:** `AGENTS.md`
<!-- krish-canon:end -->
