import { describe, it, expect } from 'vitest'
import { tagItems, HEAR_TRIES, needsTags, nameWords, answerEvidence, apiFailureClass, INSTRUCTED_SINCE, type AnsweredRow } from '../src/tag/items.ts'
import type { Db } from '../src/db.ts'
import type { Google, DriveFile } from '../src/google.ts'
import type { Llm } from '../src/llm.ts'
import type { Watched } from '../src/tag/watch.ts'

// Synthetic cards and files only; nothing here is anything Krish saved.
type Row = { id: string; drive_file_id: string; note_for_claude: string | null; read_as?: string | null; healing: boolean; facets: Record<string, unknown> | null; kind?: string | null; kind_source?: string | null; transcript?: string | null }
const file = (id: string, over: Partial<DriveFile> = {}): DriveFile =>
  ({ id, name: `clip-${id}.mp4`, mimeType: 'video/mp4', modifiedTime: '2026-10-24T00:00:00Z', createdTime: '2026-10-24T00:00:00Z', size: '1000', ...over })

function harness(rows: Row[], opts: { download?: (id: string) => Promise<Buffer>; known?: Array<{ id: string; drive_file_id: string; kind: string | null; kind_source: string | null }>; slate?: Array<{ id: string; idea: string }>; answer?: Record<string, unknown>; throwOn?: (call: number) => unknown; failure?: string } = {}) {
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const pendingSelects: Array<{ sql: string; params: unknown[] }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      if (/^\s*update/i.test(sql)) { writes.push({ sql, params }); return [] as T[] }
      if (/from public\.inspiration_items\s+where \(tagged_at is null/.test(sql)) { pendingSelects.push({ sql, params }); return rows.map(r => ({ kind: null, kind_source: null, read_as: null, transcript: null, ...r })) as T[] }
      if (/select id::text, drive_file_id, kind, kind_source from public\.inspiration_items/.test(sql)) return (opts.known ?? []) as T[]
      if (/from public\.content_ideas/.test(sql)) return (opts.slate ?? []) as T[]
      return [] as T[]
    },
  } as Db
  const downloads: string[] = []
  const google = {
    thumbnail: async () => null,
    text: async () => null,
    download: async (id: string) => { downloads.push(id); return opts.download ? opts.download(id) : Buffer.from('bytes') },
  } as unknown as Google
  let calls = 0
  const prompts: string[] = []
  const llm: Llm = {
    model: 'm',
    async structured(args) {
      calls++
      prompts.push(JSON.stringify(args.content))
      const thrown = opts.throwOn?.(calls)
      if (thrown) throw thrown
      if (opts.failure) return { data: null, failure: opts.failure, model: 'm' } as never
      return { data: { tags: [], predicted: { why_here: [], why_like: [], would_do: [] }, route: 'taste_only', kind: null, opinion: null, reason: null, piece_ref: null,
        facets: { platform: 'instagram', format: 'short_video', source: null, creator: null, people: [], organisations: [], topics: [] }, ...opts.answer } as never, failure: null, model: 'm' }
    },
  }
  return { db, google, llm, writes, pendingSelects, downloads, prompts, calls: () => calls }
}
const watched = (over: Partial<Watched>): Watched => ({ frames: [{ bytes: Buffer.from('f'), mime: 'image/jpeg' }, { bytes: Buffer.from('f'), mime: 'image/jpeg' }], transcript: null, durationS: 30, heard: 'failed', unheard: 'decode', ...over })

describe('tagItems hearing a video again', () => {
  it('writes only the hearing, with no model call, when a tagged video still cannot be heard', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: { heard: 'failed', heard_tries: 1 } }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({}) })
    expect(h.calls()).toBe(0)
    expect(r).toMatchObject({ tagged: 0, rehead: 1, unheard: { decode: 1 }, gaveUp: 0 })
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.sql).not.toMatch(/auto_tags/)
    expect(JSON.parse(h.writes[0]!.params[1] as string)).toEqual({ heard: 'failed', heard_tries: 2 })
  })

  it('gives up after the last try, and says so', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: { heard_tries: HEAR_TRIES - 1 } }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({}) })
    expect(r.gaveUp).toBe(1)
    expect(JSON.parse(h.writes[0]!.params[1] as string).heard_tries).toBe(HEAR_TRIES)
  })

  it('charges no try when the runner has no speech model, since that says nothing about the clip', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: { heard: 'failed', heard_tries: HEAR_TRIES - 1 } }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({ unheard: 'no_model' }) })
    expect(h.calls()).toBe(0)
    expect(r).toMatchObject({ rehead: 1, gaveUp: 0, unheard: { no_model: 1 } })
    expect(JSON.parse(h.writes[0]!.params[1] as string)).toEqual({ heard: 'failed', heard_tries: HEAR_TRIES - 1 })
  })

  it('tags again from the words once they are heard', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: { heard: 'failed', heard_tries: 1 } }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true,
      { watch: async () => watched({ transcript: 'what was said', heard: 'words', unheard: null }) })
    expect(h.calls()).toBe(1)
    expect(r).toMatchObject({ tagged: 1, heard: 1, rehead: 0, unheard: {} })
    expect(h.writes[0]!.sql).toMatch(/auto_tags/)
    expect(h.writes[0]!.params[9]).toBe('what was said')
    expect(JSON.parse(h.writes[0]!.params[7] as string)).toMatchObject({ heard: 'words', heard_tries: 1 })
  })

  it('keeps the words it heard when the model call after them throws', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: { heard: 'failed', heard_tries: 1 } }],
      { throwOn: () => Object.assign(new Error('overloaded'), { status: 529 }) })
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true,
      { watch: async () => watched({ transcript: 'what was said', heard: 'words', unheard: null }) })
    expect(r).toMatchObject({ tagged: 0, failed: 1, failures: { api_529: 1 }, heard: 1 })
    expect(h.writes).toHaveLength(1)
    const w = h.writes[0]!
    expect(w.sql).not.toMatch(/auto_tags/)
    expect(w.sql).toMatch(/set facets = facets \|\| \$2::jsonb, transcript = coalesce\(\$3, transcript\)/)
    expect(JSON.parse(w.params[1] as string)).toEqual({ heard: 'words', heard_tries: 1 })
    expect(w.params[2]).toBe('what was said')
  })

  it('keeps the words it heard when the model answer cannot be read', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: {} }], { failure: 'unparsed' })
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true,
      { watch: async () => watched({ transcript: 'what was said', heard: 'words', unheard: null }) })
    expect(r).toMatchObject({ tagged: 0, failed: 1, failures: { unparsed: 1 } })
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.params[2]).toBe('what was said')
  })

  it('writes nothing more when the model fails and no words were heard', async () => {
    const h = harness([{ id: '1', drive_file_id: 'd', note_for_claude: null, healing: false, facets: {} }], { failure: 'refusal' })
    await tagItems(h.db, h.google, h.llm, new Map([['d', file('d', { mimeType: 'application/vnd.google-apps.document', name: 'd' })]]))
    expect(h.writes).toEqual([])
  })

  it('records silence as final, with no model call', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: {} }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({ heard: 'silent', unheard: null }) })
    expect(h.calls()).toBe(0)
    expect(r.unheard).toEqual({})
    expect(JSON.parse(h.writes[0]!.params[1] as string)).toEqual({ heard: 'silent', heard_tries: 0 })
  })
})

describe('tagItems on a new video', () => {
  it('never fetches a file over the cap, and records it as too big without failing the run', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: false, facets: {} }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a', { size: String(200_000_000) })]]), 60, true, { watch: async () => { throw new Error('not reached') } })
    expect(h.downloads).toEqual([])
    expect(r).toMatchObject({ tagged: 1, tooBig: 1, unheard: {} })
    expect(JSON.parse(h.writes[0]!.params[7] as string)).toMatchObject({ heard: 'too_big' })
  })

  it('still tags a video it could not fetch, and counts the miss as a try', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: false, facets: {} }], { download: async () => { throw new Error('HTTP 500') } })
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({}) })
    expect(h.calls()).toBe(1)
    expect(r).toMatchObject({ tagged: 1, unheard: { download: 1 } })
    expect(JSON.parse(h.writes[0]!.params[7] as string)).toMatchObject({ heard: 'failed', heard_tries: 1 })
  })

  it('keeps the words an earlier run heard when a card tagged again cannot fetch its video now', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: false, facets: { heard: 'words', heard_tries: 0, duration_s: 42 }, transcript: 'what was said before' }],
      { download: async () => { throw new Error('HTTP 500') } })
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => { throw new Error('not reached') } })
    expect(r).toMatchObject({ tagged: 1, unheard: {}, gaveUp: 0, heard: 0 })
    expect(h.prompts[0]).toContain('what was said before')
    const w = h.writes.at(-1)!
    expect(w.params[9]).toBe('what was said before')
    expect(JSON.parse(w.params[7] as string)).toMatchObject({ heard: 'words', heard_tries: 0, duration_s: 42 })
    // It was not watched this run.
    expect(w.params[10]).toBe(false)
  })

  it('keeps the earlier words and this run\'s frames when only the hearing fails now', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: false, facets: { heard: 'words', heard_tries: 0 }, transcript: 'what was said before' }])
    const r = await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, true, { watch: async () => watched({ unheard: 'transcribe' }) })
    expect(r).toMatchObject({ tagged: 1, watched: 1, unheard: {} })
    expect(h.prompts[0]).toContain('you see 2 frames')
    expect(h.prompts[0]).toContain('what was said before')
    expect(JSON.parse(h.writes.at(-1)!.params[7] as string)).toMatchObject({ heard: 'words' })
  })

  it('leaves the rest for the next run once the time budget is spent', async () => {
    let t = 0
    const rows = ['a', 'b', 'c'].map((d, i) => ({ id: String(i), drive_file_id: d, note_for_claude: null, healing: false, facets: {} }))
    const h = harness(rows)
    const files = new Map(['a', 'b', 'c'].map(d => [d, file(d, { mimeType: 'application/vnd.google-apps.document', name: d })]))
    const r = await tagItems(h.db, h.google, h.llm, files, 60, true, { now: () => (t += 10), budgetMs: 15 })
    expect(r.tagged).toBe(1)
    expect(r.deferred).toBe(2)
  })

  it('writes nothing on a dry run', async () => {
    const h = harness([{ id: '1', drive_file_id: 'a', note_for_claude: null, healing: true, facets: {} }])
    await tagItems(h.db, h.google, h.llm, new Map([['a', file('a')]]), 60, false, { watch: async () => watched({}) })
    expect(h.writes).toEqual([])
  })
})

describe('needsTags', () => {
  it('names its own parameter and the try limit, so no placeholder is rewritten by hand', () => {
    expect(needsTags(9)).toContain('tag_rev is distinct from $9')
    expect(needsTags(9)).not.toContain('$2')
    expect(needsTags(2)).toContain(`< ${HEAR_TRIES}`)
  })
  it('tags a card again once when he told how to read it after it was tagged', () => {
    expect(needsTags(2)).toContain(INSTRUCTED_SINCE)
    expect(INSTRUCTED_SINCE).toBe('coalesce(instructed_at > tagged_at, false)')
  })
})

describe('tagItems and what is in Drive this run', () => {
  it('asks only for cards whose file is in Drive, so a gone file never takes a slot', async () => {
    const h = harness([])
    const docs = new Map(['a', 'b'].map(d => [d, file(d, { mimeType: 'application/vnd.google-apps.document', name: d })]))
    await tagItems(h.db, h.google, h.llm, docs)
    expect(h.pendingSelects).toHaveLength(1)
    const { sql, params } = h.pendingSelects[0]!
    expect(sql).toMatch(/drive_file_id = any\(select jsonb_array_elements_text\(\$3::jsonb\)\)/)
    expect(JSON.parse(params[2] as string)).toEqual(['a', 'b'])
    // A card he instructed since it was tagged is tagged in full, never only heard again.
    expect(sql).toContain(`and not ${INSTRUCTED_SINCE}) as healing`)
  })
})

describe('tagItems and his instructions', () => {
  it('tells the tagger how he said to take the file in, in plain words', async () => {
    const h = harness([{ id: '1', drive_file_id: 'd', note_for_claude: 'the second half matters', read_as: 'look', healing: false, facets: {} }])
    await tagItems(h.db, h.google, h.llm, new Map([['d', file('d', { mimeType: 'application/vnd.google-apps.document', name: 'A note.md' })]]))
    expect(h.prompts[0]).toContain('Krish says how to take it in: a look is enough.')
    expect(h.prompts[0]).toContain('<note>the second half matters</note>')
  })
  it('says nothing about it when he gave no way to read it', async () => {
    const h = harness([{ id: '1', drive_file_id: 'd', note_for_claude: null, healing: false, facets: {} }])
    await tagItems(h.db, h.google, h.llm, new Map([['d', file('d', { mimeType: 'application/vnd.google-apps.document', name: 'A note.md' })]]))
    expect(h.prompts[0]).not.toContain('how to take it in')
  })
})

describe('tagItems when the model call throws', () => {
  it('fails that card only, by its status, and tags the next', async () => {
    const rows = ['a', 'b', 'c'].map((d, i) => ({ id: String(i), drive_file_id: d, note_for_claude: null, healing: false, facets: {} }))
    const h = harness(rows, { throwOn: n => (n === 1 ? Object.assign(new Error('bad image'), { status: 400 }) : n === 2 ? new Error('socket hang up') : null) })
    const docs = new Map(['a', 'b', 'c'].map(d => [d, file(d, { mimeType: 'application/vnd.google-apps.document', name: d })]))
    const r = await tagItems(h.db, h.google, h.llm, docs)
    expect(h.calls()).toBe(3)
    expect(r).toMatchObject({ tagged: 1, failed: 2, failures: { api_400: 1, api_error: 1 } })
    expect(h.writes.filter(w => /auto_tags/.test(w.sql))).toHaveLength(1)
  })
  it('names the class by status only', () => {
    expect(apiFailureClass(Object.assign(new Error('x'), { status: 529 }))).toBe('api_529')
    expect(apiFailureClass({ status: 'oops' })).toBe('api_error')
    expect(apiFailureClass(null)).toBe('api_error')
  })
})

describe('answerEvidence', () => {
  // Synthetic answers only.
  const row = (over: Partial<AnsweredRow>): AnsweredRow => ({
    id: 'card-1', lane: 'production', name: 'clip.mp4', why_here: null, why_like: null, why_like_source: null, would_do: null,
    route: null, confirmed_tags: [], answered_at: '2026-10-24T10:00:00Z', read_as: null, note_for_claude: null,
    picked_likes: [], routes: [], kind: null, piece_id: null, ...over,
  })

  it('quotes what he typed about what he likes, first', () => {
    const e = answerEvidence(row({ why_like: 'the cut on the beat', why_like_source: 'typed', why_here: 'for the opener', picked_likes: ['tight pacing'] }))
    expect(e).toMatchObject({ attribution: 'krish_words', excerpt: 'the cut on the beat' })
    expect(e.meta).toMatchObject({ picked_likes: ['tight pacing'], why_here: 'for the opener' })
  })

  it('quotes why he saved it when he only tapped likes, so his typed words are his', () => {
    const e = answerEvidence(row({ why_like: 'tight pacing', why_like_source: 'picked', picked_likes: ['tight pacing', 'clean captions'], why_here: 'to copy the pacing' }))
    expect(e).toMatchObject({ attribution: 'krish_words', excerpt: 'to copy the pacing' })
    expect(e.meta.picked_likes).toEqual(['tight pacing', 'clean captions'])
  })

  it('quotes what he would do with it when that is all he typed', () => {
    expect(answerEvidence(row({ would_do: 'try it on Monday', picked_likes: ['a'] }))).toMatchObject({ attribution: 'krish_words', excerpt: 'try it on Monday' })
  })

  it('records only taps as his action, with every pick listed', () => {
    const e = answerEvidence(row({ why_like: 'tight pacing', why_like_source: 'picked', picked_likes: ['tight pacing', 'clean captions'] }))
    expect(e).toMatchObject({ attribution: 'krish_action', excerpt: 'tight pacing; clean captions' })
    // A pick from before several picks lives in why_like alone.
    expect(answerEvidence(row({ why_like: 'one pick', why_like_source: 'picked', picked_likes: [] }))).toMatchObject({ attribution: 'krish_action', excerpt: 'one pick' })
  })

  it('keeps the whole answer in meta, and the kind and piece only when set', () => {
    const e = answerEvidence(row({ why_here: 'x', routes: ['make_piece', 'visibility'], route: 'make_piece', confirmed_tags: ['hook'], read_as: 'watch', note_for_claude: 'skip the intro', kind: 'video', piece_id: 'p-1' }))
    expect(e.lane).toBe('visibility')
    expect(e.meta).toEqual({
      why_here: 'x', would_do: null, why_like_source: null, picked_likes: [], route: 'make_piece', routes: ['make_piece', 'visibility'],
      confirmed_tags: ['hook'], read_as: 'watch', note_for_claude: 'skip the intro', kind: 'video', piece_id: 'p-1',
    })
    const bare = answerEvidence(row({ why_here: 'x' }))
    expect(bare.meta).not.toHaveProperty('kind')
    expect(bare.meta).not.toHaveProperty('piece_id')
  })
})

import { DRIVE } from '../src/config.ts'
import { ruleKind } from '../src/tag/kinds.ts'

describe('ruleKind', () => {
  // Synthetic names in the shapes his folders hold.
  const f = (name: string, mimeType: string, id = 'x') => ({ id, name, mimeType })
  it('settles what the file proves', () => {
    expect(ruleKind(f('anything.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', DRIVE.instagramInspo))).toBe('feed')
    expect(ruleKind(f('Channel inspo.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBe('feed')
    expect(ruleKind(f('SaveClip.App_abc.mp4', 'video/mp4'))).toBe('video')
    expect(ruleKind(f('Screenshot_20261017_055750_Instagram.jpg', 'image/jpeg'))).toBe('image')
    expect(ruleKind(f('some-topic-peer-corpus.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBe('corpus')
    expect(ruleKind(f('a-deep-corpus.csv', 'text/csv'))).toBe('corpus')
    expect(ruleKind(f('Content seed: a thing I noticed', 'application/vnd.google-apps.document'))).toBe('idea')
  })
  it('leaves to the reader what only reading can tell', () => {
    expect(ruleKind(f('A guide to something.md', 'text/markdown'))).toBeNull()
    expect(ruleKind(f('figures.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBeNull()
  })
})

describe('tagItems and kinds', () => {
  const doc = (id: string, name: string, mimeType = 'application/vnd.google-apps.document') => file(id, { name, mimeType, size: undefined })

  it('writes the kind every file settles, on every run, and never over his own', async () => {
    const h = harness([], { known: [
      { id: '1', drive_file_id: 'v', kind: null, kind_source: null },
      { id: '2', drive_file_id: 'c', kind: 'document', kind_source: 'krish' },
      { id: '3', drive_file_id: 'i', kind: 'image', kind_source: 'rule' },
    ] })
    const files = new Map([['v', file('v')], ['c', doc('c', 'x-corpus.csv', 'text/csv')], ['i', file('i', { name: 'a.jpg', mimeType: 'image/jpeg' })]])
    const r = await tagItems(h.db, h.google, h.llm, files)
    expect(r.kinded).toBe(1)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.params).toEqual(['1', 'video'])
    expect(h.writes[0]!.sql).toMatch(/kind_source is distinct from 'krish'/)
  })

  it('never asks the model about the feed', async () => {
    const h = harness([{ id: '1', drive_file_id: DRIVE.instagramInspo, note_for_claude: null, healing: false, facets: {} }])
    const files = new Map([[DRIVE.instagramInspo, doc(DRIVE.instagramInspo, 'Instagram inspo.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]])
    const r = await tagItems(h.db, h.google, h.llm, files)
    expect(h.calls()).toBe(0)
    expect(r.feeds).toBe(1)
    expect(h.writes[0]!.sql).toMatch(/predicted_route = null/)
  })

  it('shows a corpus the slate and keeps the piece it names as a guess, never as the link', async () => {
    const slate = [{ id: 'p0', idea: 'One piece', hit: true }, { id: 'p1', idea: 'The piece it serves', hit: true }, { id: 'p2', idea: 'Unrelated', hit: false }]
    const h = harness([{ id: '1', drive_file_id: 'c', note_for_claude: null, healing: false, facets: {} }], { slate, answer: { piece_ref: 1 } })
    await tagItems(h.db, h.google, h.llm, new Map([['c', doc('c', 'topic-corpus.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]]))
    expect(h.prompts[0]).toContain('1. The piece it serves')
    const w = h.writes.at(-1)!
    expect(JSON.parse(w.params[7] as string).piece_guess).toEqual({ id: 'p1', idea: 'The piece it serves' })
    expect(JSON.parse(w.params[7] as string).piece_options).toEqual([{ id: 'p0', idea: 'One piece' }])
    expect(w.params.slice(11)).toEqual(['corpus', 'rule'])
    expect(w.sql).not.toMatch(/piece_id/)
  })

  it('takes a document\'s kind from the reading, and drops a piece number that is not on the slate', async () => {
    const h = harness([{ id: '1', drive_file_id: 'd', note_for_claude: null, healing: false, facets: {} }], { slate: [{ id: 'p0', idea: 'One' }], answer: { kind: 'idea', piece_ref: 7 } })
    await tagItems(h.db, h.google, h.llm, new Map([['d', doc('d', 'A note.md', 'text/markdown')]]))
    const w = h.writes.at(-1)!
    expect(w.params.slice(11)).toEqual(['idea', 'model'])
    expect(JSON.parse(w.params[7] as string).piece_guess).toBeNull()
  })

  it('keeps an opinion only when it says something, and a video\'s reason only on a video', async () => {
    const h = harness([{ id: '1', drive_file_id: 'v', note_for_claude: null, healing: false, facets: {} }],
      { answer: { reason: 'narrative', opinion: { topic: 'AI agents at work', stance: 'They will take the dull half of every job first.' } } })
    await tagItems(h.db, h.google, h.llm, new Map([['v', file('v')]]), 60, true, { watch: async () => watched({ heard: 'silent', unheard: null }) })
    const facets = JSON.parse(h.writes.at(-1)!.params[7] as string)
    expect(facets.reason_guess).toBe('narrative')
    expect(facets.opinion).toEqual({ topic: 'AI agents at work', stance: 'They will take the dull half of every job first.' })
    const h2 = harness([{ id: '1', drive_file_id: 'd', note_for_claude: null, healing: false, facets: {} }], { answer: { kind: 'document', reason: 'script', opinion: { topic: '', stance: '' } } })
    await tagItems(h2.db, h2.google, h2.llm, new Map([['d', doc('d', 'A note.md', 'text/markdown')]]))
    const f2 = JSON.parse(h2.writes.at(-1)!.params[7] as string)
    expect(f2.reason_guess).toBeNull()
    expect(f2.opinion).toBeNull()
  })
})

describe('nameWords', () => {
  it('keeps the telling words of a file name and never matches when there are none', () => {
    expect(nameWords('topic-peer-corpus.xlsx')).toBe('\\m(topic)')
    expect(nameWords('Higgsfield under the hood.docx')).toBe('\\m(higgsfield|under|hood)')
    expect(nameWords('corpus.csv')).toBe('$^')
  })
})
