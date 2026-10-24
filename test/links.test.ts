import { describe, it, expect } from 'vitest'
import { linkRequests, mediaShas, placeRequest, driveSha } from '../src/tag/links.ts'
import type { Db } from '../src/db.ts'
import type { DriveFile } from '../src/google.ts'

// Synthetic links, files and cards only; nothing here is anything Krish saved.
const sha = (c: string) => c.repeat(64)
const file = (id: string, hash: string | undefined): DriveFile =>
  ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', modifiedTime: '2026-10-24T00:00:00Z', createdTime: '2026-10-24T00:00:00Z', sha256Checksum: hash })

type Req = { id: string; url: string; platform: string; note: string | null; requested_at: string; media: unknown; read_id: string | null; status: string; item_id: string | null }
type Card = { id: string; drive_file_id: string; why_here: string | null; facets: Record<string, unknown> }
type Read = { id: string; sha256: string; author: string | null; posted_at: string | null }

/** A small stand-in for the three tables, which runs the linking statement's rules on them. */
function world(init: { requests: Req[]; cards: Card[]; reads?: Read[]; tables?: boolean }) {
  const requests = init.requests.map(r => ({ ...r }))
  const cards = init.cards.map(c => ({ ...c, facets: { ...c.facets } }))
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = [], o?: { write?: boolean }) {
      // A linked card taking the note on its request runs on the real schema (test/pipeline.int.test.ts); here it finds
      // none to give.
      if (/i\.facets->'link'->>'note'/.test(sql)) return [{ n: 0 }] as T[]
      if (o?.write && /set item_id = \$2::uuid, updated_at = now\(\)\s+where id = \$1::uuid and item_id is null returning 1\)/.test(sql)) {
        // A request pointed at a card another post already took: only the request changes.
        writes.push({ sql, params })
        const req = requests.find(r => r.id === params[0])!
        if (req.item_id !== null) return [{ n: 0 }] as T[]
        req.item_id = params[1] as string
        return [{ n: 1 }] as T[]
      }
      if (o?.write) {
        writes.push({ sql, params })
        const [reqId, cardId, link, note, slides] = params as [string, string, string, string | null, string]
        const req = requests.find(r => r.id === reqId)!
        if (req.item_id !== null) return [{ linked: 0, slides: 0, notes: 0 }] as T[]
        req.item_id = cardId
        const card = cards.find(c => c.id === cardId)!
        card.facets = { ...card.facets, link: JSON.parse(link) }
        const kept = card.why_here === null && note !== null
        if (card.why_here === null) card.why_here = note
        const others = JSON.parse(slides) as Array<{ id: string; link: unknown }>
        for (const s of others) {
          const c = cards.find(x => x.id === s.id)!
          c.facets = { ...c.facets, part_of: cardId, link: s.link }
        }
        return [{ linked: 1, slides: others.length, notes: kept ? 1 : 0 }] as T[]
      }
      if (/to_regclass/.test(sql)) return [{ ok: init.tables ?? true }] as T[]
      if (/from public\.content_watch_requests/.test(sql)) {
        return requests.filter(r => ['filed', 'read'].includes(r.status) && r.item_id === null && Array.isArray(r.media) && r.media.length) as T[]
      }
      if (/from public\.inspiration_items/.test(sql)) {
        const ids = JSON.parse(params[0] as string) as string[]
        return cards.filter(c => ids.includes(c.drive_file_id)).map(c => ({ ...c,
          owner: (c.facets.link as { request_id?: string } | undefined)?.request_id ?? null, part_of: c.facets.part_of ?? null })) as T[]
      }
      if (/from public\.content_reads/.test(sql)) {
        const ids = JSON.parse(params[0] as string) as string[]
        const shas = JSON.parse(params[1] as string) as string[]
        return (init.reads ?? []).filter(r => ids.includes(r.id) || shas.includes(r.sha256)) as T[]
      }
      return [] as T[]
    },
    close: async () => {},
  }
  return { db, requests, cards, writes }
}

const request = (over: Partial<Req>): Req => ({
  id: 'req-1', url: 'https://www.instagram.com/p/abc/', platform: 'instagram', note: null, requested_at: '2026-10-24T09:00:00+00:00',
  media: [], read_id: null, status: 'read', item_id: null, ...over,
})
const card = (id: string, fileId: string, over: Partial<Card> = {}): Card => ({ id, drive_file_id: fileId, why_here: null, facets: { platform: 'instagram' }, ...over })

describe('linkRequests', () => {
  it('links a request to the card of its first media file that has one, and carries the link onto it', async () => {
    const w = world({
      requests: [request({ media: [{ sha256: sha('0') }, { sha256: sha('b') }], read_id: 'read-1' })],
      cards: [card('card-b', 'file-b')],
      reads: [{ id: 'read-1', sha256: sha('b'), author: 'a synthetic author', posted_at: '2026-10-20' }],
    })
    // The first file never reached Drive, so the second file's card is the request's card.
    const r = await linkRequests(w.db, new Map([['file-b', file('file-b', sha('b'))]]))
    expect(r).toEqual({ linked: 1, slides: 0, notes: 0 })
    expect(w.requests[0]!.item_id).toBe('card-b')
    expect(w.cards[0]!.facets).toEqual({
      platform: 'instagram',
      link: { request_id: 'req-1', url: 'https://www.instagram.com/p/abc/', platform: 'instagram', author: 'a synthetic author',
        posted_at: '2026-10-20', requested_at: '2026-10-24T09:00:00+00:00', slides: 2, note: null },
    })
  })

  it('folds a carousel into one card: every other slide points at it, with its place in the post', async () => {
    const w = world({
      requests: [request({ media: [{ sha256: sha('a') }, { sha256: sha('b') }, { sha256: sha('c') }] })],
      cards: [card('card-a', 'file-a'), card('card-b', 'file-b'), card('card-c', 'file-c')],
    })
    const files = new Map(['a', 'b', 'c'].map(x => [`file-${x}`, file(`file-${x}`, sha(x))]))
    expect(await linkRequests(w.db, files)).toEqual({ linked: 1, slides: 2, notes: 0 })
    const [a, b, c] = w.cards
    expect(a!.facets.part_of).toBeUndefined()
    expect(a!.facets.link).toMatchObject({ slides: 3 })
    expect(b!.facets).toMatchObject({ part_of: 'card-a', link: { request_id: 'req-1', slides: 3, slide: 1 } })
    expect(c!.facets).toMatchObject({ part_of: 'card-a', link: { slide: 2 } })
    // Author and date are null when no reading says them.
    expect(a!.facets.link).toMatchObject({ author: null, posted_at: null })
  })

  it('keeps his paste note as why he saved it only when the card has none', async () => {
    const w = world({
      requests: [
        request({ id: 'req-1', note: 'the pacing in the first three seconds', media: [{ sha256: sha('a') }] }),
        request({ id: 'req-2', note: 'a note that must not replace his answer', media: [{ sha256: sha('b') }] }),
        request({ id: 'req-3', note: '   ', media: [{ sha256: sha('c') }] }),
      ],
      cards: [card('card-a', 'file-a'), card('card-b', 'file-b', { why_here: 'what he typed on the card' }), card('card-c', 'file-c')],
    })
    const files = new Map(['a', 'b', 'c'].map(x => [`file-${x}`, file(`file-${x}`, sha(x))]))
    expect(await linkRequests(w.db, files)).toEqual({ linked: 3, slides: 0, notes: 1 })
    expect(w.cards.map(c => c.why_here)).toEqual(['the pacing in the first three seconds', 'what he typed on the card', null])
  })

  it('changes nothing on a second run', async () => {
    const w = world({ requests: [request({ note: 'why', media: [{ sha256: sha('a') }, { sha256: sha('b') }] })], cards: [card('card-a', 'file-a'), card('card-b', 'file-b')] })
    const files = new Map(['a', 'b'].map(x => [`file-${x}`, file(`file-${x}`, sha(x))]))
    expect(await linkRequests(w.db, files)).toEqual({ linked: 1, slides: 1, notes: 1 })
    const after = JSON.stringify(w.cards)
    expect(await linkRequests(w.db, files)).toEqual({ linked: 0, slides: 0, notes: 0 })
    expect(JSON.stringify(w.cards)).toBe(after)
    expect(w.writes).toHaveLength(1)
    // The statement itself takes a request only while it has no card.
    expect(w.writes[0]!.sql).toMatch(/where id = \$1::uuid and item_id is null/)
    expect(w.writes[0]!.sql).toMatch(/exists \(select 1 from req\)/)
  })

  it('points a request whose cards another post already took at that post\'s card, and changes no card', async () => {
    const link = { request_id: 'req-1', url: 'https://www.instagram.com/p/abc/', slides: 2 }
    const w = world({
      requests: [
        request({ id: 'req-1', media: [{ sha256: sha('a') }, { sha256: sha('b') }], item_id: 'card-a' }),
        request({ id: 'req-2', note: 'the same post again', media: [{ sha256: sha('a') }] }),
        request({ id: 'req-3', note: 'a single picture', media: [{ sha256: sha('b') }] }),
      ],
      cards: [card('card-a', 'file-a', { facets: { link } }), card('card-b', 'file-b', { facets: { part_of: 'card-a', link: { ...link, slide: 1 } } })],
    })
    const before = JSON.stringify(w.cards)
    const files = new Map(['a', 'b'].map(x => [`file-${x}`, file(`file-${x}`, sha(x))]))
    expect(await linkRequests(w.db, files)).toEqual({ linked: 2, slides: 0, notes: 0 })
    expect(w.requests.map(r => r.item_id)).toEqual(['card-a', 'card-a', 'card-a'])
    expect(JSON.stringify(w.cards)).toBe(before)
    expect(w.writes.map(x => x.params.length)).toEqual([2, 2])
  })

  it('lets the first of two new pastes of one post take its card, and points the second at it', async () => {
    const w = world({
      requests: [request({ id: 'req-1', note: 'pasted first', media: [{ sha256: sha('a') }] }), request({ id: 'req-2', note: 'pasted second', media: [{ sha256: sha('a') }] })],
      cards: [card('card-a', 'file-a')],
    })
    expect(await linkRequests(w.db, new Map([['file-a', file('file-a', sha('a'))]]))).toEqual({ linked: 2, slides: 0, notes: 1 })
    expect(w.cards[0]).toMatchObject({ why_here: 'pasted first', facets: { link: { request_id: 'req-1' } } })
    expect(w.requests[1]!.item_id).toBe('card-a')
  })

  it('matches a file by its sha256 whatever the case on either side', async () => {
    const w = world({ requests: [request({ media: [{ sha256: sha('A') }] })], cards: [card('card-a', 'file-a')] })
    expect((await linkRequests(w.db, new Map([['file-a', file('file-a', sha('a'))]]))).linked).toBe(1)
    const w2 = world({ requests: [request({ media: [{ sha256: sha('a') }] })], cards: [card('card-a', 'file-a')] })
    expect((await linkRequests(w2.db, new Map([['file-a', file('file-a', sha('A'))]]))).linked).toBe(1)
  })

  it('leaves a request whose files have no card yet, or have not reached Drive', async () => {
    const w = world({ requests: [request({ media: [{ sha256: sha('a') }] }), request({ id: 'req-2', media: [{ sha256: sha('b') }] })], cards: [] })
    expect(await linkRequests(w.db, new Map([['file-a', file('file-a', sha('a'))]]))).toEqual({ linked: 0, slides: 0, notes: 0 })
    expect(w.requests.every(r => r.item_id === null)).toBe(true)
  })

  it('counts and writes nothing on a dry run', async () => {
    const w = world({ requests: [request({ note: 'why', media: [{ sha256: sha('a') }, { sha256: sha('b') }] })], cards: [card('card-a', 'file-a'), card('card-b', 'file-b')] })
    const files = new Map(['a', 'b'].map(x => [`file-${x}`, file(`file-${x}`, sha(x))]))
    expect(await linkRequests(w.db, files, false)).toEqual({ linked: 1, slides: 1, notes: 1 })
    expect(w.writes).toEqual([])
    expect(w.requests[0]!.item_id).toBeNull()
  })

  it('does nothing until the link queue exists', async () => {
    const w = world({ requests: [request({ media: [{ sha256: sha('a') }] })], cards: [card('card-a', 'file-a')], tables: false })
    expect(await linkRequests(w.db, new Map([['file-a', file('file-a', sha('a'))]]))).toEqual({ linked: 0, slides: 0, notes: 0 })
  })
})

describe('the pieces of linking', () => {
  it('reads each media entry\'s sha256 in order, lowercase, keeping a place for one that names none', () => {
    expect(mediaShas([{ sha256: sha('A') }, { name: 'x' }, { sha256: 'not a hash' }, null, { sha256: sha('b') }])).toEqual([sha('a'), null, null, null, sha('b')])
    expect(mediaShas('not a list')).toEqual([])
  })
  it('takes Drive\'s hash only when it is one', () => {
    expect(driveSha(file('f', sha('C')))).toBe(sha('c'))
    expect(driveSha(file('f', undefined))).toBeNull()
    expect(driveSha(file('f', 'abc'))).toBeNull()
  })
  it('never folds the card into itself, and folds a card once', () => {
    const c = { id: 'card-a', drive_file_id: 'f', why_here: null, owner: null, part_of: null }
    const d = { id: 'card-d', drive_file_id: 'g', why_here: null, owner: null, part_of: null }
    const placed = placeRequest([sha('a'), sha('a'), sha('d'), sha('d')], s => (s === sha('a') ? c : d))!
    expect(placed.card).toBe(c)
    expect(placed.others).toEqual([{ card: d, slide: 2 }])
  })
})
