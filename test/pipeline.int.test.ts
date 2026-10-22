import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'
import { writeEvidence, type Evidence } from '../src/evidence.ts'
import { explainPending } from '../src/explain/whys.ts'
import { distil } from '../src/distil/claims.ts'
import { propose, syncDecisions } from '../src/publish/propose.ts'
import { score } from '../src/score/scoreboard.ts'

// End to end against a real Postgres with the real migration, and a stub in
// place of the model. Runs only when both are provided:
//   TEST_DATABASE_URL=postgres://...  TASTE_MIGRATION=/path/to/20261104090000_taste_ledger.sql
const url = process.env.TEST_DATABASE_URL
const migration = process.env.TASTE_MIGRATION
const run = url && migration ? describe : describe.skip

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
    await client.query(readFileSync(migration!, 'utf8'))
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
})
