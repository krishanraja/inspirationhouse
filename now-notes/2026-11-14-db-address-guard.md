Status: A test fails when the main database's project address appears in any tracked file other than src/config.ts, where it stays as the SUPABASE_PROJECT_REF default because no workflow supplies that variable; the URL test uses a synthetic address (fleet audit I-01).
Next: When a workflow passes SUPABASE_PROJECT_REF from a repository variable, drop the default and the allowance.
North Star check (2026-11-14): holds.
