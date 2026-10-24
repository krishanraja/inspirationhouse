import { describe, it, expect } from 'vitest'
import { tagItems, HEAR_TRIES, needsTags } from '../src/tag/items.ts'
import type { Db } from '../src/db.ts'
import type { Google, DriveFile } from '../src/google.ts'
import type { Llm } from '../src/llm.ts'
import type { Watched } from '../src/tag/watch.ts'

// Synthetic cards and files only; nothing here is anything Krish saved.
type Row = { id: string; drive_file_id: string; note_for_claude: string | null; healing: boolean; facets: Record<string, unknown> | null }
const file = (id: string, over: Partial<DriveFile> = {}): DriveFile =>
  ({ id, name: `clip-${id}.mp4`, mimeType: 'video/mp4', modifiedTime: '2026-10-24T00:00:00Z', createdTime: '2026-10-24T00:00:00Z', size: '1000', ...over })

function harness(rows: Row[], opts: { download?: (id: string) => Promise<Buffer> } = {}) {
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      if (/^\s*update/i.test(sql)) { writes.push({ sql, params }); return [] as T[] }
      if (/from public\.inspiration_items\s+where \(tagged_at is null/.test(sql)) return rows as T[]
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
  const llm: Llm = {
    model: 'm',
    async structured() {
      calls++
      return { data: { tags: [], predicted: { why_here: [], why_like: [], would_do: [] }, route: 'taste_only',
        facets: { platform: 'instagram', format: 'short_video', source: null, creator: null, people: [], organisations: [], topics: [] } } as never, failure: null, model: 'm' }
    },
  }
  return { db, google, llm, writes, downloads, calls: () => calls }
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
})
