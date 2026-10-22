# Working in Inspiration House

Read `README.md` first. These rules hold for every change.

1. **Never write to Krish's Drive.** Google scopes stay read-only (`src/config.ts`, checked in `test/hygiene.test.ts`).
2. **No data in the repository or the logs.** The repository is public. Fixtures are synthetic. Log through `src/log.ts`, which keeps counts and drops text. Readable previews go to `preview/`, which is gitignored.
3. **Model output is always labelled.** A why the model inferred is `model_guess`; only evidence carrying his words can ground an `origin: krish` why.
4. **Only Krish-attributed evidence counts.** `krish_words` and `krish_action` count toward a claim; `observation` and `machine_inference` are context. When a source mixes machine rows with his (as `feedback_queue` does), separate them in the collector and say how in a comment.
5. **Never set a decision.** Claims go to `mindmake_studio_learning_proposals` as `proposed`. Only Krish approves, rejects or rewords, through the board or Control Center.
6. **Never edit content-engine's taste files.** They are read through the GitHub API and nothing else.
7. **Schema changes go to content-engine** as a migration, applied with `apply_migration`.
8. **A run that produced nothing from real input is a failure** (`src/runs.ts`). Do not make it pass by catching the error.

Check before pushing: `pnpm typecheck && pnpm test`, then `pnpm engine daily --dry-run` against live data.
