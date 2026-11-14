Status: A failed distil now names each failed venture and why its answer was not data (refusal, max_tokens or unparsed), in the run's problem line and in counts.distil_failures. The 2026-11-07 taste_weekly failure could not be told apart: its meter shows 3 calls, 1 failed, 164583 tokens, consistent with either a refusal or a cut-off at the 32000-token limit.
Next: Read counts.distil_failures on the next failed taste_weekly run; if it says max_tokens, split that venture's whys into two calls.
North Star check (2026-11-14): holds.
