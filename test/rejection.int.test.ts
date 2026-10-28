import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { DRIVE, WEEKLY_PROPOSAL_CAP, loadConfig } from '../src/config.ts'
import type { Db } from '../src/db.ts'
import { FOLDER_MIME, type DriveFile, type Google } from '../src/google.ts'
import type { Llm } from '../src/llm.ts'
import { recountStandards, type DraftStandard } from '../src/rejection/distil.ts'
import { INBOX_WAIT_DAYS, runRejections, type RejectionsDeps, type RejectionsResult } from '../src/rejection/job.ts'
import { keepMedia } from '../src/rejection/keep.ts'
import { FLOOR_ELIGIBLE_SQL } from '../src/rejection/propose.ts'

// The Rejections floor against a real Postgres with content-engine's real migrations (supabase/migrations/), and
// stubs in place of Drive and the model. Synthetic rows only: nothing here is anything Krish said or any file in his
// Drive, and every Drive id is made up. TASTE_MIGRATION is the same comma-separated list test/pipeline.int.test.ts
// takes (its header is the one list), and this file runs only once it holds 20261116090000_rejections.sql:
//   M=supabase/migrations
//   TEST_DATABASE_URL=postgres://... \
//   TASTE_MIGRATION=$(ls $M/2026110[4-9]*.sql $M/2026111[0-6]090000_*.sql | paste -sd, -)
// It works in its own database beside the one given (<name>_rejections, made on first use): vitest runs test files at
// the same time, and pipeline.int.test.ts drops schema public in the one given.
const url = process.env.TEST_DATABASE_URL
const migrations = (process.env.TASTE_MIGRATION ?? '').split(',').map(f => f.trim()).filter(Boolean)
// CI sets REQUIRE_DB_TESTS: a missing database or migration list there is a fault, never a quiet skip.
if (process.env.REQUIRE_DB_TESTS && !(url && migrations.length)) {
  throw new Error('REQUIRE_DB_TESTS is set but TEST_DATABASE_URL or TASTE_MIGRATION is missing')
}
// freshSchema drops schema public, so only ever a local throwaway database.
if (url && !/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  throw new Error('TEST_DATABASE_URL must point at a local throwaway database')
}
const listed = Boolean(url && migrations.some(m => m.endsWith('_rejections.sql')))
const run = listed ? describe : describe.skip
// The job keeps a still by re-encoding it with ffmpeg on the runner, as test/rejection-media.test.ts does.
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()
// CI installs ffmpeg and sets REQUIRE_FFMPEG: there, a missing ffmpeg is a fault, never a quiet skip of the job's suite.
if (process.env.REQUIRE_FFMPEG && !hasFfmpeg) throw new Error('REQUIRE_FFMPEG is set but ffmpeg or ffprobe is missing')
const runJob = listed && hasFfmpeg ? describe : describe.skip

/** This file's own database on the given server, made once. Returns its URL. */
async function ownDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    const name = `${(await admin.query(`select current_database() as name`)).rows[0].name}_rejections`
    const held = await admin.query('select 1 from pg_database where datname = $1', [name])
    if (!held.rowCount) await admin.query(`create database ${admin.escapeIdentifier(name)}`)
    const own = new URL(url!)
    own.pathname = `/${name}`
    return own.toString()
  } finally {
    await admin.end()
  }
}

// A fresh public schema with the real migrations, and a Db on it, as in pipeline.int.test.ts. Every suite here
// starts from one.
async function freshSchema(): Promise<{ client: pg.Client; db: Db }> {
  const client = new pg.Client({ connectionString: await ownDatabase() })
  await client.connect()
  await client.query('drop schema public cascade; create schema public;')
  // Roles belong to the server, so the other database file may be making them at the same moment.
  await client.query(`do $$ declare r text; begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      begin execute format('create role %I', r); exception when duplicate_object or unique_violation then null; end;
    end loop;
  end $$;`)
  // As on Supabase: the service role may use the schema, and gets everything on each new table unless a migration takes
  // it back.
  await client.query('grant usage on schema public to service_role; alter default privileges in schema public grant all on tables to service_role;')
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
    create table public.content_ideas (id uuid primary key default gen_random_uuid(), published_at timestamptz, idea text, state text, created_at timestamptz default now(),
      meta jsonb not null default '{}', scheduled_for date, buried_at timestamptz);
    create table public.content_edit_events (actor text, action text, occurred_at timestamptz);`)
  for (const file of migrations) await client.query(readFileSync(file, 'utf8'))
  const db: Db = {
    query: async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
    close: async () => {},
  }
  return { client, db }
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

run('the floor\'s guarantees, on a real database', () => {
  let client: pg.Client
  let db: Db

  beforeAll(async () => { ({ client, db } = await freshSchema()) }, 30_000)
  beforeEach(async () => {
    await client.query(`truncate public.taste_floor_standards, public.taste_rejections, public.taste_rejection_quotes,
      public.taste_rejection_media, public.taste_rejection_inbox, public.mindmake_studio_learning_proposals cascade`)
  })
  afterAll(async () => { await client?.end() })

  // Each row gets its own key, ref and fingerprint from this counter.
  let n = 0
  const quote = async (text: string, attribution = 'krish_words') => (await client.query(
    `insert into taste_rejection_quotes (quote_key, text, said_at, said_precision, said_where, source, attribution)
     values ($1, $2, '2026-10-20T12:00:00Z', 'day', 'a synthetic session', 'cloud', $3) returning id::text`,
    [md5(`quote ${n++}`), text, attribution],
  )).rows[0].id as string
  const record = async (quoteIds: string[], over: { kind?: string; attribution?: string } = {}) => {
    const i = n++
    return (await client.query(
      `insert into taste_rejections (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, item,
         reason, strength, theme, formats, rule_kind, capture, rules_rev)
       values ('drive_dump', $1, $2, $3, '2026-10-20T12:00:00Z', $4::uuid[], $5, 'synthetic: a title card crowds the edge',
         'synthetic: no room around it', 'disliked', 'layout', '{short_video}', 'form', 'still', 'rules-v1') returning id::text`,
      [`dump:synthetic-${i}`, md5(`record ${i}`), over.kind ?? 'rejected', quoteIds, over.attribution ?? 'krish_words'],
    )).rows[0].id as string
  }
  const standard = async (o: { quoteIds: string[]; statement?: string; krish?: string; krishQuoteId?: string; status?: string; proposalId?: string }) => (await client.query(
    `insert into taste_floor_standards (fingerprint, statement, how_to_check, formats, theme, layer, kind, quote_ids, krish,
       krish_quote_id, status, proposal_id, prompt_rev)
     values ($1, $2, 'synthetic: scrub to each title card and look at its edges.', '{short_video}', 'layout', 'graphics', 'form',
       $3::uuid[], $4, $5::uuid, $6, $7::uuid, 'floor-v1') returning id::text`,
    [md5(`standard ${n++}`), o.statement ?? 'synthetic: always leave a title card room at the frame edge.', o.quoteIds,
      o.krish ?? null, o.krishQuoteId ?? null, o.status ?? 'candidate', o.proposalId ?? null],
  )).rows[0].id as string
  const proposal = async (status: string, decidedBy: 'Krish' | null, note: string | null = null) => (await client.query(
    `insert into mindmake_studio_learning_proposals (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids,
       independent_session_count, independent_job_count, regression_cases, proposed_change, status, decided_at, decided_by, decision_note)
     values ('floor-2026-10-26', 'taste', 'synthetic: a standard put to him.', '{"source": "rejections"}', '{}', 1, 0, '[]', '{}',
       $1, case when $2::text is null then null else now() end, $2, $3) returning id::text`,
    [status, decidedBy, note],
  )).rows[0].id as string
  // The first bytes of each kind of file, so synthetic bytes are what their label says unless a test says otherwise.
  const MAGIC: Record<string, Buffer> = {
    'video/mp4': Buffer.from('00000018667479706d703432', 'hex'), 'image/jpeg': Buffer.from('ffd8ffe0', 'hex'),
    'image/png': Buffer.from('89504e470d0a1a0a', 'hex'), 'image/webp': Buffer.from('524946460000000057454250', 'hex'),
  }
  const labelled = (mime: string, rest: Buffer) => Buffer.concat([MAGIC[mime]!, rest])
  const media = (rest: Buffer, o: { role?: string; mime?: string; durationMs?: number | null; sha?: string; raw?: boolean } = {}) => {
    const mime = o.mime ?? 'video/mp4'
    const bytes = o.raw ? rest : labelled(mime, rest)
    return client.query(
      `insert into taste_rejection_media (sha256, role, mime, bytes, width, height, duration_ms, cut_rev)
       values ($1, $2, $3, $4, 480, 854, $5, 'cut-v1')`,
      [o.sha ?? sha256(bytes), o.role ?? 'clip', mime, bytes, o.durationMs === undefined ? 4000 : o.durationMs],
    )
  }
  const supportOf = async (id: string) =>
    (await client.query(`select support_n, action_n from taste_floor_standards where id = $1`, [id])).rows[0]

  it('refuses a clip over 1.6 MB and a clip over 4.5 s, so no master is ever kept', async () => {
    await expect(media(randomBytes(2_000_000))).rejects.toThrow(/taste_rejection_media_clip_cap/)
    await expect(media(randomBytes(10_000), { durationMs: 6000 })).rejects.toThrow(/taste_rejection_media_duration_ms_check/)
    // A clip inside both caps is kept, so the refusals above are the caps and nothing else.
    await media(randomBytes(10_000))
    expect((await client.query('select count(*)::int as n from taste_rejection_media')).rows[0].n).toBe(1)
  })

  it('refuses media whose sha256 is not the hash of its bytes', async () => {
    const bytes = randomBytes(1000)
    const still = { role: 'screenshot', mime: 'image/jpeg', durationMs: null }
    await expect(media(bytes, { ...still, sha: sha256(randomBytes(1000)) })).rejects.toThrow(/taste_rejection_media_hash_is_bytes/)
    await media(bytes, still)
  })

  it('refuses bytes that are not what their label says, so an image cap can never hold a video', async () => {
    await expect(media(randomBytes(1000), { raw: true })).rejects.toThrow(/taste_rejection_media_bytes_are_the_mime/)
    await expect(media(labelled('video/mp4', randomBytes(1000)), { raw: true, role: 'screenshot', mime: 'image/jpeg', durationMs: null }))
      .rejects.toThrow(/taste_rejection_media_bytes_are_the_mime/)
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) await media(randomBytes(1000), { role: 'screenshot', mime, durationMs: null })
  })

  it('keeps a quote\'s words as he said them, while how the engine classes them can change', async () => {
    const id = await quote('synthetic: give the card room')
    await expect(client.query(`update taste_rejection_quotes set text = 'synthetic: give the card more room' where id = $1`, [id]))
      .rejects.toThrow(/his words are kept as he said them/)
    await expect(client.query(`update taste_rejection_quotes set said_at = said_at - interval '1 day' where id = $1`, [id]))
      .rejects.toThrow(/his words are kept as he said them/)
    await client.query(`update taste_rejection_quotes set attribution = 'krish_action', source = 'codex', said_where = 'a synthetic session, reread'
                        where id = $1`, [id])
    const [q] = (await client.query(`select text, attribution, source from taste_rejection_quotes where id = $1`, [id])).rows
    expect(q).toEqual({ text: 'synthetic: give the card room', attribution: 'krish_action', source: 'codex' })
  })

  it('keeps a record version as it was filed, and fills in only its withdrawal, what he liked nearby and its media', async () => {
    const said = await quote('synthetic: give the card room')
    const liked = await quote('synthetic: the grade is lovely')
    const id = await record([said])
    for (const set of [`reason = 'synthetic: another reason'`, `item = 'synthetic: another item'`, `theme = 'brand'`, `kind = 'liked'`]) {
      await expect(client.query(`update taste_rejections set ${set} where id = $1`, [id])).rejects.toThrow(/a record version is kept as it was filed/)
    }
    const hash = 'a'.repeat(64)
    await client.query(
      `update taste_rejections set withdrawn_at = now(), near = jsonb_build_array(jsonb_build_object('quote_id', $2::text, 'basis', 'same_message')),
         media_sha256 = array[$3] where id = $1`,
      [id, liked, hash])
    const [r] = (await client.query(`select withdrawn_at is not null as withdrawn, near, media_sha256 from taste_rejections where id = $1`, [id])).rows
    expect(r).toEqual({ withdrawn: true, near: [{ quote_id: liked, basis: 'same_message' }], media_sha256: [hash] })
  })

  it('refuses a record of his words that cites no quote of his words', async () => {
    const words = await quote('synthetic: give the card room')
    const paraphrase = await quote('synthetic: he wanted more room around the card', 'observation')
    await expect(record([])).rejects.toThrow(/taste_rejections_words_are_quoted/)
    await expect(record([paraphrase])).rejects.toThrow(/must cite a quote that is his words/)
    await expect(record(['00000000-0000-4000-8000-000000000000'])).rejects.toThrow(/cited quote\(s\) do not exist/)
    // A paraphrase can stand as an observation, and his words as his words.
    await record([paraphrase], { attribution: 'observation' })
    await record([words, paraphrase])
  })

  it('checks a record of his words once, when it is filed, so a version sent again after a reclass is skipped, not refused', async () => {
    const said = await quote('synthetic: give the card room')
    const insert = () => client.query(
      `insert into taste_rejections (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, strength, theme,
         formats, rule_kind, capture, rules_rev)
       values ('drive_dump', 'dump:synthetic-again', $1, 'rejected', '2026-10-20T12:00:00Z', array[$2::uuid], 'krish_words', 'disliked',
         'layout', '{short_video}', 'form', 'words', 'rules-v1')
       on conflict (source, source_ref, source_version) do nothing`,
      [md5('version again'), said])
    await insert()
    await client.query(`update taste_rejection_quotes set attribution = 'observation' where id = $1`, [said])
    // The same version again: skipped (a before trigger would fire for it, and refuse it, every run).
    await insert()
    // A new version of his words on that quote alone is refused.
    await expect(record([said])).rejects.toThrow(/must cite a quote that is his words/)
  })

  it('takes a standard\'s quote of him only when it is his words verbatim, whitespace aside, on a quote it cites', async () => {
    const said = await quote('synthetic: the  card hugs\nthe edge, give it room')
    const other = await quote('synthetic: something else he said')
    const paraphrase = await quote('synthetic: give it room, he said', 'observation')
    await standard({ quoteIds: [said], krish: ' the card hugs\tthe edge ', krishQuoteId: said })
    const refused = /krish must be his words, verbatim, on a cited quote of his/
    // Words he did not say, his words in another case, a quote the standard does not cite, and a paraphrase.
    await expect(standard({ quoteIds: [said], krish: 'the card hugs the frame edge', krishQuoteId: said })).rejects.toThrow(refused)
    await expect(standard({ quoteIds: [said], krish: 'The Card Hugs The Edge', krishQuoteId: said })).rejects.toThrow(refused)
    await expect(standard({ quoteIds: [said], krish: 'something else', krishQuoteId: other })).rejects.toThrow(refused)
    await expect(standard({ quoteIds: [said, paraphrase], krish: 'give it room', krishQuoteId: paraphrase })).rejects.toThrow(refused)
    // Whitespace alone is no quote of his, though a space is in nearly everything he said.
    for (const krish of ['\t', '\n', '  ']) {
      await expect(standard({ quoteIds: [said], krish, krishQuoteId: said })).rejects.toThrow(/taste_floor_standards_krish_check/)
    }
  })

  it('never puts a quote to him as his words once it is classed a paraphrase, as the floor view never shows it', async () => {
    const q = await quote('synthetic: the join chops the word')
    const w = await quote('synthetic: play every join with the sound on')
    await record([q, w])
    await standard({ quoteIds: [q, w], krish: 'chops the word', krishQuoteId: q })
    await client.query(`update taste_rejection_quotes set attribution = 'observation' where id = $1`, [q])
    await recountStandards(db, true)
    const [eligible] = await db.query<{ krish: string | null; support_n: number }>(FLOOR_ELIGIBLE_SQL)
    expect(eligible).toMatchObject({ krish: null, support_n: 1 })
    expect((await client.query(`select krish from taste_floor`)).rows).toEqual([{ krish: null }])
  })

  it('lets the engine\'s key withdraw and stamp, but never delete or empty what it filed', async () => {
    const q = await quote('synthetic: give it room')
    await record([q])
    for (const sql of ['delete from taste_rejection_quotes', 'delete from taste_rejections', 'truncate taste_rejection_inbox',
      'truncate taste_rejection_media', 'delete from taste_floor_standards']) {
      await client.query('begin')
      try {
        await client.query('set local role service_role')
        await expect(client.query(sql)).rejects.toThrow(/permission denied/)
      } finally { await client.query('rollback') }
    }
    await client.query('begin')
    try {
      await client.query('set local role service_role')
      await client.query(`update taste_rejections set withdrawn_at = now()`)
    } finally { await client.query('rollback') }
  })

  it('never rewrites a standard once it is on a proposal, though its status can still move', async () => {
    const q = await quote('synthetic: give it room')
    const id = await standard({ quoteIds: [q], status: 'proposed', proposalId: await proposal('proposed', null) })
    for (const set of [`statement = 'synthetic: always leave a title card more room.'`, `how_to_check = 'synthetic: look again, closer.'`,
      `formats = '{long_video}'`, `quote_ids = '{}'`, `proposal_id = null`]) {
      await expect(client.query(`update taste_floor_standards set ${set} where id = $1`, [id])).rejects.toThrow(/a standard on a proposal is never rewritten/)
    }
    await client.query(`update taste_floor_standards set status = 'retired' where id = $1`, [id])
    // A candidate is the engine's draft, and is rewritten freely.
    const draft = await standard({ quoteIds: [q] })
    await client.query(`update taste_floor_standards set statement = 'synthetic: always leave a title card more room.' where id = $1`, [draft])
  })

  it('counts support as the distinct quotes of his words in standing rejected or process records, recounted when touched', async () => {
    const w1 = await quote('synthetic: give it room')
    const w2 = await quote('synthetic: stop asking and just start')
    const a1 = await quote('synthetic: yes to all four', 'krish_action')
    const o1 = await quote('synthetic: he wanted more room', 'observation')
    const l1 = await quote('synthetic: the grade is lovely')
    const r1 = await record([w1, a1, o1])
    const r2 = await record([w1, w2], { kind: 'process' })
    // His words in a liked record are the boundary, never support.
    await record([l1], { kind: 'liked' })
    const id = await standard({ quoteIds: [w1, w2, a1, o1, l1] })
    // w1 stands in two records and counts once; the paraphrase never counts.
    expect(await supportOf(id)).toEqual({ support_n: 2, action_n: 1 })

    await client.query(`update taste_rejections set withdrawn_at = now() where id = $1`, [r1])
    // The count is the database's, taken when the standard is written: untouched, it still says what it said.
    expect(await supportOf(id)).toEqual({ support_n: 2, action_n: 1 })
    expect(await recountStandards(db, true)).toBe(1)
    // w1 still stands in the process record; his approval stood only in the record withdrawn.
    expect(await supportOf(id)).toEqual({ support_n: 2, action_n: 0 })
    await client.query(`update taste_rejections set withdrawn_at = now() where id = $1`, [r2])
    await recountStandards(db, true)
    expect(await supportOf(id)).toEqual({ support_n: 0, action_n: 0 })
  })

  it('labels the floor draft, approved or reworded, shows his reword as the statement, and hides what he rejected', async () => {
    const q = await quote('synthetic: the card hugs the edge, give it room')
    const r = await record([q])
    const make = async (statement: string, status: string, proposalId?: string) =>
      standard({ quoteIds: [q], statement, krish: 'give it room', krishQuoteId: q, status, proposalId })
    await make('synthetic: a draft never put to him.', 'candidate')
    await make('synthetic: one put to him and not yet decided.', 'proposed', await proposal('proposed', null))
    await make('synthetic: one he approved.', 'proposed', await proposal('approved', 'Krish'))
    await make('synthetic: one he reworded.', 'proposed', await proposal('corrected', 'Krish', 'synthetic: never let a card touch the frame edge.'))
    // A correction nobody signed is not his reword.
    await make('synthetic: one corrected by nobody.', 'proposed', await proposal('corrected', null, 'synthetic: a note nobody signed.'))
    await make('synthetic: one he rejected.', 'proposed', await proposal('rejected', 'Krish'))
    await make('synthetic: one retired.', 'retired')
    const floor = async () => (await client.query(`select standing, statement, krish from taste_floor`)).rows
      .sort((a, b) => (a.statement < b.statement ? -1 : 1))
    expect(await floor()).toEqual([
      { standing: 'draft', statement: 'synthetic: a draft never put to him.', krish: 'give it room' },
      { standing: 'reworded', statement: 'synthetic: never let a card touch the frame edge.', krish: 'give it room' },
      { standing: 'draft', statement: 'synthetic: one corrected by nobody.', krish: 'give it room' },
      { standing: 'approved', statement: 'synthetic: one he approved.', krish: 'give it room' },
      { standing: 'draft', statement: 'synthetic: one put to him and not yet decided.', krish: 'give it room' },
    ])
    // His quote shows only while a record that stands still cites it.
    await client.query(`update taste_rejections set withdrawn_at = now() where id = $1`, [r])
    expect((await floor()).map(s => s.krish)).toEqual([null, null, null, null, null])
  })

  it('keeps an inbox capture as it was filed, stamps it collected once and for good, and files a retry once', async () => {
    const capture = (said: string) => client.query(
      `insert into taste_rejection_inbox (said, said_where, said_at, formats, session_ref, repository, surface, emitter_id,
         client_report_id, reported_at)
       values ($1, 'a synthetic session', '2026-10-27T10:00:00Z', '{short_video}', 'synthetic-session', 'synthetic/repo', 'cli',
         'synthetic-emitter', 'synthetic-capture-000001', '2026-10-27T10:05:00Z') returning id::text`,
      [said])
    const id = (await capture('synthetic: the lower third covers his face')).rows[0].id as string
    for (const set of [`said = 'synthetic: something else'`, `said_at = said_at - interval '1 day'`, `formats = '{long_video}'`,
      `piece = 'synthetic piece'`, `kind = 'liked'`]) {
      await expect(client.query(`update taste_rejection_inbox set ${set} where id = $1`, [id])).rejects.toThrow(/a capture is kept as it was filed/)
    }
    // The engine stamps it (and notes its run) once it is filed.
    await client.query(`update taste_rejection_inbox set collected_at = now(), meta = '{"run_id": "synthetic"}' where id = $1`, [id])
    await expect(client.query(`update taste_rejection_inbox set collected_at = null where id = $1`, [id])).rejects.toThrow(/a filed capture stays filed/)
    // A raw screenshot is never changed, and let go only once its capture is collected.
    const shot = (await client.query(
      `insert into taste_rejection_inbox (said, said_where, said_at, screenshot, screenshot_mime, session_ref, repository, surface, emitter_id,
         client_report_id, reported_at)
       values ('synthetic: a shot', 'a synthetic session', '2026-10-27T10:00:00Z', $1, 'image/png', 'synthetic-session', 'synthetic/repo', 'cli',
         'synthetic-emitter', 'synthetic-capture-000099', '2026-10-27T10:05:00Z') returning id::text`,
      [labelled('image/png', randomBytes(100))])).rows[0].id as string
    await expect(client.query(`update taste_rejection_inbox set screenshot = null, screenshot_mime = null where id = $1`, [shot]))
      .rejects.toThrow(/a capture is kept as it was filed/)
    await client.query(`update taste_rejection_inbox set collected_at = now() where id = $1`, [shot])
    await expect(client.query(`update taste_rejection_inbox set screenshot = $2 where id = $1`, [shot, labelled('image/png', randomBytes(100))]))
      .rejects.toThrow(/a capture is kept as it was filed/)
    await client.query(`update taste_rejection_inbox set screenshot = null, screenshot_mime = null where id = $1`, [shot])
    await expect(capture('synthetic: the same capture, sent again')).rejects.toThrow(/taste_rejection_inbox_retry_once/)
  })

  it('takes a capture in one shape only: words, a screenshot, a master by id with the moment, or a whole cut by id', async () => {
    let k = 0
    const shape = (o: { shot?: Buffer; mime?: string; master?: string; sha?: string; atMs?: number; wholeCut?: boolean }) => client.query(
      `insert into taste_rejection_inbox (said, said_where, said_at, screenshot, screenshot_mime, master_drive_id, master_sha256, at_ms,
         whole_cut, session_ref, repository, surface, emitter_id, client_report_id, reported_at)
       values ('synthetic: a capture', 'a synthetic session', '2026-10-27T10:00:00Z', $1, $2, $3, $4, $5, $6, 'synthetic-session',
         'synthetic/repo', 'cli', 'synthetic-emitter', $7, '2026-10-27T10:05:00Z')`,
      [o.shot ?? null, o.shot ? (o.mime ?? 'image/png') : null, o.master ?? null, o.sha ?? null, o.atMs ?? null, o.wholeCut ?? false,
        `synthetic-shape-${String(k++).padStart(8, '0')}`])
    const master = '1SYNTHETICmasterid0000000009'
    const png = labelled('image/png', randomBytes(100))
    for (const ok of [{}, { shot: png }, { master, atMs: 3000 }, { master, wholeCut: true }, { master, sha: 'b'.repeat(64), atMs: 3000 }]) await shape(ok)
    for (const bad of [
      { shot: png, master }, { shot: png, atMs: 3000 }, { master }, { sha: 'b'.repeat(64), atMs: 3000 }, { sha: 'b'.repeat(64), wholeCut: true },
      { master, atMs: 3000, wholeCut: true }, { atMs: 3000 },
    ]) await expect(shape(bad), JSON.stringify(Object.keys(bad))).rejects.toThrow(/taste_rejection_inbox_one_shape/)
    // A screenshot is the image it says it is.
    await expect(shape({ shot: labelled('video/mp4', randomBytes(100)), mime: 'image/png' })).rejects.toThrow(/taste_rejection_inbox_screenshot_is_an_image/)
  })
})

runJob('the rejections job, end to end, on a real database', () => {
  let client: pg.Client
  let db: Db
  let fx = ''
  const runId = '33333333-3333-3333-3333-333333333333'
  const now = new Date('2026-10-28T12:00:00Z')

  beforeAll(async () => {
    ({ client, db } = await freshSchema())
    // Two tiny stills made here: one in the folder, one a session captured.
    fx = mkdtempSync(join(tmpdir(), 'rejection-int-test-'))
    for (const [name, colour] of [['still.png', 'red'], ['shot.png', 'blue']] as const) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=64x36`, '-frames:v', '1', join(fx, name)])
    }
  }, 30_000)
  afterAll(async () => {
    await client?.end()
    if (fx) rmSync(fx, { recursive: true, force: true })
  })

  // The folder: one record kept as a still, one as words, one paraphrase, what he liked in the same breath, and how a
  // session worked with him.
  const A = { id: 'syn-001', date: '2026-10-20', piece: 'synthetic piece one', format: 'Short cut 9:16', category: 'Visual',
    theme: 'Layout, composition and alignment', item: 'synthetic: the title card crowds the left edge',
    quotes: [{ text: 'synthetic: the card hugs the edge, give it room', when: '2026-10-20T10:15:00Z', source: 'cloud' }],
    reason: 'synthetic: no room around the card', strength: 'Disliked', confidence: 'krish verbatim' }
  const B = { id: 'syn-002', date: '2026-10-21', piece: 'synthetic piece two', format: 'Script', category: 'Copy',
    theme: "Copy a stranger can't follow", item: 'synthetic: a line that leans on a word nobody outside knows',
    quotes: [{ text: 'synthetic: nobody outside the room knows that word', when: '2026-10-21', source: 'codex' }],
    strength: 'Rejected', confidence: 'direct quote' }
  const C = { id: 'syn-003', date: '2026-10-21', piece: 'synthetic piece two', format: 'Script', category: 'Copy',
    theme: 'Voice and tone', item: 'synthetic: the close sounds like an advert',
    quotes: [{ text: 'synthetic: he said the close sounded like an advert', when: '2026-10-21', source: 'cloud' }],
    strength: 'Disliked', confidence: 'paraphrased ruling' }
  const L = { id: 'syn-101', date: '2026-10-20', piece: 'synthetic piece one', format: 'Short cut 9:16', category: 'Visual',
    item: 'synthetic: the colour grade',
    quotes: [{ text: 'synthetic: the colour grade is lovely', when: '2026-10-20T10:15:00Z', source: 'cloud' }],
    strength: 'Liked', confidence: 'krish verbatim' }
  const P = { id: 'syn-201', date: '2026-10-22', category: 'Process', item: 'synthetic: the session asked five questions before it started',
    quotes: [{ text: 'synthetic: stop asking and just start', when: '2026-10-22T09:00:00Z', source: 'local' }],
    strength: 'Disliked', confidence: 'krish verbatim' }
  const STILL_PATH = 'synthetic-stills/syn-001 card.png'
  const ids = {
    data: '1SYNTHETICfolderid0000000001', stills: '1SYNTHETICfolderid0000000002', still: '1SYNTHETICfileid000000000001',
    rejected: '1SYNTHETICfileid000000000002', liked: '1SYNTHETICfileid000000000003', process: '1SYNTHETICfileid000000000004',
    manifest: '1SYNTHETICfileid000000000005',
  }

  type Folder = { rejected: object[] | string | null; liked: object[] | null; process: object[]; manifest: object[] }
  /** The folder as a later merge pass leaves it: its rejections (or raw text, or no file at all), renumbered or not. */
  const dump = (o: { rejected?: object[] | string | null; process?: object[]; renumber?: boolean } = {}): Folder => {
    const re = (r: object) => (o.renumber ? { ...r, id: `${(r as { id: string }).id}-renumbered` } : r)
    const rejected = o.rejected === undefined ? [A, B, C] : o.rejected
    return {
      rejected: Array.isArray(rejected) ? rejected.map(re) : rejected,
      liked: [L].map(re), process: (o.process ?? [P]).map(re),
      manifest: [{ id: (re(A) as { id: string }).id, files: [STILL_PATH] }],
    }
  }
  const driveFile = (id: string, name: string, mimeType: string): DriveFile =>
    ({ id, name, mimeType, modifiedTime: '2026-10-28T09:00:00Z', createdTime: '2026-10-28T09:00:00Z' })
  const jsonl = (rows: object[]) => Buffer.from(`${rows.map(r => JSON.stringify(r)).join('\n')}\n`)
  /** A read-only Drive holding the Rejections folder, or (null) an empty one, and the masters it lets the engine see. */
  const drive = (folder: Folder | null, masters: DriveFile[] = []): Google => {
    const tree = new Map<string, DriveFile[]>()
    const bytes = new Map<string, Buffer>()
    if (folder) {
      tree.set(DRIVE.rejections, [driveFile(ids.data, 'data', FOLDER_MIME), driveFile(ids.stills, 'synthetic-stills', FOLDER_MIME),
        driveFile(ids.manifest, '_manifest.json', 'application/json')])
      const data = [driveFile(ids.process, 'process.jsonl', 'application/x-ndjson')]
      if (folder.liked !== null) data.unshift(driveFile(ids.liked, 'liked.jsonl', 'application/x-ndjson'))
      if (folder.rejected !== null) data.unshift(driveFile(ids.rejected, 'rejections.jsonl', 'application/x-ndjson'))
      tree.set(ids.data, data)
      tree.set(ids.stills, [driveFile(ids.still, 'syn-001 card.png', 'image/png')])
      if (folder.rejected !== null) bytes.set(ids.rejected, typeof folder.rejected === 'string' ? Buffer.from(folder.rejected) : jsonl(folder.rejected))
      if (folder.liked !== null) bytes.set(ids.liked, jsonl(folder.liked))
      bytes.set(ids.process, jsonl(folder.process))
      bytes.set(ids.manifest, Buffer.from(JSON.stringify(folder.manifest)))
      bytes.set(ids.still, readFileSync(join(fx, 'still.png')))
    }
    return {
      listFolder: async (id: string) => tree.get(id) ?? [],
      download: async (id: string, maxBytes = 20_000_000) => {
        const b = bytes.get(id)
        if (!b) throw new Error('google download failed: HTTP 404')
        if (b.length > maxBytes) throw new Error('google download refused: file is over the size cap')
        return b
      },
      file: async (id: string) => masters.find(m => m.id === id) ?? null,
      downloadTo: async () => { throw new Error('synthetic: no master is fetched in this suite') },
    } as unknown as Google
  }

  // The model, fixed: four standards for the short cut, each citing the first record it is shown and quoting him
  // verbatim. Only the short cut's group can take them, so every other group's answer resolves to nothing.
  const answer: { standards: DraftStandard[] } = {
    standards: ['the frame edge', 'the safe area', 'the caption band', 'the lower third'].map(where => ({
      statement: `synthetic: always leave a title card room at ${where}.`,
      how_to_check: `synthetic: scrub to each title card and look at ${where}.`,
      formats: ['short_video'], theme: 'layout', layer: 'graphics', kind: 'form',
      records: [0], krish_quote_ref: 0, krish_quote: 'give it room', boundary: [0],
    })),
  }
  const llm: Llm = { model: 'stub', structured: async () => ({ failure: null, model: 'stub', data: answer as never }) }

  // The real Db, with the order of the job's writes kept, so a test can say what was written before what.
  let writes: string[] = []
  const watched: Db = {
    query: async <T,>(sql: string, params: unknown[] = [], o?: { write?: boolean }) => {
      if (o?.write) writes.push(sql)
      return db.query<T>(sql, params, o)
    },
    close: async () => {},
  }
  const results: RejectionsResult[] = []
  const job = async (google: Google, over: Partial<RejectionsDeps> = {}) => {
    writes = []
    const r = await runRejections({ db: watched, google, llm, cfg: loadConfig({}), runId, write: true, propose: true, now, gh: null, ...over })
    results.push(r)
    return r
  }
  const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0]
  const tally = async () => one(
    `select (select count(*)::int from taste_rejection_quotes) as quotes, (select count(*)::int from taste_rejections) as records,
            (select count(*)::int from taste_rejections where withdrawn_at is null) as standing,
            (select count(*)::int from taste_rejection_media) as media, (select count(*)::int from taste_floor_standards) as standards,
            (select count(*)::int from mindmake_studio_learning_proposals) as proposals`)
  const quoteId = async (text: string) => (await one(`select id::text from taste_rejection_quotes where text = $1`, [text])).id as string

  let firstWrites: string[] = []

  it('files his quotes and each record from the folder', async () => {
    const r = await job(drive(dump()))
    firstWrites = writes
    expect(r.problems).toEqual([])
    expect(r.input).toBe(5)
    expect(r.counts).toMatchObject({
      rejections_table_missing: 0, rejections_read_rejected: 3, rejections_read_liked: 1, rejections_read_process: 1,
      rejections_quotes_new: 5, rejections_records_new: 5, rejections_records_withdrawn: 0, rejections_near: 1,
    })
    const quotes = (await client.query(`select text, attribution, said_precision from taste_rejection_quotes order by text collate "C"`)).rows
    expect(quotes).toEqual([
      { text: 'synthetic: he said the close sounded like an advert', attribution: 'observation', said_precision: 'day' },
      { text: 'synthetic: nobody outside the room knows that word', attribution: 'krish_words', said_precision: 'day' },
      { text: 'synthetic: stop asking and just start', attribution: 'krish_words', said_precision: 'second' },
      { text: 'synthetic: the card hugs the edge, give it room', attribution: 'krish_words', said_precision: 'second' },
      { text: 'synthetic: the colour grade is lovely', attribution: 'krish_words', said_precision: 'second' },
    ])
    const records = (await client.query(
      `select kind, item, attribution, capture, rule_kind, cardinality(quote_ids)::int as quotes, withdrawn_at is null as standing
       from taste_rejections order by kind, item collate "C"`)).rows
    expect(records).toEqual([
      { kind: 'liked', item: L.item, attribution: 'krish_words', capture: 'words', rule_kind: 'form', quotes: 1, standing: true },
      { kind: 'process', item: P.item, attribution: 'krish_words', capture: 'words', rule_kind: 'workflow', quotes: 1, standing: true },
      { kind: 'rejected', item: B.item, attribution: 'krish_words', capture: 'words', rule_kind: 'form', quotes: 1, standing: true },
      { kind: 'rejected', item: C.item, attribution: 'observation', capture: 'words', rule_kind: 'form', quotes: 1, standing: true },
      { kind: 'rejected', item: A.item, attribution: 'krish_words', capture: 'still', rule_kind: 'form', quotes: 1, standing: true },
    ])
  })

  it('keeps the still a record names as a capped JPEG, and what he liked in the same message beside it', async () => {
    expect(results[0]!.counts).toMatchObject({ rejections_media_stills: 1, rejections_media_failed: 0 })
    const a = await one(`select media_sha256, near from taste_rejections where item = $1`, [A.item])
    const kept = (await client.query(
      `select sha256, role, mime, derived_from, octet_length(bytes) <= 400000 as capped from taste_rejection_media`)).rows
    expect(kept).toEqual([{ sha256: a.media_sha256[0], role: 'screenshot', mime: 'image/jpeg', derived_from: ids.still, capped: true }])
    expect(a.near).toEqual([{ quote_id: await quoteId(L.quotes[0]!.text), basis: 'same_message' }])
  })

  it('writes the standards as candidates, then puts them all to him in one batch from the rejections source', async () => {
    expect(results[0]!.counts).toMatchObject({ rejections_standards_written: 4, rejections_eligible: 4, rejections_proposed: 4 })
    const standards = (await client.query(
      `select s.status, s.support_n, s.krish, s.formats, s.boundary_quote_ids::text[] as boundary, p.weekly_batch_id as batch,
              p.scope->>'source' as source, p.scope->>'standard_id' as standard_id, s.id::text, p.status as decision, p.decided_by
       from taste_floor_standards s join mindmake_studio_learning_proposals p on p.id = s.proposal_id`)).rows
    // More than the ceiling's weekly cap: the floor goes to him whole, never three at a time.
    expect(standards).toHaveLength(4)
    expect(standards.length).toBeGreaterThan(WEEKLY_PROPOSAL_CAP)
    const liked = await quoteId(L.quotes[0]!.text)
    for (const s of standards) {
      expect(s).toMatchObject({ status: 'proposed', support_n: 1, krish: 'give it room', formats: ['short_video'], boundary: [liked],
        batch: 'floor-2026-10-26', source: 'rejections', standard_id: s.id, decision: 'proposed', decided_by: null })
    }
    // He decides on the check with the statement, so the check that binds once he approves is one he saw.
    const assertions = (await client.query(`select assertion from mindmake_studio_learning_proposals order by assertion collate "C"`)).rows.map(r => r.assertion)
    expect(assertions[0]).toBe('Floor for short_video: synthetic: always leave a title card room at the caption band. (In his words: "give it room") '
      + 'Check before delivery: synthetic: scrub to each title card and look at the caption band.')
    // Written as candidates first: every standard went in before any proposal did, and the database refuses a proposed
    // standard with no proposal, so each one stood as a candidate until its proposal was made.
    const lastStandard = firstWrites.findLastIndex(s => /insert into public\.taste_floor_standards/.test(s))
    const firstProposal = firstWrites.findIndex(s => /insert into public\.mindmake_studio_learning_proposals/.test(s))
    expect(lastStandard).toBeGreaterThanOrEqual(0)
    expect(lastStandard).toBeLessThan(firstProposal)
  })

  it('writes nothing new on a second run, even from a dump a later merge pass renumbered', async () => {
    const before = await tally()
    const r = await job(drive(dump({ renumber: true })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({
      rejections_quotes_new: 0, rejections_quotes_reclassed: 0, rejections_records_new: 0, rejections_records_restored: 0,
      rejections_records_withdrawn: 0, rejections_near: 0, rejections_media_stills: 0, rejections_media_reused: 1,
      rejections_distil_skipped: 1, rejections_standards_written: 0, rejections_proposed: 0,
    })
    expect(await tally()).toEqual(before)
  })

  it('withdraws exactly the record a later dump drops, and leaves the standards he was shown as they were', async () => {
    const shown = (await client.query(`select id::text, statement, status from taste_floor_standards order by id`)).rows
    const r = await job(drive(dump({ rejected: [A, C] })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({ rejections_records_new: 0, rejections_records_withdrawn: 1, rejections_distil_skipped: 0 })
    expect((await client.query(`select item from taste_rejections where withdrawn_at is not null`)).rows).toEqual([{ item: B.item }])
    expect((await tally()).standing).toBe(4)
    expect((await client.query(`select id::text, statement, status from taste_floor_standards order by id`)).rows).toEqual(shown)
  })

  it('refuses an empty read of the folder as a problem, and withdraws nothing', async () => {
    const before = await tally()
    // An empty folder, and one holding everything but its rejections file.
    for (const google of [drive(null), drive(dump({ rejected: null }))]) {
      const r = await job(google)
      expect(r.problems).toEqual(['rejections read: Error'])
      // The reports are their own read and are still filed; nothing of the folder's is withdrawn.
      expect(r.counts.rejections_records_withdrawn ?? 0).toBe(0)
      expect(await tally()).toEqual(before)
    }
    expect((await client.query(`select item from taste_rejections where withdrawn_at is not null`)).rows).toEqual([{ item: B.item }])
  })

  it('retires a standard whose proposal he rejected, and never puts it to him again', async () => {
    const { id, proposal_id } = await one(`select id::text, proposal_id::text from taste_floor_standards order by statement collate "C" limit 1`)
    await client.query(`update mindmake_studio_learning_proposals set status = 'rejected', decided_at = now(), decided_by = 'Krish' where id = $1`, [proposal_id])
    const r = await job(drive(dump({ rejected: [A, C] })))
    expect(r.problems).toEqual([])
    expect(r.counts.rejections_retired).toBe(1)
    expect((await one(`select status from taste_floor_standards where id = $1`, [id])).status).toBe('retired')
    const floor = (await client.query(`select id::text, standing from taste_floor`)).rows
    expect(floor).toHaveLength(3)
    expect(floor.map(s => s.id)).not.toContain(id)
    expect(floor.every(s => s.standing === 'draft')).toBe(true)
    const again = await job(drive(dump({ rejected: [A, C] })))
    expect(again.counts).toMatchObject({ rejections_retired: 0, rejections_proposed: 0 })
    expect((await one(`select status from taste_floor_standards where id = $1`, [id])).status).toBe('retired')
    expect((await tally()).proposals).toBe(4)
  })

  it('files a capture from the inbox, keeps its screenshot on its record, and stamps it collected', async () => {
    const shot = readFileSync(join(fx, 'shot.png'))
    const { id } = await one(
      `insert into taste_rejection_inbox (kind, said, said_where, said_at, piece, formats, screenshot, screenshot_mime, session_ref,
         repository, surface, emitter_id, client_report_id, reported_at)
       values ('rejected', 'synthetic: the lower third covers his face', 'a synthetic session', '2026-10-27T10:00:00Z',
         'synthetic piece three', '{short_video}', $1, 'image/png', 'synthetic-session', 'synthetic/repo', 'cli', 'synthetic-emitter',
         'synthetic-capture-000001', '2026-10-27T10:05:00Z') returning id::text`,
      [shot])
    const r = await job(drive(dump({ rejected: [A, C] })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({
      rejections_inbox: 1, rejections_inbox_screenshots: 1, rejections_inbox_collected: 1,
      rejections_quotes_new: 1, rejections_records_new: 1, rejections_records_withdrawn: 0,
    })
    const rec = await one(
      `select kind, attribution, capture, formats, media_sha256, withdrawn_at is null as standing from taste_rejections
       where source = 'inbox' and source_ref = $1`, [`inbox:${id}`])
    expect(rec).toMatchObject({ kind: 'rejected', attribution: 'krish_words', capture: 'still', formats: ['short_video'], standing: true })
    expect(rec.media_sha256).toHaveLength(1)
    expect(await one(`select role, mime, derived_from, octet_length(bytes) <= 400000 as capped from taste_rejection_media where sha256 = $1`,
      [rec.media_sha256[0]])).toEqual({ role: 'screenshot', mime: 'image/jpeg', derived_from: null, capped: true })
    expect(await one(`select source, attribution from taste_rejection_quotes where text = 'synthetic: the lower third covers his face'`))
      .toEqual({ source: 'capture', attribution: 'krish_words' })
    expect(await one(`select collected_at is not null as collected, meta->>'run_id' as run from taste_rejection_inbox where id = $1`, [id]))
      .toEqual({ collected: true, run: runId })
    // Its raw upload is let go once its still is kept: what stays is the re-encoded still on the record.
    expect(await one(`select screenshot is null as released, screenshot_mime is null as mime_gone, meta->>'screenshot_released' as noted
                      from taste_rejection_inbox where id = $1`, [id])).toEqual({ released: true, mime_gone: true, noted: 'true' })
    // Read once: the next run neither reads it again nor withdraws what it filed.
    const again = await job(drive(dump({ rejected: [A, C] })))
    expect(again.counts.rejections_inbox).toBe(0)
    expect((await one(`select withdrawn_at is null as standing from taste_rejections where source = 'inbox'`)).standing).toBe(true)
  })

  it('withdraws nothing of a kind whose file is missing or will not parse whole, and keeps what he liked nearby', async () => {
    const before = await tally()
    const nearBefore = (await one(`select near from taste_rejections where item = $1 and withdrawn_at is null`, [A.item])).near
    // No liked file: his liked record stands, and the record beside it keeps it as nearby.
    const noLiked = await job(drive({ ...dump({ rejected: [A, C] }), liked: null }))
    expect(noLiked.problems).toEqual([])
    expect(noLiked.counts).toMatchObject({ rejections_read_liked: 0, rejections_read_whole: 2, rejections_records_withdrawn: 0 })
    expect(noLiked.counts.rejections_near).toBeUndefined()
    // A rejections file with a line that will not parse: C, missing from what parsed, is not withdrawn.
    const half = await job(drive(dump({ rejected: `${JSON.stringify(A)}\nsynthetic: not a record\n` })))
    expect(half.problems).toEqual(['rejections read: 1 line(s) did not parse; nothing of their kind was withdrawn'])
    expect(half.counts).toMatchObject({
      rejections_read_rejected: 1, rejections_bad_rejected_json: 1, rejections_read_whole: 2, rejections_records_withdrawn: 0,
    })
    // A liked file there and empty: the same, and the run says so.
    const emptyLiked = await job(drive({ ...dump({ rejected: [A, C] }), liked: [] }))
    expect(emptyLiked.problems).toEqual(['rejections read: the liked file holds no record; nothing of its kind was withdrawn'])
    expect(emptyLiked.counts).toMatchObject({ rejections_read_liked: 0, rejections_read_whole: 2, rejections_records_withdrawn: 0 })
    expect(emptyLiked.counts.rejections_near).toBeUndefined()
    expect(await tally()).toEqual(before)
    const standing = (await client.query(`select item from taste_rejections where withdrawn_at is null and source = 'drive_dump'`)).rows.map(r => r.item)
    expect(standing).toEqual(expect.arrayContaining([A.item, C.item, L.item, P.item]))
    expect((await one(`select near from taste_rejections where item = $1 and withdrawn_at is null`, [A.item])).near).toEqual(nearBefore)
  })

  it('leaves a capture in the inbox until what it asks for has landed, and collects it once it has', async () => {
    const master = '1SYNTHETICmasterid0000000001'
    const unseen = '1SYNTHETICmasterid0000000002'
    const insert = (o: { said: string; key: string; master: string; atMs: number | null; wholeCut: boolean }) => one(
      `insert into taste_rejection_inbox (kind, said, said_where, said_at, piece, formats, master_drive_id, at_ms, whole_cut,
         session_ref, repository, surface, emitter_id, client_report_id, reported_at)
       values ('rejected', $1, 'a synthetic session', '2026-10-27T11:00:00Z', 'synthetic piece four', '{long_video}', $2, $3, $4,
         'synthetic-session', 'synthetic/repo', 'cli', 'synthetic-emitter', $5, '2026-10-27T11:05:00Z') returning id::text`,
      [o.said, o.master, o.atMs, o.wholeCut, o.key])
    const whole = await insert({ said: 'synthetic: the whole cut drags', key: 'synthetic-capture-000002', master, atMs: null, wholeCut: true })
    const moment = await insert({ said: 'synthetic: the word is chopped here', key: 'synthetic-capture-000003', master: unseen, atMs: 12_000, wholeCut: false })
    const collected = async () => (await client.query(
      `select id::text from taste_rejection_inbox where collected_at is not null and id = any($1::uuid[])`, [[whole.id, moment.id]])).rows.map(r => r.id)

    // Neither master is shared with the engine yet: both are filed, and both wait.
    const first = await job(drive(dump({ rejected: [A, C] })))
    expect(first.problems).toEqual([])
    expect(first.counts).toMatchObject({ rejections_inbox: 2, rejections_inbox_collected: 0, rejections_inbox_waiting: 2, rejections_records_new: 2 })
    expect(await collected()).toEqual([])

    // The whole cut's master is shared now (too long to fetch, which a pointer never needs): it is pointed at and
    // collected. The moment's master is still out of reach, so it waits, filed once.
    const big = { ...driveFile(master, 'synthetic master.mp4', 'video/mp4'), size: '2000000000' } as DriveFile
    const second = await job(drive(dump({ rejected: [A, C] }), [big]))
    expect(second.problems).toEqual([])
    expect(second.counts).toMatchObject({
      rejections_inbox: 2, rejections_inbox_collected: 1, rejections_inbox_waiting: 1, rejections_records_new: 0, rejections_media_pointed: 1,
    })
    expect(await collected()).toEqual([whole.id])
    expect(await one(`select capture, master_drive_id from taste_rejections where source_ref = $1`, [`inbox:${whole.id}`]))
      .toEqual({ capture: 'whole_cut', master_drive_id: master })
    expect(await one(`select capture, moment_ms, cardinality(media_sha256)::int as media from taste_rejections where source_ref = $1`, [`inbox:${moment.id}`]))
      .toEqual({ capture: 'moment', moment_ms: 12_000, media: 0 })
    const third = await job(drive(dump({ rejected: [A, C] }), [big]))
    expect(third.counts).toMatchObject({ rejections_inbox: 1, rejections_inbox_collected: 0, rejections_inbox_waiting: 1, rejections_records_new: 0 })
    // A master never shared must not hold the inbox for good: past the wait, his words are kept and the run says so.
    const later = await job(drive(dump({ rejected: [A, C] }), [big]), { now: new Date(Date.parse('2026-10-27T11:05:00Z') + (INBOX_WAIT_DAYS + 1) * 86_400_000) })
    expect(later.problems).toEqual([`rejections inbox: 1 capture(s) kept as words only: their media did not land in ${INBOX_WAIT_DAYS} days`])
    expect(later.counts).toMatchObject({ rejections_inbox: 1, rejections_inbox_collected: 0, rejections_inbox_gave_up: 1, rejections_inbox_waiting: 0 })
    expect(await one(`select collected_at is not null as collected, meta->>'collected_reason' as reason from taste_rejection_inbox where id = $1`, [moment.id]))
      .toEqual({ collected: true, reason: 'media_never_landed' })
    expect(await one(`select withdrawn_at is null as standing from taste_rejections where source_ref = $1`, [`inbox:${moment.id}`])).toEqual({ standing: true })
  })

  // A later merge pass marks his process words a paraphrase, and a later one puts them back.
  const Pp = { ...P, confidence: 'paraphrased ruling' }
  const fifth: DraftStandard = { ...answer.standards[0]!, statement: 'synthetic: always leave a title card room at the top edge.' }
  const five: Llm = { model: 'stub', structured: async () => ({ failure: null, model: 'stub', data: { standards: [...answer.standards, fifth] } as never }) }

  it('files a reclassed record as a new version under its new label, and withdraws the old one though its quote is no longer his words', async () => {
    const r = await job(drive(dump({ rejected: [A, C], process: [Pp] })), { llm: five })
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({
      rejections_quotes_reclassed: 1, rejections_records_new: 1, rejections_records_withdrawn: 1, rejections_distil_skipped: 0,
      rejections_standards_written: 1, rejections_batch_waiting: 1, rejections_proposed: 0,
    })
    expect(await one(`select attribution from taste_rejection_quotes where text = $1`, [P.quotes[0]!.text])).toEqual({ attribution: 'observation' })
    const versions = (await client.query(
      `select attribution, withdrawn_at is null as standing from taste_rejections where kind = 'process' order by created_at, id`)).rows
    expect(versions).toEqual([{ attribution: 'krish_words', standing: false }, { attribution: 'observation', standing: true }])
    // The new standard waits as a candidate: this week's batch has already gone to him.
    expect(await one(`select status, proposal_id from taste_floor_standards where statement = $1`, [fifth.statement]))
      .toEqual({ status: 'candidate', proposal_id: null })
  })

  it('supersedes a candidate a later reading no longer drafts, and brings the same standard back when it is drafted again', async () => {
    const id = (await one(`select id::text from taste_floor_standards where statement = $1`, [fifth.statement])).id
    const status = async () => (await one(`select status from taste_floor_standards where id = $1`, [id])).status
    // His words back: the first version stands again, and a reading without the fifth standard supersedes it.
    const back = await job(drive(dump({ rejected: [A, C] })))
    expect(back.problems).toEqual([])
    expect(back.counts).toMatchObject({ rejections_quotes_reclassed: 1, rejections_records_restored: 1, rejections_records_withdrawn: 1, rejections_superseded: 1 })
    expect(await status()).toBe('superseded')
    // Drafted again: the same row, a candidate once more, and no second copy of it.
    const standards = (await tally()).standards
    const again = await job(drive(dump({ rejected: [A, C], process: [Pp] })), { llm: five })
    expect(again.problems).toEqual([])
    expect(again.counts).toMatchObject({ rejections_records_new: 0, rejections_records_restored: 1, rejections_standards_written: 1, rejections_superseded: 0 })
    expect(await status()).toBe('candidate')
    expect((await tally()).standards).toBe(standards)
    // And left as the earlier tests found it: his words standing, the fifth standard superseded.
    const last = await job(drive(dump({ rejected: [A, C] })))
    expect(last.problems).toEqual([])
    expect(await status()).toBe('superseded')
    expect(await one(`select attribution from taste_rejection_quotes where text = $1`, [P.quotes[0]!.text])).toEqual({ attribution: 'krish_words' })
  })

  it('cites his words through his words, when a session reports a quote the dump holds only as a paraphrase', async () => {
    // The same words on the same day: the dump's compiler marked them a paraphrase, and a session reported them as his.
    await client.query(
      `insert into taste_evidence (source, source_ref, source_version, occurred_at, attribution, polarity, lane, title, excerpt, meta)
       values ('session_report', 'report:synthetic-0001', '0123456789abcdef', '2026-10-21T15:00:00Z', 'krish_words', 'dislikes', 'production',
               'synthetic: the close of piece two', $1, $2)`,
      [C.quotes[0]!.text, JSON.stringify({ said_where: 'a synthetic session', repository: 'synthetic/repo' })])
    const r = await job(drive(dump({ rejected: [A, C] })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({ rejections_reports: 1, rejections_records_new: 1, rejections_quotes_reclassed: 1 })
    expect(await one(`select attribution, source from taste_rejection_quotes where text = $1`, [C.quotes[0]!.text]))
      .toEqual({ attribution: 'krish_words', source: 'session_report' })
    expect(await one(`select attribution, item, withdrawn_at is null as standing from taste_rejections where source = 'session_report'`))
      .toEqual({ attribution: 'krish_words', item: null, standing: true })
    // The dump's record keeps its own label: the compiler's paraphrase.
    expect(await one(`select attribution from taste_rejections where item = $1 and withdrawn_at is null`, [C.item])).toEqual({ attribution: 'observation' })
  })

  it('withdraws a reported rejection when he takes his last report back, though the read is then empty', async () => {
    await client.query(`update taste_evidence set withdrawn_at = now() where source_ref = 'report:synthetic-0001'`)
    const r = await job(drive(dump({ rejected: [A, C] })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({ rejections_reports: 0, rejections_records_withdrawn: 1 })
    expect(await one(`select withdrawn_at is not null as withdrawn from taste_rejections where source = 'session_report'`)).toEqual({ withdrawn: true })
  })

  it('keeps what he captured as his words, when a later dump holds the same words only as a paraphrase', async () => {
    const captured = 'synthetic: the lower third covers his face'
    const X = { id: 'syn-004', date: '2026-10-27', piece: 'synthetic piece three', format: 'Short cut 9:16', category: 'Visual',
      theme: 'Layout, composition and alignment', item: 'synthetic: a lower third over a face',
      quotes: [{ text: captured, when: '2026-10-27', source: 'cloud' }], strength: 'Disliked', confidence: 'paraphrased ruling' }
    const r = await job(drive(dump({ rejected: [A, C, X] })))
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({ rejections_quotes_reclassed: 0, rejections_records_new: 1 })
    expect(await one(`select attribution, source from taste_rejection_quotes where text = $1`, [captured])).toEqual({ attribution: 'krish_words', source: 'capture' })
    // The dump's record keeps its own label, and the capture's record of his words stands on his words.
    expect(await one(`select attribution from taste_rejections where item = $1`, [X.item])).toEqual({ attribution: 'observation' })
  })

  it('keeps every count of every run under a rejections_ key', () => {
    expect(results.length).toBeGreaterThanOrEqual(9)
    for (const r of results) for (const k of Object.keys(r.counts)) expect(k).toMatch(/^rejections_[a-z0-9_]+$/)
  })

  // Last in the suite: a broken read that went through would change what stands for every test after it.
  it('refuses a rejections file in which no line is a record, as it does a missing one, and withdraws nothing', async () => {
    const before = await tally()
    const r = await job(drive(dump({ rejected: 'synthetic: not a record\n{"synthetic": "nor this"}\n' })))
    expect(r.problems).toContain('rejections read: Error')
    expect(await tally()).toEqual(before)
  })
})

runJob('the same image kept from two Drive files, on a real database', () => {
  let client: pg.Client
  let db: Db
  let fx = ''
  beforeAll(async () => {
    ({ client, db } = await freshSchema())
    fx = mkdtempSync(join(tmpdir(), 'rejection-alias-test-'))
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x36', '-frames:v', '1', join(fx, 'twice.png')])
  }, 30_000)
  afterAll(async () => {
    await client?.end()
    if (fx) rmSync(fx, { recursive: true, force: true })
  })

  it('keeps it once, notes the second file beside it, and fetches neither again', async () => {
    const bytes = readFileSync(join(fx, 'twice.png'))
    const file = (id: string, name: string): DriveFile => ({ id, name, mimeType: 'image/png', modifiedTime: '2026-10-28T09:00:00Z', createdTime: '2026-10-28T09:00:00Z' })
    const first = file('1SYNTHETICfileid000000000101', 'twice one.png')
    const second = file('1SYNTHETICfileid000000000102', 'twice two.png')
    const files = new Map([['synthetic/twice one.png', first], ['synthetic/twice two.png', second]])
    const fetched: string[] = []
    const google = { download: async (id: string) => { fetched.push(id); return bytes }, file: async () => null, listFolder: async () => [] } as unknown as Google
    const rec = (ref: string, path: string) => ({
      source: 'drive_dump', sourceRef: `dump:${ref}`, version: md5(ref), kind: 'rejected', capture: 'still',
      media: { stills: [path], strips: [], masters: [], texts: 0 }, moment: null,
    }) as unknown as Parameters<typeof keepMedia>[2][number]
    const records = [rec('synthetic-twice-1', 'synthetic/twice one.png'), rec('synthetic-twice-2', 'synthetic/twice two.png')]
    const once = await keepMedia(db, google, records, files, true)
    expect(once).toMatchObject({ stills: 2, reused: 0, failed: 0 })
    const rows = (await client.query(`select derived_from, meta->'also_from' as also from taste_rejection_media`)).rows
    expect(rows).toEqual([{ derived_from: first.id, also: [{ id: second.id, sha: null }] }])
    const again = await keepMedia(db, google, records, files, true)
    expect(again).toMatchObject({ stills: 0, reused: 2, failed: 0 })
    expect(fetched).toEqual([first.id, second.id])
    // Noted once, however often it is kept again.
    await keepMedia(db, google, records, files, true)
    expect((await client.query(`select jsonb_array_length(meta->'also_from')::int as n from taste_rejection_media`)).rows).toEqual([{ n: 1 }])
  })
})
