# Working in Inspiration House

Read `README.md` first. These rules hold for every change.

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
