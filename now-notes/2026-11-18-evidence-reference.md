Status: Every reader that counts or uses taste_evidence as Krish's signal (signals, whys, claims, proposals, repeats, scoreboard) now skips rows marked reference material, through countsAsSignal in src/evidence.ts; it reads the mark through the row's json, so it holds before and after content-engine's migration 20261206090000 lands. withdrawUncollected is unchanged.
Next: Apply content-engine's migration 20261206090000_taste_evidence_reference.sql to Mindmaker OS once its pull request merges, then confirm the 3,682 backfill rows carry reference_at.
North Star check (2026-11-18): holds.
