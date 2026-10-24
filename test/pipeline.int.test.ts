import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'
import { writeEvidence, withdrawUncollected, type Evidence } from '../src/evidence.ts'
import { explainPending } from '../src/explain/whys.ts'
import { distil } from '../src/distil/claims.ts'
import { propose, syncDecisions, ELIGIBLE_SQL, type Eligible } from '../src/publish/propose.ts'
import { score } from '../src/score/scoreboard.ts'
import { linkRequests } from '../src/tag/links.ts'
import { answeredItemEvidence, tagItems, HEAR_TRIES } from '../src/tag/items.ts'
import type { DriveFile, Google } from '../src/google.ts'

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

// A fresh public schema with the real migrations, and a Db on it. Every suite here starts from one.
async function freshSchema(): Promise<{ client: pg.Client; db: Db }> {
  const client = new pg.Client({ connectionString: url })
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
    create table public.content_ideas (id uuid primary key default gen_random_uuid(), published_at timestamptz, idea text, state text, created_at timestamptz default now());
    create table public.content_edit_events (actor text, action text, occurred_at timestamptz);`)
  for (const file of migrations) await client.query(readFileSync(file, 'utf8'))
  const db: Db = {
    query: async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
    close: async () => {},
  }
  return { client, db }
}

run('the whole loop, on a real database', () => {
  let client: pg.Client
  let db: Db
  const runId = '11111111-1111-1111-1111-111111111111'

  beforeAll(async () => { ({ client, db } = await freshSchema()) })
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
  // A link he pasted (content-engine 20261109090000): the request, content-watcher's reading, and the cards its media
  // became in Drive. Synthetic rows only.
  it('links a pasted link to its card, folds the other slides, keeps his note, and does it once', async () => {
    const sha = (c: string) => c.repeat(64)
    const cards = (await client.query(
      `insert into inspiration_items (drive_file_id, folder, lane, name, mime, drive_created_at)
       select 'file-' || x || '-0000000', 'cold_ideas', 'strategy', 'slide-' || x || '.jpg', 'image/jpeg', now()
       from unnest(array['a', 'b', 'c']) as x returning id::text, drive_file_id`,
    )).rows as Array<{ id: string; drive_file_id: string }>
    const cardOf = (x: string) => cards.find(c => c.drive_file_id === `file-${x}-0000000`)!.id
    const readId = (await client.query(
      `insert into content_reads (sha256, source_url, platform, shape, engine_rev, read, read_md)
       values ($1, 'https://www.instagram.com/p/synthetic/', 'instagram', 'carousel', 'cw-1',
               '{"post": {"author": "a synthetic author", "posted_at": "2026-10-20"}}', '# A synthetic carousel') returning id::text`,
      [sha('a')],
    )).rows[0].id as string
    const requestId = (await client.query(
      `insert into content_watch_requests (url, url_key, platform, note, status, shape, media, read_id, requested_at)
       values ('https://www.instagram.com/p/synthetic/', 'https://instagram.com/p/synthetic', 'instagram', 'the slide order tells the story',
               'read', 'carousel', $1::jsonb, $2::uuid, '2026-10-24T09:00:00Z') returning id::text`,
      [JSON.stringify(['a', 'b', 'c'].map(x => ({ name: `slide-${x}.jpg`, sha256: sha(x).toUpperCase(), mime: 'image/jpeg', bytes: 1000, folder: 'cold_ideas' }))), readId],
    )).rows[0].id as string
    const files = new Map<string, DriveFile>(['a', 'b', 'c'].map(x => [`file-${x}-0000000`, {
      id: `file-${x}-0000000`, name: `slide-${x}.jpg`, mimeType: 'image/jpeg', modifiedTime: '2026-10-24T09:05:00Z', createdTime: '2026-10-24T09:05:00Z', sha256Checksum: sha(x),
    }]))

    expect(await linkRequests(db, files)).toEqual({ linked: 1, slides: 2, notes: 1 })
    expect((await client.query(`select item_id::text from content_watch_requests where id = $1`, [requestId])).rows[0].item_id).toBe(cardOf('a'))
    const rows = (await client.query(`select id::text, why_here, answered_at, facets from inspiration_items where id = any($1::uuid[]) order by name`, [cards.map(c => c.id)])).rows
    expect(rows[0]).toMatchObject({ why_here: 'the slide order tells the story', answered_at: null })
    expect(rows[0].facets.link).toEqual({ request_id: requestId, url: 'https://www.instagram.com/p/synthetic/', platform: 'instagram',
      author: 'a synthetic author', posted_at: '2026-10-20', requested_at: '2026-10-24T09:00:00+00:00', slides: 3,
      note: 'the slide order tells the story' })
    expect(rows[1].facets).toMatchObject({ part_of: cardOf('a'), link: { request_id: requestId, slide: 1 } })
    expect(rows[2].facets).toMatchObject({ part_of: cardOf('a'), link: { slide: 2 } })
    expect(await linkRequests(db, files)).toEqual({ linked: 0, slides: 0, notes: 0 })

    // The cards job tags the card from its reading and never the slides; the link survives the tagging.
    const google = { thumbnail: async () => null, text: async () => null, download: async () => { throw new Error('not reached') } } as unknown as Google
    const llm: Llm = { model: 'stub', structured: async () => ({ failure: null, model: 'stub', data: {
      tags: [], predicted: { why_here: [], why_like: [], would_do: [] }, route: 'taste_only', kind: null, opinion: null, reason: null, piece_ref: null,
      facets: { platform: 'instagram', format: 'carousel', source: null, creator: null, people: [], organisations: [], topics: [] },
    } as never }) }
    const t = await tagItems(db, google, llm, files, 10, true, { linked: true })
    expect(t).toMatchObject({ tagged: 1, fromReading: 1, parts: 2, waitingForReading: 0 })
    const after = (await client.query(`select tagged_at is not null as tagged, facets from inspiration_items where id = any($1::uuid[]) order by name`, [cards.map(c => c.id)])).rows
    expect(after.every(r => r.tagged)).toBe(true)
    expect(after[0].facets).toMatchObject({ read_from: 'content_reads', read_rev: 'cw-1', format: 'carousel', link: { request_id: requestId } })
    expect(after[1].facets.part_of).toBe(cardOf('a'))

    // His paste note counts as his words while the card waits for his answer, and stands through the page's recount.
    const page = await answeredItemEvidence(db)
    expect(page.filter(e => e.sourceRef === cardOf('a'))).toEqual([expect.objectContaining({
      attribution: 'krish_words', excerpt: 'the slide order tells the story', occurredAt: '2026-10-24T09:00:00+00:00',
    })])
    expect(page.some(e => e.sourceRef === cardOf('b'))).toBe(false)
    await writeEvidence(db, page, runId)
    await withdrawUncollected(db, 'inspiration_page', page, true)
    const standing = (await client.query(`select count(*)::int as n from taste_evidence where source_ref = $1 and withdrawn_at is null`, [cardOf('a')])).rows[0].n
    expect(standing).toBe(1)
  })
})

// The review of e0d8884, each case reproduced here first on Postgres 16. Every case starts from empty tables.
run('the review of the link box, on a real database', () => {
  let client: pg.Client
  let db: Db
  const runId = '22222222-2222-2222-2222-222222222222'

  beforeAll(async () => { ({ client, db } = await freshSchema()) })
  beforeEach(async () => {
    await client.query('truncate public.taste_claims, public.taste_evidence, public.content_watch_requests, public.content_reads, public.inspiration_items cascade')
  })
  afterAll(async () => { await client?.end() })

  const answer = (ref: string, at: string, picks: string[]): Evidence => ({
    source: 'inspiration_page', sourceRef: ref, occurredAt: at, attribution: 'krish_words', polarity: 'likes',
    lane: 'production', layer: null, title: 'synthetic.mp4', excerpt: `synthetic: the cut on the beat ${ref}`, meta: { picked_likes: picks },
  })

  it('counts the day of an answer he added a pick to, as support does, so its claim can still be proposed', async () => {
    const v1 = ['p', 'q', 'r', 's'].map((x, i) => answer(`card-${x}`, `2026-10-0${i + 1}T12:00:00Z`, []))
    await writeEvidence(db, v1, runId)
    await withdrawUncollected(db, 'inspiration_page', v1, true)
    const ids = (await client.query(`select id::text from taste_evidence where source = 'inspiration_page' order by source_ref`)).rows.map(r => r.id as string)
    const [{ id }] = (await client.query(
      `insert into taste_claims (fingerprint, lane, layer, kind, statement, why, means, evidence_ids, flip_rule)
       values ('b1b1b1b1b1b1b1b1', 'production', 'editing', 'form', 'A synthetic claim.', 'A synthetic why.', 'Do the synthetic thing.',
               $1::uuid[], 'If the test says otherwise.') returning id::text`, [ids])).rows
    // He adds a pick to two of them: each gets a new version, and the version the claim cites is withdrawn.
    const v2 = [answer('card-p', v1[0]!.occurredAt, ['tight pacing']), answer('card-q', v1[1]!.occurredAt, ['tight pacing']), v1[2]!, v1[3]!]
    await writeEvidence(db, v2, runId)
    await withdrawUncollected(db, 'inspiration_page', v2, true)
    expect((await db.query<Eligible>(ELIGIBLE_SQL)).find(e => e.id === id)).toMatchObject({ support_n: 4, days: 4 })
    expect((await propose(db, new Date('2026-10-24T12:00:00Z'), false)).eligible).toBe(1)
    // His Undo withdraws every version of a card: then its day goes with its support.
    await withdrawUncollected(db, 'inspiration_page', v2.slice(0, 3), true)
    expect((await db.query<Eligible>(ELIGIBLE_SQL)).find(e => e.id === id)).toMatchObject({ support_n: 3, days: 3 })
  })

  // A stand-in for the model: it answers, or throws the status it is given, and keeps every prompt it was sent.
  const tagger = (fail?: number) => {
    const prompts: string[] = []
    const llm: Llm = { model: 'stub', structured: async (a) => {
      prompts.push(JSON.stringify(a.content))
      if (fail) throw Object.assign(new Error('synthetic'), { status: fail })
      return { failure: null, model: 'stub', data: {
        tags: [], predicted: { why_here: [], why_like: [], would_do: [] }, route: 'taste_only', kind: null, opinion: null, reason: null, piece_ref: null,
        facets: { platform: 'instagram', format: 'short_video', source: null, creator: null, people: [], organisations: [], topics: [] },
      } as never }
    } }
    return { llm, prompts }
  }
  const video = (id: string, over: Partial<DriveFile> = {}): DriveFile =>
    ({ id, name: `${id}.mp4`, mimeType: 'video/mp4', modifiedTime: '2026-10-24T09:00:00Z', createdTime: '2026-10-24T09:00:00Z', size: '1000', ...over })
  const noDrive = { thumbnail: async () => null, text: async () => null, download: async () => Buffer.from('synthetic bytes') } as unknown as Google

  it('tags a healing video from the words it finally heard, on the run after a model error, and never hears them twice', async () => {
    await client.query(
      `insert into inspiration_items (drive_file_id, folder, lane, name, mime, drive_created_at, tagged_at, tag_rev, facets)
       values ('vid-heal-0000', 'video_inspiration', 'production', 'vid-heal-0000.mp4', 'video/mp4', now(), now(), 'tag-v3', '{"heard": "failed", "heard_tries": 1}'),
              ('vid-new-00000', 'video_inspiration', 'production', 'vid-new-00000.mp4', 'video/mp4', now(), null, null, '{}')`)
    const files = new Map([['vid-heal-0000', video('vid-heal-0000')], ['vid-new-00000', video('vid-new-00000')]])
    const asked: Array<boolean | undefined> = []
    const watch = async (_: Buffer, o: { transcribe?: boolean } = {}) => {
      asked.push(o.transcribe)
      return { frames: [], transcript: o.transcribe === false ? null : 'synthetic words that were finally heard', durationS: 12,
        heard: (o.transcribe === false ? 'skipped' : 'words') as 'words', unheard: null }
    }
    const first = await tagItems(db, noDrive, tagger(529).llm, files, 60, true, { watch })
    expect(first).toMatchObject({ tagged: 0, failed: 2, heard: 2 })
    const next = tagger()
    const second = await tagItems(db, noDrive, next.llm, files, 60, true, { watch })
    expect(second).toMatchObject({ tagged: 2, failed: 0 })
    expect(next.prompts).toHaveLength(2)
    expect(next.prompts.every(p => p.includes('synthetic words that were finally heard'))).toBe(true)
    // The words heard on the first run are not heard again on the second.
    expect(asked).toEqual([undefined, undefined, false, false])
    const rows = (await client.query(`select tag_rev, transcript, facets->>'heard' as heard from inspiration_items order by name`)).rows
    expect(rows).toEqual([
      { tag_rev: 'tag-v3', transcript: 'synthetic words that were finally heard', heard: 'words' },
      { tag_rev: 'tag-v3', transcript: 'synthetic words that were finally heard', heard: 'words' },
    ])
    // Tagged from its words, it is done: a third run does not pick either card up.
    expect(await tagItems(db, noDrive, tagger().llm, files, 60, true, { watch })).toMatchObject({ tagged: 0, rehead: 0 })
  })

  // A link he pasted: its request (status read, its media by sha256), and the cards its files became in Drive.
  const sha = (c: string) => c.repeat(64)
  const image = (x: string): DriveFile => ({ id: `file-${x}-0000000`, name: `slide-${x}.jpg`, mimeType: 'image/jpeg',
    modifiedTime: '2026-10-24T09:05:00Z', createdTime: '2026-10-24T09:05:00Z', sha256Checksum: sha(x) })
  const cardsFor = async (xs: string[]) => {
    const rows = (await client.query(
      `insert into inspiration_items (drive_file_id, folder, lane, name, mime, drive_created_at)
       select 'file-' || x || '-0000000', 'cold_ideas', 'strategy', 'slide-' || x || '.jpg', 'image/jpeg', now()
       from unnest($1::text[]) as x returning id::text, drive_file_id`, [xs])).rows as Array<{ id: string; drive_file_id: string }>
    return Object.fromEntries(rows.map(r => [r.drive_file_id.slice(5, 6), r.id])) as Record<string, string>
  }
  const request = async (key: string, xs: string[], note: string | null, status = 'read', readId: string | null = null) =>
    (await client.query(
      `insert into content_watch_requests (url, url_key, platform, note, status, shape, media, read_id, requested_at)
       values ($1, $2, 'instagram', $3, $4, 'carousel', $5::jsonb, $6::uuid, '2026-10-24T09:00:00Z') returning id::text`,
      [`https://www.instagram.com/p/${key}/`, `https://instagram.com/p/${key}`, note, status,
        JSON.stringify(xs.map(x => ({ name: `slide-${x}.jpg`, sha256: sha(x), mime: 'image/jpeg', bytes: 1000, folder: 'cold_ideas' }))), readId],
    )).rows[0].id as string
  const filesOf = (xs: string[]) => new Map(xs.map(x => [`file-${x}-0000000`, image(x)]))
  const card = async (id: string) => (await client.query(`select why_here, answered_at, facets from inspiration_items where id = $1`, [id])).rows[0]
  const pageWords = async (id: string) => (await answeredItemEvidence(db)).filter(e => e.sourceRef === id).map(e => e.excerpt)

  it('takes his new note when he pastes the link again, and gives it back after his Undo, on a card he has not answered', async () => {
    const c = await cardsFor(['a'])
    const req = await request('again', ['a'], 'the first thing I noticed')
    const files = filesOf(['a'])
    expect(await linkRequests(db, files)).toMatchObject({ linked: 1, notes: 1 })
    // He pastes it again with a new note (Control Center's pastedAgain writes it to the request).
    await client.query(`update content_watch_requests set note = 'the second thing I noticed' where id = $1`, [req])
    expect(await linkRequests(db, files)).toMatchObject({ linked: 0, notes: 1 })
    expect((await card(c.a!)).why_here).toBe('the second thing I noticed')
    expect(await pageWords(c.a!)).toEqual(['the second thing I noticed'])
    // Nothing changed: nothing is written.
    expect(await linkRequests(db, files)).toMatchObject({ linked: 0, notes: 0 })
    // His Undo on the page (Control Center's REOPEN_PATCH) clears why_here; his paste note comes back on the next run.
    await client.query(`update inspiration_items set why_here = null, answered_at = null where id = $1`, [c.a])
    expect(await linkRequests(db, files)).toMatchObject({ notes: 1 })
    expect((await card(c.a!)).why_here).toBe('the second thing I noticed')
  })

  it('never changes an answered card for a new paste note, nor a dry run anything', async () => {
    const c = await cardsFor(['b'])
    const req = await request('answered', ['b'], 'the first thing I noticed')
    const files = filesOf(['b'])
    await linkRequests(db, files)
    await client.query(`update inspiration_items set why_here = 'what he wrote when he answered', answered_at = now() where id = $1`, [c.b])
    await client.query(`update content_watch_requests set note = 'the second thing I noticed' where id = $1`, [req])
    expect(await linkRequests(db, files)).toMatchObject({ notes: 0 })
    expect((await card(c.b!)).why_here).toBe('what he wrote when he answered')
    // He answered with no why_here at all: that stands too.
    await client.query(`update inspiration_items set why_here = null, why_like = 'what he likes', why_like_source = 'typed' where id = $1`, [c.b])
    expect(await linkRequests(db, files)).toMatchObject({ notes: 0 })
    expect((await card(c.b!)).why_here).toBeNull()
    // Unanswered again, a dry run counts the note it would give back and writes nothing.
    await client.query(`update inspiration_items set answered_at = null, why_like = null, why_like_source = null where id = $1`, [c.b])
    expect(await linkRequests(db, files, false)).toMatchObject({ notes: 1 })
    expect((await card(c.b!)).why_here).toBeNull()
  })

  it('points a second paste of the same post at its card and leaves that card as the first paste made it', async () => {
    const c = await cardsFor(['c', 'd'])
    const first = await request('post-c', ['c', 'd'], 'the first paste')
    const files = filesOf(['c', 'd'])
    expect(await linkRequests(db, files)).toMatchObject({ linked: 1, slides: 1 })
    const before = await card(c.c!)
    // The same post under another address is a second request (another url_key).
    const second = await request('reel-c', ['c', 'd'], 'the second paste')
    expect(await linkRequests(db, files)).toMatchObject({ linked: 1, slides: 0, notes: 0 })
    expect((await client.query(`select item_id::text from content_watch_requests where id = $1`, [second])).rows[0].item_id).toBe(c.c)
    expect(await card(c.c!)).toEqual(before)
    expect((await card(c.c!)).facets.link.request_id).toBe(first)
    expect((await card(c.d!)).facets).toMatchObject({ part_of: c.c, link: { request_id: first, slide: 1 } })
    expect(await linkRequests(db, files)).toMatchObject({ linked: 0, slides: 0, notes: 0 })
  })

  it('never takes a slide folded into another post\'s card, nor two new pastes one card in the same run', async () => {
    const c = await cardsFor(['e', 'f', '7'])
    const carousel = await request('carousel-e', ['e', 'f'], 'the carousel')
    const files = filesOf(['e', 'f', '7'])
    await linkRequests(db, files)
    // A single post whose picture is the carousel's second slide: it points at the carousel's card, which stays as it was.
    const single = await request('single-f', ['f'], 'the single post')
    const slide = await card(c.f!)
    expect(await linkRequests(db, files)).toMatchObject({ linked: 1, slides: 0, notes: 0 })
    expect((await client.query(`select item_id::text from content_watch_requests where id = $1`, [single])).rows[0].item_id).toBe(c.e)
    expect(await card(c.f!)).toEqual(slide)
    expect((await card(c.e!)).facets.link.request_id).toBe(carousel)
    expect(await pageWords(c.f!)).toEqual([])
    // Two new pastes of one post in the same run: the first takes the card, the second points at it.
    const one = await request('twice-1', ['7'], 'pasted first')
    await request('twice-2', ['7'], 'pasted second')
    expect(await linkRequests(db, files)).toMatchObject({ linked: 2, notes: 1 })
    expect(await card(c['7']!)).toMatchObject({ why_here: 'pasted first', facets: { link: { request_id: one } } })
  })

  it('lets a video whose reading could not hear it go after its tries, instead of coming back on every run', async () => {
    await client.query(
      `insert into inspiration_items (drive_file_id, folder, lane, name, mime, drive_created_at)
       values ('vid-unheard-0', 'video_inspiration', 'production', 'vid-unheard-0.mp4', 'video/mp4', now())`)
    await client.query(
      `insert into content_reads (sha256, shape, engine_rev, read, read_md)
       values ($1, 'video', 'cw-1', '{"heard": "failed", "heard_class": "whisper_error", "words_text": "", "post": null}', '## Shots\n1. a synthetic shot')`,
      [sha('9')])
    const files = new Map([['vid-unheard-0', video('vid-unheard-0', { sha256Checksum: sha('9') })]])
    const notWatched = { watch: async (): Promise<never> => { throw new Error('a read file is never watched') } }
    const runs = []
    for (let n = 0; n < 5; n++) runs.push(await tagItems(db, noDrive, tagger().llm, files, 60, true, notWatched))
    expect(runs.map(r => [r.tagged, r.rehead, r.gaveUp])).toEqual([[1, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 0], [0, 0, 0]])
    const [row] = (await client.query(`select facets->>'heard' as heard, (facets->>'heard_tries')::int as tries from inspiration_items`)).rows
    expect(row).toEqual({ heard: 'failed', tries: HEAR_TRIES })
  })

  it('fills the author and date once the reading of a post linked while it was only filed arrives', async () => {
    const c = await cardsFor(['1', '2'])
    const req = await request('filed-1', ['1', '2'], null, 'filed')
    const files = filesOf(['1', '2'])
    await linkRequests(db, files)
    expect((await card(c['1']!)).facets.link).toMatchObject({ author: null, posted_at: null })
    // content-watcher writes its reading and marks the request read.
    const readId = (await client.query(
      `insert into content_reads (sha256, source_url, platform, shape, engine_rev, read, read_md)
       values ($1, 'https://www.instagram.com/p/filed-1/', 'instagram', 'carousel', 'cw-1',
               '{"post": {"author": "a synthetic author", "posted_at": "2026-10-20"}}', '# A synthetic carousel') returning id::text`,
      [sha('1')])).rows[0].id as string
    await client.query(`update content_watch_requests set status = 'read', read_id = $2 where id = $1`, [req, readId])
    // A dry run writes nothing.
    await linkRequests(db, files, false)
    expect((await card(c['1']!)).facets.link).toMatchObject({ author: null, posted_at: null })
    await linkRequests(db, files)
    expect((await card(c['1']!)).facets.link).toMatchObject({ request_id: req, author: 'a synthetic author', posted_at: '2026-10-20' })
    expect((await card(c['2']!)).facets).toMatchObject({ part_of: c['1'], link: { author: 'a synthetic author', posted_at: '2026-10-20', slide: 1 } })
    // What a card already says is never overwritten, and a second run changes nothing.
    await client.query(`update content_reads set read = '{"post": {"author": "someone else", "posted_at": "2026-10-21"}}' where id = $1`, [readId])
    const [{ updated_at: before }] = (await client.query(`select updated_at::text from inspiration_items where id = $1`, [c['1']])).rows
    await linkRequests(db, files)
    expect((await card(c['1']!)).facets.link).toMatchObject({ author: 'a synthetic author', posted_at: '2026-10-20' })
    expect((await client.query(`select updated_at::text from inspiration_items where id = $1`, [c['1']])).rows[0].updated_at).toBe(before)
  })

  it('gives the cards job\'s places to linked cards whose reading is there, not to newer ones still waiting', async () => {
    // Ten newer linked cards whose readings have not arrived, and one older linked card whose reading has.
    const hex = (n: number) => n.toString(16).padStart(64, '0')
    await client.query(
      `insert into inspiration_items (drive_file_id, folder, lane, name, mime, drive_created_at, facets)
       select 'file-slot-' || n, 'cold_ideas', 'strategy', 'slot-' || n || '.jpg', 'image/jpeg',
              now() - make_interval(hours => 20 - n), '{"link": {"request_id": "synthetic"}}'
       from generate_series(0, 10) as n`)
    await client.query(`insert into content_reads (sha256, shape, engine_rev, read, read_md) values ($1, 'image', 'cw-1', '{}', '# A synthetic image')`, [hex(0)])
    const files = new Map(Array.from({ length: 11 }, (_, n) => [`file-slot-${n}`,
      { id: `file-slot-${n}`, name: `slot-${n}.jpg`, mimeType: 'image/jpeg', modifiedTime: '2026-10-24T09:00:00Z', createdTime: '2026-10-24T09:00:00Z', sha256Checksum: hex(n) } as DriveFile]))
    const r = await tagItems(db, noDrive, tagger().llm, files, 10, true, { linked: true, watch: async () => { throw new Error('not reached') } })
    expect(r).toMatchObject({ tagged: 1, fromReading: 1, waitingForReading: 10 })
    expect((await client.query(`select name from inspiration_items where tagged_at is not null`)).rows).toEqual([{ name: 'slot-0.jpg' }])
  })

  it('writes a long answer ending in emoji, and the good row beside it', async () => {
    const long = answer('card-emoji', '2026-10-05T12:00:00Z', [])
    long.excerpt = 'a'.repeat(1999) + '\u{1F600}\u{1F600}'
    expect((await writeEvidence(db, [long, answer('card-plain', '2026-10-05T12:00:00Z', [])], runId)).written).toBe(2)
  })
})
