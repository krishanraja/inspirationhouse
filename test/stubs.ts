// The tables the venture migration (content-engine 20261117090000_taste_ventures.sql) reads that Mindmaker OS keeps
// elsewhere, cut to the columns it uses: the venture registry, seeded with the active slugs and one retired one, and the
// visibility targets a visibility row takes its venture from. Shared by every database suite's fresh schema.
// Synthetic rows only.

export const ACTIVE_VENTURES = [
  'publication', 'mindmake', 'heartside', 'full_time', 'legibility', 'mm_ctrl', 'fractionl_pulse', 'fractionl_circle',
  'signal_noise', 'investor',
] as const

/** A slug the registry holds but no longer runs: a session may never name it. */
export const RETIRED_VENTURE = 'mindmaker'

export const VENTURE_STUBS = `
  create table public.venture_registry (slug text primary key, display_name text not null, active boolean not null default true);
  insert into public.venture_registry (slug, display_name, active)
    select slug, initcap(replace(slug, '_', ' ')), true from unnest(array['${ACTIVE_VENTURES.join("', '")}']) as slug
    union all select '${RETIRED_VENTURE}', 'Mindmaker', false;
  create table public.visibility_targets (id uuid primary key default gen_random_uuid(), product_slug text references public.venture_registry (slug));`
