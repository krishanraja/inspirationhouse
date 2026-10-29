import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { DRIVE } from '../src/config.ts'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'
import { countVentureMismatch, normalise, versionOf, writeEvidence, type Evidence } from '../src/evidence.ts'
import { syncReports } from '../src/collect/sessionReports.ts'
import { extractSignals } from '../src/signal/extract.ts'
import { claimFingerprint, distil, type DraftClaim } from '../src/distil/claims.ts'
import { propose } from '../src/publish/propose.ts'
import { fileReportDislike, reportedDislikes, uncollectedInbox, type ReportEvidence } from '../src/rejection/arrivals.ts'
import { distilFloor } from '../src/rejection/distil.ts'
import { loadFloor, renderFloor } from '../src/rejection/render.ts'
import { fileQuotes, fileRecords } from '../src/rejection/store.ts'
import type { RecordRow } from '../src/rejection/file.ts'
import { FORMATS } from '../src/rejection/vocab.ts'
import { CUE_VENTURE, folderVenture, ventureOf } from '../src/venture.ts'
import { VENTURE_STUBS } from './stubs.ts'

// The ledger keyed by venture (content-engine 20261117090000_taste_ventures.sql), against a real Postgres with
// content-engine's real migrations and stubs in place of the model. Synthetic rows only: nothing here is anything Krish
// said, any file in his Drive or any real report. TASTE_MIGRATION is the list test/pipeline.int.test.ts takes (its
// header is the one list), and this file runs once it holds 20261117090000_taste_ventures.sql.
//
// First the ledger as it stood: every migration but the venture one, with synthetic rows of every class that migration
// moves, and one row of every source the engine writes. Then the migration, its backfill and its triggers; then the
// engine's own functions on the migrated schema. It works in its own database beside the one given (<name>_venture,
// made on first use): vitest runs test files at the same time, and the other database files drop schema public in theirs.
const url = process.env.TEST_DATABASE_URL
const migrations = (process.env.TASTE_MIGRATION ?? '').split(',').map(f => f.trim()).filter(Boolean)
if (process.env.REQUIRE_DB_TESTS && !(url && migrations.length)) {
  throw new Error('REQUIRE_DB_TESTS is set but TEST_DATABASE_URL or TASTE_MIGRATION is missing')
}
if (url && !/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  throw new Error('TEST_DATABASE_URL must point at a local throwaway database')
}
const ventureFile = migrations.find(m => m.endsWith('_taste_ventures.sql'))
const before = migrations.filter(m => m !== ventureFile)
// CI lists every migration on content-engine's main: there, a list without the venture migration is a fault.
if (process.env.REQUIRE_DB_TESTS && !ventureFile) throw new Error('REQUIRE_DB_TESTS is set but TASTE_MIGRATION lacks the taste_ventures migration')
const run = url && ventureFile ? describe : describe.skip

async function ownDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    const name = `${(await admin.query(`select current_database() as name`)).rows[0].name}_venture`
    const held = await admin.query('select 1 from pg_database where datname = $1', [name])
    if (!held.rowCount) await admin.query(`create database ${admin.escapeIdentifier(name)}`)
    const own = new URL(url!)
    own.pathname = `/${name}`
    return own.toString()
  } finally {
    await admin.end()
  }
}

// A fresh public schema with the given migrations, the tables other repositories own and a Db on it.
async function freshSchema(files: string[]): Promise<{ client: pg.Client; db: Db }> {
  const client = new pg.Client({ connectionString: await ownDatabase() })
  await client.connect()
  await client.query('drop schema public cascade; create schema public;')
  await client.query(`do $$ declare r text; begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      begin execute format('create role %I', r); exception when duplicate_object or unique_violation then null; end;
    end loop;
  end $$;`)
  await client.query('grant usage on schema public to service_role; alter default privileges in schema public grant all on tables to service_role;')
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
    create table public.content_edit_events (actor text, action text, occurred_at timestamptz);
    ${VENTURE_STUBS}`)
  for (const file of files) await client.query(readFileSync(file, 'utf8'))
  const db: Db = {
    query: async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
    close: async () => {},
  }
  return { client, db }
}

const runId = '77777777-7777-7777-7777-777777777777'
const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const TARGET = { none: ID(9001), pulse: ID(9002), heart: ID(9003) }
const REPORT = { heart: ID(8001), content: ID(8002), held: ID(8003) }

// One row of every source, as each collector makes it, before anyone knows its venture.
type Row = Omit<Evidence, 'venture'>
const row = (source: Evidence['source'], ref: string, day: number, over: Partial<Row> = {}): Row => ({
  source, sourceRef: ref, occurredAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`, attribution: 'krish_words',
  polarity: 'likes', lane: 'voice', layer: null, title: `synthetic ${ref}`, excerpt: `synthetic: the words of ${ref}`, meta: {}, ...over,
})
const FIXTURES: Row[] = [
  row('learnings_json', 'l1', 1, { polarity: 'dislikes', excerpt: 'synthetic: and the ending drags' }),
  row('title_verdicts', 't1', 2, { layer: 'packaging' }),
  row('golden_examples', 'g1', 3),
  row('rejected_lines', 'r1', 4, { polarity: 'dislikes' }),
  row('style_references', 's1', 5, { lane: 'production' }),
  row('style_bank', 'b1', 6, { lane: 'production', attribution: 'krish_action', excerpt: null, layer: 'editing' }),
  row('drive_cold', 'synthetic-cold-file', 7, { lane: 'strategy', attribution: 'krish_action', excerpt: null }),
  row('drive_video', 'synthetic-video-file', 8, { lane: 'production', attribution: 'krish_action', excerpt: null }),
  row('what_i_like_sheet', 'w1#Tone', 9, { lane: 'production', layer: 'tone' }),
  row('idea_triage', ID(7001), 10, { lane: 'strategy' }),
  row('feedback_hist', 'f-nova', 11, { lane: 'visibility', attribution: 'krish_action', excerpt: null, meta: { agent: 'nova' } }),
  row('feedback_hist', 'f-nell', 12, { lane: 'visibility', attribution: 'krish_action', excerpt: null, meta: { agent: 'nell' } }),
  row('feedback_hist', 'f-cleo', 13, { lane: 'strategy', attribution: 'krish_action', excerpt: null, meta: { agent: 'cleo' } }),
  row('creator_move', ID(7002), 14, { lane: 'strategy', attribution: 'observation' }),
  row('visibility_target', TARGET.none, 15, { lane: 'visibility', layer: 'stage_format', attribution: 'krish_action', excerpt: null }),
  row('visibility_target', TARGET.pulse, 16, { lane: 'visibility', layer: 'stage_format', attribution: 'krish_action', excerpt: null }),
  row('visibility_target', TARGET.heart, 17, { lane: 'visibility', layer: 'stage_format', attribution: 'krish_action', excerpt: null }),
  row('drive_artifact', 'synthetic-artifact', 18, { lane: 'strategy', attribution: 'machine_inference' }),
  row('inspiration_page', ID(7003), 19, { lane: 'production' }),
  // What two filed reports became: one from Heartside (the repository as a session typed it), one from content-engine.
  row('session_report', `report:${REPORT.heart}`, 20, { lane: 'production', polarity: 'dislikes', excerpt: 'synthetic: the type crowds the photo',
    meta: { repository: 'krishanraja/Heartside', said_where: 'a synthetic Heartside session', report_id: REPORT.heart } }),
  row('session_report', `report:${REPORT.content}`, 21, { lane: 'production', polarity: 'dislikes', excerpt: 'synthetic: the thumbnail title fights the face',
    meta: { repository: 'krishanraja/content-engine', said_where: 'a synthetic content session', report_id: REPORT.content } }),
]
const byRef = (ref: string) => FIXTURES.find(f => f.sourceRef === ref)!

// The claim a later distil drafts again: the mixed candidate the migration supersedes has its fingerprint.
const PUBLICATION_DRAFT: DraftClaim = {
  statement: 'Synthetic: titles say the event in plain words.', lane: 'voice', layer: 'packaging', kind: 'form',
  why: 'Synthetic: he picks titles that name the event.', means: 'Synthetic: write the event, not the theme.',
  support: [0, 1, 2], counter: [], krish_quote_ref: null, krish_quote: null, flip_rule: 'Synthetic: he picks two abstract titles.',
}
const MINDMAKE_DRAFT: DraftClaim = {
  ...PUBLICATION_DRAFT, statement: 'Synthetic: stages with a named audience come first.', lane: 'visibility', layer: 'stage_format',
  why: 'Synthetic: he applies to rooms that name who is in them.', means: 'Synthetic: lead with the room.',
}

run('the ledger keyed by venture, on a real database', () => {
  let client: pg.Client
  let db: Db
  const ids = new Map<string, string>()
  const stored = async () => new Map((await client.query(`select source_ref, venture from taste_evidence`)).rows.map(r => [r.source_ref as string, r.venture as string]))
  // The venture src/venture.ts gives a fixture, from the row's own facts: its target's product, its agent, its report.
  const products = { [TARGET.none]: null, [TARGET.pulse]: 'fractionl_pulse', [TARGET.heart]: 'heartside' } as Record<string, string | null>
  const computed = async (r: Row) => {
    const report = r.source === 'session_report'
      ? (await client.query(`select venture from taste_reports where id = $1`, [String(r.meta.report_id)])).rows[0]?.venture ?? null
      : null
    return ventureOf(r.source, { product: products[r.sourceRef] ?? null, agent: r.meta.agent, report })
  }
  let heartRecord: RecordRow
  let contentRecord: RecordRow

  beforeAll(async () => { ({ client, db } = await freshSchema(before)) }, 60_000)
  afterAll(async () => { await client?.end() })

  it('moves every class of row the migration names, and leaves the rest Make Your Mind Up\'s', async () => {
    // The ledger as it stood, written as the engine wrote it then (no venture column yet), each row at its own version.
    await client.query(`insert into visibility_targets (id, product_slug) values ($1, null), ($2, 'fractionl_pulse'), ($3, 'heartside')`,
      [TARGET.none, TARGET.pulse, TARGET.heart])
    for (const f of FIXTURES) {
      const e = normalise({ ...f, venture: 'unknown' })
      const [{ id }] = (await client.query(
        `insert into taste_evidence (source, source_ref, source_version, occurred_at, attribution, polarity, lane, layer, title, excerpt, meta)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text`,
        [e.source, e.sourceRef, versionOf(e), e.occurredAt, e.attribution, e.polarity, e.lane, e.layer, e.title, e.excerpt, e.meta])).rows
      ids.set(f.sourceRef, id)
    }
    const report = (id: string, repository: string, collected: boolean) => client.query(
      `insert into taste_reports (id, kind, body, said_where, said_at, lane, polarity, session_ref, repository, surface, emitter_id,
         client_report_id, collected_at)
       values ($1, 'krish_words', 'synthetic: a report', 'a synthetic session', '2026-10-20T09:00:00Z', 'production', 'dislikes',
         'session_synthetic_0001', $2, 'claude-code-web', 'emitter-synthetic', $3, $4)`,
      [id, repository, `synthetic-report-${id.slice(-12)}`, collected ? '2026-10-20T10:00:00Z' : null])
    await report(REPORT.heart, 'krishanraja/Heartside', true)
    await report(REPORT.content, 'krishanraja/content-engine', true)
    // From a repository that serves several ventures, before any session could name one.
    await report(REPORT.held, 'krishanraja/control-center', false)

    // Claims: one mixing Make Your Mind Up's and Mindmake's evidence, one of Mindmake's alone, one he has been shown.
    const [{ id: shown }] = (await client.query(
      `insert into mindmake_studio_learning_proposals (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids,
         independent_session_count, independent_job_count, regression_cases, proposed_change)
       values ('taste-2026-10-19', 'taste', 'synthetic: a claim he was shown', '{"source": "taste_ledger"}', '{}', 1, 0, '[{}]', '{}')
       returning id::text`)).rows
    const claim = (fingerprint: string, statement: string, evidence: string[], status = 'candidate', proposal: string | null = null) => client.query(
      `insert into taste_claims (fingerprint, lane, layer, kind, statement, why, means, evidence_ids, flip_rule, status, proposal_id)
       values ($1, 'voice', 'packaging', 'form', $2, 'synthetic: a why for it.', 'synthetic: a meaning for it.', $3::uuid[],
               'synthetic: a flip rule for it.', $4, $5::uuid)`,
      [fingerprint, statement, evidence.map(r => ids.get(r)), status, proposal])
    await claim(claimFingerprint(PUBLICATION_DRAFT), PUBLICATION_DRAFT.statement, ['f-cleo', TARGET.none])
    await claim('cccccccccccccc02', 'synthetic: a visibility claim', [TARGET.none, 'f-nova'])
    await claim('cccccccccccccc03', 'synthetic: a voice claim he was shown', ['l1', 't1'], 'proposed', shown)

    // Records: the two reported dislikes as the rejections job files them, and one from his Rejections folder.
    const reported = await db.query<Omit<ReportEvidence, 'venture'>>(
      `select source_ref, occurred_at::text, lane, title, excerpt, meta from taste_evidence where source = 'session_report' order by source_ref`)
    const filed = reported.map(e => fileReportDislike({ ...e, venture: 'unknown' })!)
    const q = await fileQuotes(db, filed.map(f => f.quote), runId, true)
    for (const { record: r } of filed) {
      await client.query(
        `insert into taste_rejections (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, strength, theme,
           formats, rule_kind, capture, rules_rev, meta)
         values ($1, $2, $3, 'rejected', $4, $5::uuid[], 'krish_words', $6, $7, $8::text[], $9, 'words', 'rules-v1', $10)`,
        [r.source, r.sourceRef, r.version, r.rejectedAt, r.quoteKeys.map(k => q.ids.get(k)), r.strength, r.theme, r.formats, r.ruleKind, r.meta])
    }
    heartRecord = filed.find(f => f.record.sourceRef === `report:${REPORT.heart}`)!.record
    contentRecord = filed.find(f => f.record.sourceRef === `report:${REPORT.content}`)!.record
    const [{ id: cut }] = (await client.query(
      `insert into taste_rejection_quotes (quote_key, text, said_at, said_precision, said_where, source, attribution)
       values (md5('synthetic cut'), 'synthetic: the join cuts the word', '2026-10-20T12:00:00Z', 'day', 'a dump', 'cloud', 'krish_words')
       returning id::text`)).rows
    await client.query(
      `insert into taste_rejections (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, strength, theme,
         formats, rule_kind, capture, rules_rev)
       values ('drive_dump', 'dump:synthetic-d1', 'bbbbbbbbbbbbbb02', 'rejected', '2026-10-20T12:00:00Z', array[$1::uuid], 'krish_words',
               'rejected', 'edit_av', '{short_video}', 'form', 'words', 'rules-v1')`, [cut])
    const heartQuote = q.ids.get(heartRecord.quoteKeys[0]!)!
    const standard = (fingerprint: string, quoteIds: string[], refs: string[]) => client.query(
      `insert into taste_floor_standards (fingerprint, statement, how_to_check, formats, theme, kind, quote_ids, record_refs, prompt_rev)
       values ($1, 'synthetic: never crowd the frame', 'synthetic: look at every frame edge', '{thumbnail}', 'layout', 'form', $2::uuid[], $3::text[], 'floor-v2')`,
      [fingerprint, quoteIds, refs])
    await standard('dddddddddddddd01', [cut], ['drive_dump:dump:synthetic-d1'])
    await standard('dddddddddddddd02', [cut, heartQuote], ['drive_dump:dump:synthetic-d1', `session_report:report:${REPORT.heart}`])
    await standard('dddddddddddddd03', [heartQuote], [`session_report:report:${REPORT.heart}`])

    // Cues: one a Heartside report became, one from the idea queue, one from a note on a pick on the publish board.
    const cue = (source: string, ref: string, meta: Record<string, unknown>) => client.query(
      `insert into feedback_cues (source, source_ref, subject_ref, subject, said, said_at, use, use_origin, status, meta)
       values ($1, $2, 'synthetic-subject', 'a synthetic idea', 'synthetic: keep an eye on this', '2026-10-20T09:00:00Z', 'track_over_time', 'krish', 'open', $3)`,
      [source, ref, meta])
    await cue('session_report', `report:${REPORT.heart}`, { repository: 'krishanraja/Heartside' })
    await cue('idea_queue', 'synthetic-idea:track_over_time', {})
    await cue('week_pick', '2026-11-09:mon', { via: 'board', decided_by: 'Krish' })
    // Captures: one from Heartside's repository, one from a repository that serves several, and one from Heartside's
    // already filed as a record (fileCapture's source, ref and meta), which moves with its capture.
    const capture = (repository: string, key: string, collected = false) => client.query(
      `insert into taste_rejection_inbox (said, said_where, said_at, formats, session_ref, repository, surface, emitter_id, client_report_id,
         collected_at)
       values ('synthetic: the card hides the face', 'a synthetic session', '2026-10-20T09:00:00Z', '{card}', 'synthetic-session', $1, 'cli',
               'synthetic-emitter', $2, $3) returning id::text`, [repository, key, collected ? '2026-10-20T10:00:00Z' : null])
    await capture('krishanraja/heartside', 'synthetic-capture-heart-01')
    await capture('krishanraja/control-center', 'synthetic-capture-held-01')
    const [{ id: captured }] = (await capture('krishanraja/heartside', 'synthetic-capture-heart-02', true)).rows
    await client.query(
      `insert into taste_rejections (source, source_ref, source_version, kind, rejected_at, quote_ids, attribution, strength, theme,
         formats, rule_kind, capture, rules_rev, meta)
       values ('inbox', $1, 'bbbbbbbbbbbbbb03', 'rejected', '2026-10-20T09:00:00Z', array[$2::uuid], 'krish_words', 'unstated', 'other',
               '{card}', 'form', 'words', 'rules-v1', $3)`,
      [`inbox:${captured}`, cut, { repository: 'krishanraja/heartside', inbox_id: captured }])

    await client.query(readFileSync(ventureFile!, 'utf8'))

    const ev = await stored()
    expect(Object.fromEntries([...ev].filter(([, v]) => v !== 'publication'))).toEqual({
      'f-nova': 'mindmake', 'f-nell': 'mindmake', [TARGET.none]: 'mindmake', [TARGET.pulse]: 'fractionl_pulse', [TARGET.heart]: 'heartside',
      [`report:${REPORT.heart}`]: 'heartside',
    })
    const reports = (await client.query(`select id::text, venture from taste_reports order by id`)).rows
    expect(reports).toEqual([{ id: REPORT.held, venture: null }, { id: REPORT.heart, venture: 'heartside' }, { id: REPORT.content, venture: 'publication' }]
      .sort((a, b) => a.id.localeCompare(b.id)))
    const claims = (await client.query(`select fingerprint, venture, status from taste_claims order by fingerprint`)).rows
    expect(claims).toEqual([
      { fingerprint: claimFingerprint(PUBLICATION_DRAFT), venture: 'publication', status: 'superseded' },
      { fingerprint: 'cccccccccccccc02', venture: 'mindmake', status: 'candidate' },
      { fingerprint: 'cccccccccccccc03', venture: 'publication', status: 'proposed' },
    ].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)))
    expect((await client.query(`select source_ref, venture from taste_rejections order by source_ref`)).rows).toEqual([
      { source_ref: 'dump:synthetic-d1', venture: 'publication' },
      { source_ref: `inbox:${captured}`, venture: 'heartside' },
      { source_ref: `report:${REPORT.heart}`, venture: 'heartside' },
      { source_ref: `report:${REPORT.content}`, venture: 'publication' },
    ].sort((a, b) => a.source_ref.localeCompare(b.source_ref)))
    expect((await client.query(`select fingerprint, venture, status from taste_floor_standards order by fingerprint`)).rows).toEqual([
      { fingerprint: 'dddddddddddddd01', venture: 'publication', status: 'candidate' },
      { fingerprint: 'dddddddddddddd02', venture: 'publication', status: 'superseded' },
      { fingerprint: 'dddddddddddddd03', venture: 'heartside', status: 'candidate' },
    ])
    expect((await client.query(`select source, venture from feedback_cues order by source`)).rows)
      .toEqual([{ source: 'idea_queue', venture: CUE_VENTURE.idea_queue }, { source: 'session_report', venture: 'heartside' },
        { source: 'week_pick', venture: CUE_VENTURE.week_pick }])
    expect((await client.query(`select repository, venture from taste_rejection_inbox order by repository`)).rows)
      .toEqual([{ repository: 'krishanraja/control-center', venture: null }, { repository: 'krishanraja/heartside', venture: 'heartside' },
        { repository: 'krishanraja/heartside', venture: 'heartside' }])
  })

  it('agrees with src/venture.ts on every fixture source, and counts no mismatch', async () => {
    const ev = await stored()
    expect(new Set(FIXTURES.map(f => f.source)).size).toBe(16)
    for (const f of FIXTURES) expect([f.source, f.sourceRef, ev.get(f.sourceRef)]).toEqual([f.source, f.sourceRef, await computed(f)])
    const now = await Promise.all(FIXTURES.map(async f => ({ ...f, venture: (await computed(f))! })))
    expect(await countVentureMismatch(db, now)).toBe(0)
    // Writing them again as the collectors do writes nothing new and finds nothing filed under another venture.
    expect(await writeEvidence(db, now, runId)).toMatchObject({ written: 0, ventureMismatch: 0 })
    // The records too: the reports' by their evidence's venture, the dump's by its folder's.
    const records: RecordRow[] = [{ ...heartRecord, venture: ev.get(heartRecord.sourceRef)! }, { ...contentRecord, venture: ev.get(contentRecord.sourceRef)! }]
    expect(folderVenture(DRIVE.rejections)).toBe((await client.query(`select venture from taste_rejections where source = 'drive_dump'`)).rows[0].venture)
    const q = new Map((await client.query(`select quote_key, id::text from taste_rejection_quotes`)).rows.map(r => [r.quote_key, r.id]))
    expect(await fileRecords(db, records, q, runId, { write: false, whole: null })).toMatchObject({ inserted: 0, ventureMismatch: 0 })
  })

  it('counts a mismatch the moment a row is filed under another venture than the code gives it', async () => {
    const l1 = byRef('l1')
    const wrong: Evidence = { ...l1, sourceRef: 'l1-again', excerpt: 'synthetic: a row filed under the wrong venture', venture: 'heartside' }
    await writeEvidence(db, [wrong], runId)
    const right: Evidence = { ...wrong, venture: ventureOf('learnings_json') }
    expect(await countVentureMismatch(db, [right])).toBe(1)
    expect((await writeEvidence(db, [right], runId)).ventureMismatch).toBe(1)
    // A record re-read under another venture is counted the same way.
    const q = new Map((await client.query(`select quote_key, id::text from taste_rejection_quotes`)).rows.map(r => [r.quote_key, r.id]))
    expect(await fileRecords(db, [{ ...heartRecord, venture: 'publication' }], q, runId, { write: false, whole: null }))
      .toMatchObject({ ventureMismatch: 1 })
    // Neither is ever mended by a rewrite: a row keeps its venture.
    await expect(client.query(`update taste_evidence set venture = 'publication' where source_ref = 'l1-again'`)).rejects.toThrow(/keeps the venture/)
  })

  it('refuses a changed venture, a citation of another venture, and a report naming another venture than its repository', async () => {
    // A claim or a standard moved to another venture would cite rows of its old one: its count trigger, which runs first,
    // refuses it for that before the freeze does.
    for (const t of ['taste_evidence', 'taste_claims', 'taste_rejections', 'taste_floor_standards', 'feedback_cues', 'taste_reports', 'taste_rejection_inbox']) {
      await expect(client.query(`update ${t} set venture = 'full_time' where venture is not null`), t)
        .rejects.toThrow(/keeps the venture it was filed under|belong to another venture than full_time/)
    }
    const cite = (venture: string, refs: string[]) => client.query(
      `insert into taste_claims (fingerprint, lane, layer, kind, statement, why, means, evidence_ids, flip_rule, venture)
       values (substr(md5(random()::text), 1, 16), 'voice', 'packaging', 'form', 'synthetic: a cross venture claim', 'synthetic: a why for it.',
               'synthetic: a meaning for it.', $1::uuid[], 'synthetic: a flip rule for it.', $2) returning id::text`,
      [refs.map(r => ids.get(r)), venture])
    await expect(cite('publication', ['l1', 'f-nova'])).rejects.toThrow(/belong to another venture than publication/)
    const [{ id }] = (await cite('publication', ['l1', 't1'])).rows
    await expect(client.query(`update taste_claims set evidence_ids = evidence_ids || $2::uuid where id = $1`, [id, ids.get(TARGET.pulse)]))
      .rejects.toThrow(/belong to another venture/)
    // The daily withdrawal's touch of every claim still passes, the mixed claim the migration superseded among them.
    await client.query(`update taste_claims set updated_at = now()`)
    await expect(client.query(
      `insert into taste_floor_standards (fingerprint, statement, how_to_check, formats, theme, kind, quote_ids, record_refs, prompt_rev, venture)
       select 'dddddddddddddd09', 'synthetic: never crowd it', 'synthetic: look at the edges', '{thumbnail}', 'layout', 'form', quote_ids,
              array['session_report:report:${REPORT.heart}'], 'floor-v2', 'publication'
       from taste_rejections where source_ref = 'report:${REPORT.heart}'`)).rejects.toThrow(/belong to another venture than publication/)
    const report = (repository: string, venture: string | null, key: string) => client.query(
      `insert into taste_reports (kind, body, lane, session_ref, repository, surface, emitter_id, client_report_id, venture)
       values ('observation', 'synthetic: a session noticed it', 'voice', 'session_synthetic_0002', $1, 'claude-code-web', 'emitter-synthetic', $2, $3)
       returning venture, meta->>'venture_from' as venture_from`, [repository, key, venture])
    await expect(report('krishanraja/heartside', 'publication', 'synthetic-report-refused-1')).rejects.toThrow(/serves heartside, not publication/)
    await expect(report('krishanraja/control-center', 'mindmaker', 'synthetic-report-refused-2')).rejects.toThrow(/not an active venture/)
    expect((await report('krishanraja/HEARTSIDE', null, 'synthetic-report-mapped-01')).rows[0]).toEqual({ venture: 'heartside', venture_from: 'map' })
    expect((await report('krishanraja/control-center', 'heartside', 'synthetic-report-named-01')).rows[0]).toEqual({ venture: 'heartside', venture_from: 'session' })
    expect((await report('krishanraja/control-center', null, 'synthetic-report-held-0001')).rows[0]).toEqual({ venture: null, venture_from: null })
  })

  it('files a Heartside report as Heartside evidence, signals and a record, and holds a report with no venture', async () => {
    const body = 'synthetic: the headline sits on her face'
    const [{ id }] = (await client.query(
      `insert into taste_reports (kind, body, said_where, said_at, lane, polarity, session_ref, repository, surface, emitter_id, client_report_id)
       values ('krish_words', $1, 'a synthetic Heartside session', '2026-10-26T09:00:00Z', 'production', 'dislikes', 'session_synthetic_heart',
               'krishanraja/heartside', 'claude-code-web', 'emitter-synthetic', 'synthetic-report-heart-0001') returning id::text`, [body])).rows
    const r = await syncReports(db, runId, { write: true })
    // The control-center report from before the split and the one just held: never filed, and counted.
    expect(r).toMatchObject({ unassigned: 2, ventureMismatch: 0 })
    expect((await client.query(`select collected_at is null as held from taste_reports where venture is null`)).rows).toEqual([{ held: true }, { held: true }])
    const [ev] = (await client.query(`select id::text, venture from taste_evidence where source_ref = $1`, [`report:${id}`])).rows
    expect(ev.venture).toBe('heartside')

    // His signals count within each venture: the same tag in Heartside's report and in a learning of Make Your Mind Up's
    // is two patterns, one per venture.
    const sig = (span: string) => ({ dimension: 'close', attribute: 'surprise_last', label: null, polarity: 'dislikes', strength: 2, span, reference: null })
    const llm: Llm = { model: 'stub', structured: async (a) => {
      const text = JSON.stringify(a.content)
      const items = [...text.matchAll(/<item ref=\\"(\d+)\\"([\s\S]*?)<\/item>/g)].map(m => ({ ref: Number(m[1]), body: m[2]! }))
      return { failure: null, model: 'stub', data: { items: items.map(i => ({ ref: i.ref, signals:
        i.body.includes(body) ? [sig('the headline sits on her face')] : i.body.includes('and the ending drags') ? [sig('the ending drags')] : [] })) } as never }
    } }
    await extractSignals(db, llm, runId, { write: true })
    const patterns = (await client.query(`select venture, evidence_n from taste_signal_patterns where attribute = 'close.surprise_last' order by venture`)).rows
    expect(patterns).toEqual([{ venture: 'heartside', evidence_n: 1 }, { venture: 'publication', evidence_n: 1 }])
    const byContext = (await client.query(`select venture, lane from taste_signal_patterns_by_context where attribute = 'close.surprise_last' order by venture`)).rows
    expect(byContext).toEqual([{ venture: 'heartside', lane: 'production' }, { venture: 'publication', lane: 'voice' }])

    // The rejections job's reading of the reports, of every venture at once: Heartside's record is Heartside's, and
    // filing them withdraws no other venture's record.
    const filed = (await reportedDislikes(db)).map(fileReportDislike).filter(f => f !== null)
    const q = await fileQuotes(db, filed.map(f => f.quote), runId, true)
    const res = await fileRecords(db, filed.map(f => f.record), q.ids, runId, { write: true, whole: { source: 'session_report', kinds: ['rejected'] }, emptyIsWhole: true })
    expect(res).toMatchObject({ inserted: 1, withdrawn: 0, ventureMismatch: 0 })
    const records = (await client.query(`select source_ref, venture from taste_rejections where source = 'session_report' and withdrawn_at is null order by venture, source_ref`)).rows
    expect(records.map(x => x.venture)).toEqual(['heartside', 'heartside', 'publication'])
    expect(records.find(x => x.source_ref === `report:${id}`)?.venture).toBe('heartside')
    // A capture from Heartside's repository is read with its venture; one with none waits, counted.
    const inbox = await uncollectedInbox(db)
    expect(inbox.rows.map(x => x.venture)).toEqual(['heartside'])
    expect(inbox.unassigned).toBe(1)
  })

  it('distils each venture from its own whys alone, brings a superseded claim back, and puts each proposal under its venture', async () => {
    const why = (ref: string, statement: string) => client.query(
      `insert into taste_whys (evidence_id, statement, lane, layer, kind, origin, model, prompt_rev, fingerprint)
       select id, $2, lane, 'packaging', 'form', 'krish', 'stub', 'r1', substr(md5($2), 1, 16) from taste_evidence where source_ref = $1`,
      [ref, statement])
    for (const ref of ['l1', 't1', 'g1', 'r1']) await why(ref, `synthetic: a Make Your Mind Up why for ${ref}`)
    for (const ref of ['f-nova', 'f-nell', TARGET.none]) await why(ref, `synthetic: a Mindmake why for ${ref.slice(-6)}`)
    // Heartside has one row behind its whys: too few for a claim, so it is skipped, never folded into another venture.
    await why(`report:${REPORT.heart}`, 'synthetic: a Heartside why about the type')
    const prompts: string[] = []
    const llm: Llm = { model: 'stub', structured: async (a) => {
      const text = (a.content[0] as { text: string }).text
      prompts.push(text)
      return { failure: null, model: 'stub', data: { claims: [text.startsWith('Venture: Make Your Mind Up') ? PUBLICATION_DRAFT : MINDMAKE_DRAFT] } as never }
    } }
    const d = await distil(db, llm, runId, true)
    expect(d).toMatchObject({ ventures: 2, skipped: 1, written: 2, failed: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toMatch(/^Venture: Make Your Mind Up/)
    expect(prompts[1]).toMatch(/^Venture: Mindmake/)
    for (const p of prompts) expect(p).not.toContain('Heartside why')
    expect(prompts[0]).not.toContain('Mindmake why')
    expect(prompts[1]).not.toContain('Make Your Mind Up why')
    // The existing claims shown are the venture's own: the Mindmake candidate only to Mindmake.
    expect(prompts[0]).not.toContain('synthetic: a visibility claim')
    expect(prompts[1]).toContain('synthetic: a visibility claim')

    // The mixed claim the migration superseded comes back as a candidate, on Make Your Mind Up's evidence alone.
    const [back] = (await client.query(
      `select c.status, c.venture, array(select distinct e.venture from taste_evidence e where e.id = any(c.evidence_ids)) as ventures
       from taste_claims c where c.fingerprint = $1`, [claimFingerprint(PUBLICATION_DRAFT)])).rows
    expect(back).toEqual({ status: 'candidate', venture: 'publication', ventures: ['publication'] })
    expect((await client.query(`select venture from taste_claims where fingerprint = $1`, [claimFingerprint(MINDMAKE_DRAFT)])).rows)
      .toEqual([{ venture: 'mindmake' }])

    // One ranked list and one cap; each proposal names its claim's venture.
    const p = await propose(db, new Date('2026-10-28T12:00:00Z'), true)
    expect(p.proposed).toBeGreaterThan(0)
    const scoped = (await client.query(
      `select p.scope->>'venture' as scope, c.venture from mindmake_studio_learning_proposals p join taste_claims c on c.proposal_id = p.id
       where p.scope->>'source' = 'taste_ledger' and p.scope ? 'claim_id'`)).rows
    expect(scoped.length).toBe(p.proposed)
    for (const s of scoped) expect(s.scope).toBe(s.venture)
  })

  it('distils, supersedes and renders only Make Your Mind Up\'s floor, and leaves Heartside\'s standing', async () => {
    const heartWords = 'synthetic: the type crowds the photo'
    const seen: string[] = []
    const llm: Llm = { model: 'stub', structured: async (a) => {
      seen.push((a.content[0] as { text: string }).text)
      return { failure: null, model: 'stub', data: { standards: [{
        statement: `Never synthetic: a standard drafted from part ${seen.length}.`, how_to_check: 'synthetic: look at every frame edge.',
        formats: Object.keys(FORMATS), theme: 'layout', layer: null, kind: 'form', records: [0], krish_quote_ref: null, krish_quote: null, boundary: [],
      }] } as never }
    } }
    const r = await distilFloor(db, llm, runId, true)
    expect(r.failed).toBe(0)
    expect(r.written).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
    for (const text of seen) expect(text).not.toContain(heartWords)
    const standards = (await client.query(`select fingerprint, venture, status from taste_floor_standards order by venture, fingerprint`)).rows
    // Heartside's candidate stands; only Make Your Mind Up's candidates that this reading did not draft were superseded.
    expect(standards.filter(s => s.venture === 'heartside')).toEqual([{ fingerprint: 'dddddddddddddd03', venture: 'heartside', status: 'candidate' }])
    expect(standards.find(s => s.fingerprint === 'dddddddddddddd01')).toMatchObject({ status: 'superseded' })
    expect(standards.filter(s => s.venture !== 'heartside' && s.venture !== 'publication')).toEqual([])

    const floor = await loadFloor(db)
    expect(floor.records.length).toBeGreaterThan(0)
    expect(floor.records.every(x => x.source !== 'session_report' || x.source_ref === `report:${REPORT.content}`)).toBe(true)
    expect(floor.standards.map(s => s.fingerprint)).not.toContain('dddddddddddddd03')
    const text = renderFloor(floor)
    expect(text).not.toContain(heartWords)
    expect(text).not.toContain('the headline sits on her face')
  })
})

run('the venture migration on a claim he was shown that mixes two ventures', () => {
  let client: pg.Client
  beforeAll(async () => { ({ client } = await freshSchema(before)) }, 60_000)
  afterAll(async () => { await client?.end() })

  it('stops, and changes nothing, since what he was shown is never changed', async () => {
    await client.query(`insert into visibility_targets (id, product_slug) values ($1, null)`, [TARGET.none])
    const evidence = async (source: string, ref: string) => (await client.query(
      `insert into taste_evidence (source, source_ref, source_version, occurred_at, attribution, polarity, lane, title, excerpt, meta)
       values ($1, $2, md5($2), '2026-10-20T12:00:00Z', 'krish_action', 'likes', 'visibility', 'synthetic', null, '{}') returning id::text`,
      [source, ref])).rows[0].id as string
    const ids = [await evidence('title_verdicts', 'synthetic-t'), await evidence('visibility_target', TARGET.none)]
    const [{ id: shown }] = (await client.query(
      `insert into mindmake_studio_learning_proposals (weekly_batch_id, proposal_class, assertion, scope, evidence_event_ids,
         independent_session_count, independent_job_count, regression_cases, proposed_change)
       values ('taste-2026-10-19', 'taste', 'synthetic: a mixed claim he was shown', '{"source": "taste_ledger"}', '{}', 1, 0, '[{}]', '{}')
       returning id::text`)).rows
    await client.query(
      `insert into taste_claims (fingerprint, lane, layer, kind, statement, why, means, evidence_ids, flip_rule, status, proposal_id)
       values ('eeeeeeeeeeeeee01', 'visibility', null, 'subject', 'synthetic: a mixed claim he was shown', 'synthetic: a why for it.',
               'synthetic: a meaning for it.', $1::uuid[], 'synthetic: a flip rule for it.', 'proposed', $2)`, [ids, shown])
    await expect(client.query(readFileSync(ventureFile!, 'utf8'))).rejects.toThrow(/claim\(s\) on a proposal cite evidence of more than one venture/)
    await client.query('rollback')
    expect((await client.query(`select count(*)::int as n from information_schema.columns where table_name = 'taste_evidence' and column_name = 'venture'`)).rows[0].n).toBe(0)
  })
})
