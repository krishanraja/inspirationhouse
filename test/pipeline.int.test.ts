import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'
import { writeEvidence, withdrawUncollected, type Evidence } from '../src/evidence.ts'
import { explainPending } from '../src/explain/whys.ts'
import { distil } from '../src/distil/claims.ts'
import { propose, syncDecisions, ELIGIBLE_SQL, type Eligible } from '../src/publish/propose.ts'
import { score } from '../src/score/scoreboard.ts'

// End to end against a real Postgres with the real migrations, and a stub in
// place of the model. Runs only when both are provided. TASTE_MIGRATION is a
// comma-separated list of files, applied in the order given. It needs every
// content-engine migration this engine reads (supabase/migrations/):
//   20261104090000_taste_ledger.sql
//   20261105090000_inspiration_how_to_read.sql
//   20261106090000_inspiration_facets_and_many.sql
//   20261107090000_inspiration_kinds.sql
//   20261108090000_inspiration_answers_hold.sql
//   20261109090000_content_watch.sql          (the link queue and content_reads)
//   20261110090000_taste_support_by_card.sql
// For example, from a content-engine checkout:
//   M=supabase/migrations
//   TEST_DATABASE_URL=postgres://... \
//   TASTE_MIGRATION=$(ls $M/2026110[4-9]*.sql $M/20261110090000_*.sql | paste -sd, -)
const url = process.env.TEST_DATABASE_URL
const migrations = (process.env.TASTE_MIGRATION ?? '').split(',').map(f => f.trim()).filter(Boolean)
const run = url && migrations.length ? describe : describe.skip

run('the whole loop, on a real database', () => {
  let client: pg.Client
  let db: Db
  const runId = '11111111-1111-1111-1111-111111111111'

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url })
    await client.connect()
    await client.query('drop schema public cascade; create schema public;')
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;`)
    // The tables the engine reads that other repositories own, cut to the columns it uses.
    await client.query(`
      create table public.mindmake_studio_learning_proposals (
        id uuid primary key default gen_random_uuid(), weekly_batch_id text not null, proposal_class text not null,
        assertion text not null, scope jsonb not null, evidence_event_ids uuid[] not null,
        independent_session_count integer not null check (independent_session_count > 0),
        independent_job_count integer not null, counterexamples jsonb not null default '[]',
        regression_cases jsonb not null, proposed_change jsonb not null,
        status text not null default 'proposed', decided_at timestamptz, decided_by text check (decided_by is null or decided_by = 'Krish'),
        created_at timestamptz not null default now());
      create table public.content_engine_runs (id uuid primary key default gen_random_uuid(), job text, trigger text, status text, reason text, counts jsonb, started_at timestamptz, finished_at timestamptz);
      create table public.content_ideas (id uuid primary key default gen_random_uuid(), published_at timestamptz);
      create table public.content_edit_events (actor text, action text, occurred_at timestamptz);`)
    for (const file of migrations) await client.query(readFileSync(file, 'utf8'))
    db = {
      query: async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
      close: async () => {},
    }
  })
  afterAll(async () => { await client?.end() })

  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T12:00:00.000Z`
  const evidence: Evidence[] = [1, 2, 3, 4].map(n => ({
    source: 'title_verdicts', sourceRef: `t${n}`, occurredAt: day(n + 5), attribution: 'krish_words',
    polarity: n === 4 ? 'dislikes' : 'likes', lane: 'voice', layer: 'packaging',
    title: `synthetic title ${n}`, excerpt: `synthetic: say what happens ${n}`, meta: {},
  }))

  it('collects idempotently', async () => {
    expect((await writeEvidence(db, evidence, runId)).written).toBe(4)
    expect((await writeEvidence(db, evidence, runId)).written).toBe(0)
  })

  it('explains each piece of his evidence and labels the guesses', async () => {
    const llm: Llm = {
      model: 'stub',
      structured: async () => ({
        failure: null, model: 'stub',
        data: { items: [0, 1, 2, 3].map(ref => ({ ref, whys: [
          { statement: 'He wants titles that say what happens.', kind: 'form', layer: 'packaging', origin: 'krish' },
          { statement: 'He is drawn to stories about money.', kind: 'subject', layer: null, origin: 'model_guess' },
        ] })) } as never,
      }),
    }
    const res = await explainPending(db, llm, runId)
    expect(res.whys).toBe(8)
    expect((await explainPending(db, llm, runId)).items).toBe(0)
  })

  it('distils a claim, with the counts computed by the database', async () => {
    const llm: Llm = {
      model: 'stub',
      structured: async () => ({
        failure: null, model: 'stub',
        data: { claims: [
          { statement: 'Titles say what happens, in plain words.', lane: 'voice', layer: 'packaging', kind: 'form',
            why: 'He picks titles that name the event.', means: 'Write the event, not the theme.',
            support: [0, 2, 4], counter: [6], krish_quote_ref: 0, krish_quote: 'say what happens', flip_rule: 'He picks two abstract titles in a month.' },
          { statement: 'He likes stories about money.', lane: 'voice', layer: null, kind: 'subject',
            why: 'Several saved items are about money.', means: 'Prefer money stories.',
            support: [1, 3, 5], counter: [], krish_quote_ref: null, krish_quote: null, flip_rule: 'He stops saving money stories.' },
        ] } as never,
      }),
    }
    const res = await distil(db, llm, runId)
    expect(res.written).toBe(2)
    const [c] = (await client.query(`select support_n, counter_n, confidence::float as confidence, krish from taste_claims where kind = 'form'`)).rows
    expect(c).toMatchObject({ support_n: 3, counter_n: 1, confidence: 0.667 })
    expect(c.krish).toBe('say what happens')
    // Re-running the same draft updates the claim; it never duplicates it.
    expect((await distil(db, llm, runId)).written).toBe(2)
    expect(Number((await client.query('select count(*) from taste_claims')).rows[0].count)).toBe(2)
  })

  it('proposes at most three a week, form first, and never decides', async () => {
    const res = await propose(db, new Date(day(22)))
    expect(res.proposed).toBe(2)
    const rows = (await client.query(`select status, decided_by, scope->>'source' as source from mindmake_studio_learning_proposals`)).rows
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.status === 'proposed' && r.decided_by === null && r.source === 'taste_ledger')).toBe(true)
    expect((await propose(db, new Date(day(22)))).proposed).toBe(0)
  })

  it('shows readers an approved form claim, and never a subject claim', async () => {
    await client.query(`update mindmake_studio_learning_proposals set status = 'approved', decided_at = now(), decided_by = 'Krish'`)
    const form = (await client.query('select statement, kind from taste_profile_form')).rows
    expect(form).toEqual([{ statement: 'Titles say what happens, in plain words.', kind: 'form' }])
  })

  it('retires a claim he rejected, so it is never proposed again', async () => {
    await client.query(`update mindmake_studio_learning_proposals set status = 'rejected' where assertion like 'He likes stories%'`)
    expect((await syncDecisions(db)).retired).toBe(1)
    expect((await client.query(`select status from taste_claims where kind = 'subject'`)).rows[0].status).toBe('retired')
  })

  it('takes a baseline on the first score, and calls a quiet week no reading', async () => {
    const res = await score(db, new Date(day(22)))
    expect(res.weeks).toBe(5)
    const quiet = (await client.query(`select reading, value from taste_scoreboard where metric = 'corrections_per_published_piece'`)).rows
    expect(quiet.every(r => r.reading === 'no_reading' && r.value === null)).toBe(true)
    const titles = (await client.query(`select week::text, numerator::float, denominator::float, phase from taste_scoreboard where metric = 'title_first_pick_rate' and reading = 'measured'`)).rows
    // Synthetic verdicts on 6-9 October: three picked and one rejected, in the week starting Monday 5 October.
    expect(titles).toEqual([{ week: '2026-10-05', numerator: 3, denominator: 4, phase: 'baseline' }])
  })
  // The review of 180fbee, each reproduced here first on Postgres 16.

  const evidenceId = async (source: string, ref: string) =>
    (await client.query(`select id::text from taste_evidence where source = $1 and source_ref = $2 and withdrawn_at is null`, [source, ref])).rows[0].id as string
  const insertClaim = async (fingerprint: string, ids: string[], krish: string | null, krishSource: string | null) =>
    (await client.query(
      `insert into taste_claims (fingerprint, lane, layer, kind, statement, krish, krish_source_id, why, means, evidence_ids, flip_rule)
       values ($1, 'voice', 'packaging', 'form', 'A synthetic claim for this test.', $2, $3::uuid, 'Because the test says so.',
               'Do what the test says.', $4::uuid[], 'If the test says otherwise.') returning id::text`,
      [fingerprint, krish, krishSource, ids],
    )).rows[0].id as string

  it('updates a claim re-cited without its quote\'s row, and drops the quote rather than failing', async () => {
    const llm: Llm = {
      model: 'stub',
      structured: async () => ({
        failure: null, model: 'stub',
        data: { claims: [
          { statement: 'Titles say what happens, in plain words.', lane: 'voice', layer: 'packaging', kind: 'form',
            why: 'He picks titles that name the event.', means: 'Write the event, not the theme.',
            support: [2, 4, 6], counter: [], krish_quote_ref: null, krish_quote: null, flip_rule: 'He picks two abstract titles in a month.' },
        ] } as never,
      }),
    }
    expect((await distil(db, llm, runId)).written).toBe(1)
    const [c] = (await client.query(`select krish, krish_source_id, support_n from taste_claims where kind = 'form' and statement like 'Titles%'`)).rows
    expect(c).toEqual({ krish: null, krish_source_id: null, support_n: 3 })
  })

  it('counts no day from withdrawn evidence and carries no quote whose row was withdrawn', async () => {
    const rows: Evidence[] = [['w1', 1], ['w2', 3], ['w3', 3]].map(([ref, d]) => ({
      source: 'what_i_like_sheet', sourceRef: String(ref), occurredAt: `2026-09-0${d}T12:00:00.000Z`, attribution: 'krish_words',
      polarity: 'likes', lane: 'voice', layer: 'packaging', title: null, excerpt: `synthetic: a plain opening ${ref}`, meta: {},
    }))
    await writeEvidence(db, rows, runId)
    const [w1, w2, w3] = await Promise.all(['w1', 'w2', 'w3'].map(r => evidenceId('what_i_like_sheet', r)))
    const id = await insertClaim('a2a2a2a2a2a2a2a2', [w1!, w2!, w3!], 'a plain opening', w1!)
    // His first-day row is withdrawn after the claim was counted: the claim itself is not touched.
    await client.query(`update taste_evidence set withdrawn_at = now() where id = $1`, [w1])
    const got = (await db.query<Eligible>(ELIGIBLE_SQL)).find(e => e.id === id)!
    expect(got.days).toBe(1)
    expect(got.krish).toBeNull()
  })

  it('recounts a claim a failed run left counting withdrawn support, on the next run', async () => {
    const page: Evidence[] = ['card-x', 'card-y', 'card-z'].map((ref, i) => ({
      source: 'inspiration_page', sourceRef: ref, occurredAt: day(10 + i), attribution: 'krish_words', polarity: 'likes',
      lane: 'production', layer: null, title: 'clip.mp4', excerpt: `synthetic: the cut on the beat ${i}`, meta: { picked_likes: [] },
    }))
    await writeEvidence(db, page, runId)
    const ids = await Promise.all(page.map(e => evidenceId('inspiration_page', e.sourceRef)))
    const id = await insertClaim('a4a4a4a4a4a4a4a4', ids, null, null)
    expect((await client.query(`select support_n from taste_claims where id = $1`, [id])).rows[0].support_n).toBe(3)
    // A run withdrew card-x (he took the answer back) and stopped before its recount.
    await client.query(`update taste_evidence set withdrawn_at = now() where source_ref = 'card-x'`)
    // The next run collects the page as it stands: nothing changes this run, and the claim is recounted anyway.
    const r = await withdrawUncollected(db, 'inspiration_page', page.slice(1), true)
    expect(r.withdrawn).toBe(0)
    expect(r.recounted).toBe(1)
    expect((await client.query(`select support_n from taste_claims where id = $1`, [id])).rows[0].support_n).toBe(2)
  })
})
