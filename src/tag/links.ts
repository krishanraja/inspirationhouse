import type { Db } from '../db.ts'
import type { DriveFile } from '../google.ts'

// A link Krish pasted on the Inspiration board becomes a card here (design: the link box, 2026-10-24). content-watcher,
// on his home computer, fetched the post, filed each media file into his Drive folder, and wrote the request's media:
// [{name, sha256, mime, bytes, folder}], one entry per file. Drive tells each file's sha256 too, so a request's files are
// found by that hash and their cards by drive_file_id. The request then points at its card (item_id), the card carries
// the link, and his note typed at paste time is kept as why he saved it. Logs carry counts only: this repository is
// public.

export interface LinkResult {
  /** Requests linked to their card this run. */
  linked: number
  /** Other slides of a carousel folded into its card (facets.part_of). */
  slides: number
  /** Paste notes kept as the card's why_here. */
  notes: number
}

interface Request {
  id: string; url: string; platform: string; note: string | null; requested_at: string; media: unknown; read_id: string | null
}
interface Card {
  id: string; drive_file_id: string; why_here: string | null
  /** The request whose post this card already is (facets.link.request_id), and the card it is a slide of (part_of). */
  owner: string | null; part_of: string | null
}
interface Reading { id: string; sha256: string; author: string | null; posted_at: string | null }

const SHA256 = /^[a-f0-9]{64}$/

/** Drive's sha256 of a file, lowercase, or null when Drive gave none. */
export function driveSha(f: DriveFile): string | null {
  const sha = f.sha256Checksum?.trim().toLowerCase()
  return sha && SHA256.test(sha) ? sha : null
}

/** Each media entry's sha256 in `media` order, lowercase, or null where an entry names none. */
export function mediaShas(media: unknown): Array<string | null> {
  if (!Array.isArray(media)) return []
  return media.map(m => {
    const sha = m && typeof m === 'object' ? (m as { sha256?: unknown }).sha256 : null
    const low = typeof sha === 'string' ? sha.trim().toLowerCase() : ''
    return SHA256.test(low) ? low : null
  })
}

/** What the card carries about the link: facets.link. A slide also carries its place in the post (`slide`, from 0). */
export interface LinkFacet {
  request_id: string; url: string; platform: string; author: string | null; posted_at: string | null
  requested_at: string; slides: number; slide?: number
  /** The request's note as the card last took it (the post's own card only), so a new one can replace it. */
  note?: string | null
}

/** The request's card and the post's other slides, from the cards of the files its media name. */
export function placeRequest(shas: Array<string | null>, cardOf: (sha: string) => Card | null): { card: Card; main: number; others: Array<{ card: Card; slide: number }> } | null {
  const slots = shas.map(sha => (sha ? cardOf(sha) : null))
  // The request's card is the card of the first media entry, in media order, that has one.
  const main = slots.findIndex(c => c !== null)
  if (main < 0) return null
  const card = slots[main]!
  const seen = new Set([card.id])
  const others: Array<{ card: Card; slide: number }> = []
  for (const [slide, c] of slots.entries()) {
    if (!c || seen.has(c.id)) continue
    seen.add(c.id)
    others.push({ card: c, slide })
  }
  return { card, main, others }
}

/** A card no other post has taken: not a slide of another card, and not the card of another request. */
const freeFor = (requestId: string) => (c: Card) => !c.part_of && (!c.owner || c.owner === requestId)
const FREE = (a: string) => `not ${a}.facets ? 'part_of' and coalesce(${a}.facets->'link'->>'request_id', $1::text) = $1::text`

// One request in one statement: the request takes its card only while it has none and the card is still free, and the
// card and its slides change only when it did, so a second run, or two runs at once, change nothing. His note becomes
// why_here only when the card has none; `o` is the card as it was, so the count says whether this statement kept the
// note. A slide another post already took is left as it is.
const LINK_SQL = `
  with req as (
    update public.content_watch_requests set item_id = $2::uuid, updated_at = now()
    where id = $1::uuid and item_id is null
      and exists (select 1 from public.inspiration_items f where f.id = $2::uuid and ${FREE('f')})
    returning id
  ), card as (
    update public.inspiration_items i
    set facets = i.facets || jsonb_build_object('link', $3::jsonb),
        why_here = case when i.why_here is null then $4::text else i.why_here end,
        updated_at = now()
    from public.inspiration_items o
    where i.id = $2::uuid and o.id = i.id and exists (select 1 from req)
    returning (o.why_here is null and $4::text is not null) as note_kept
  ), slides as (
    update public.inspiration_items s
    set facets = s.facets || jsonb_build_object('part_of', $2::text, 'link', x.link), updated_at = now()
    from jsonb_to_recordset($5::jsonb) as x(id uuid, link jsonb)
    where s.id = x.id and exists (select 1 from req) and ${FREE('s')}
    returning 1
  )
  select (select count(*) from req)::int as linked,
         (select count(*) from slides)::int as slides,
         (select count(*) from card where note_kept)::int as notes`

// His note follows the request on a card he has not answered yet: the new note when he pastes the link again (Control
// Center writes it to the request), or the same note back after his Undo on the page, which clears why_here. It
// replaces only a why_here that is empty or still the note the card last took, and never touches an answered card:
// that is his answer. The conditions sit on the updated row, so an answer saved meanwhile is seen and left alone.
const NOTE_DUE = `
  q.item_id = i.id and nullif(btrim(q.note), '') is not null
  and i.answered_at is null and not i.facets ? 'part_of'
  and i.facets->'link'->>'request_id' = q.id::text
  and (i.why_here is null or i.why_here = i.facets->'link'->>'note')
  and i.why_here is distinct from q.note`

/** Give each linked card he has not answered the note on its request (NOTE_DUE). Returns the notes it gave. */
async function followNotes(db: Db, write: boolean): Promise<number> {
  const [res] = write
    ? await db.query<{ n: number }>(
      `with w as (
         update public.inspiration_items i
         set why_here = q.note, facets = jsonb_set(i.facets, '{link,note}', to_jsonb(q.note)), updated_at = now()
         from public.content_watch_requests q
         where ${NOTE_DUE}
         returning 1)
       select count(*)::int as n from w`,
      [], { write: true },
    )
    : await db.query<{ n: number }>(
      `select count(*)::int as n from public.content_watch_requests q, public.inspiration_items i where ${NOTE_DUE}`,
    )
  return Number(res?.n ?? 0)
}

/**
 * Link every request whose media reached Drive to its card: for each request filed or read, with no card yet and some
 * media, its card is the card of the first media file (in `media` order) that has one, matched by sha256 against the
 * files listed this run. Then every linked card he has not answered takes the note on its request (followNotes). A dry
 * run counts what it would do and writes nothing.
 */
export async function linkRequests(db: Db, files: Map<string, DriveFile>, write = true): Promise<LinkResult> {
  const result: LinkResult = { linked: 0, slides: 0, notes: 0 }
  // Until content-engine's link queue (migration 20261109090000) is applied, there is nothing to link.
  const [reg] = await db.query<{ ok: boolean }>(
    `select to_regclass('public.content_watch_requests') is not null and to_regclass('public.content_reads') is not null as ok`,
  )
  if (!reg?.ok) return result
  await linkNew(db, files, write, result)
  result.notes += await followNotes(db, write)
  return result
}

async function linkNew(db: Db, files: Map<string, DriveFile>, write: boolean, result: LinkResult): Promise<void> {
  const requests = await db.query<Request>(
    `select id::text, url, platform, note, to_json(requested_at) #>> '{}' as requested_at, media, read_id::text
     from public.content_watch_requests
     where status in ('filed', 'read') and item_id is null
       and jsonb_typeof(media) = 'array' and jsonb_array_length(media) > 0
     order by requested_at`,
  )
  if (!requests.length) return

  const fileBySha = new Map<string, string>()
  for (const f of files.values()) {
    const sha = driveSha(f)
    if (sha && !fileBySha.has(sha)) fileBySha.set(sha, f.id)
  }
  const shasOf = requests.map(r => mediaShas(r.media))
  const fileIds = [...new Set(shasOf.flat().map(sha => (sha ? fileBySha.get(sha) : undefined)).filter((x): x is string => !!x))]
  if (!fileIds.length) return
  const cards = await db.query<Card>(
    `select id::text, drive_file_id, why_here,
            case when jsonb_typeof(facets->'link'->'request_id') = 'string' then facets->'link'->>'request_id' end as owner,
            case when jsonb_typeof(facets->'part_of') = 'string' then facets->>'part_of' end as part_of
     from public.inspiration_items
     where drive_file_id = any(select jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(fileIds)],
  )
  const cardByFile = new Map(cards.map(c => [c.drive_file_id, c]))
  const cardOf = (sha: string) => cardByFile.get(fileBySha.get(sha) ?? '') ?? null

  // The post's author and date, from content-watcher's reading of it, when it says them.
  const reads = await db.query<Reading>(
    `select id::text, sha256,
            case when jsonb_typeof(read->'post'->'author') = 'string' then read->'post'->>'author' end as author,
            case when jsonb_typeof(read->'post'->'posted_at') = 'string' then read->'post'->>'posted_at' end as posted_at
     from public.content_reads
     where id::text = any(select jsonb_array_elements_text($1::jsonb))
        or sha256 = any(select jsonb_array_elements_text($2::jsonb))`,
    [JSON.stringify(requests.map(r => r.read_id).filter(Boolean)), JSON.stringify([...new Set(shasOf.flat().filter(Boolean))])],
  )
  const readById = new Map(reads.map(r => [r.id, r]))
  const readBySha = new Map(reads.map(r => [r.sha256, r]))

  for (const [i, r] of requests.entries()) {
    const shas = shasOf[i]!
    // Only cards no other post has taken: the same post pasted under a second address, or a single picture that is
    // already a slide of another post, never rewrites that post's card.
    const free = freeFor(r.id)
    const placed = placeRequest(shas, sha => { const c = cardOf(sha); return c && free(c) ? c : null })
    if (!placed) {
      // Every card is another post's: the request points at that post's card, so it stops waiting, and changes nothing.
      const taken = shas.map(sha => (sha ? cardOf(sha) : null)).find(c => c !== null)
      if (!taken) continue
      if (!write) { result.linked++; continue }
      const [res] = await db.query<{ n: number }>(
        `with req as (
           update public.content_watch_requests set item_id = $2::uuid, updated_at = now()
           where id = $1::uuid and item_id is null returning 1)
         select count(*)::int as n from req`,
        [r.id, taken.part_of ?? taken.id], { write: true },
      )
      result.linked += Number(res?.n ?? 0)
      continue
    }
    const reading = (r.read_id ? readById.get(r.read_id) : undefined)
      ?? readBySha.get(shas[placed.main]!)
      ?? shas.map(sha => (sha ? readBySha.get(sha) : undefined)).find(Boolean)
    const link: LinkFacet = {
      request_id: r.id, url: r.url, platform: r.platform, author: reading?.author ?? null, posted_at: reading?.posted_at ?? null,
      requested_at: r.requested_at, slides: shas.length,
    }
    // His words, typed when he pasted it; blank is no note.
    const note = typeof r.note === 'string' && r.note.trim() ? r.note : null
    // Later requests this run see the cards this one takes.
    const take = () => {
      placed.card.owner = r.id
      for (const o of placed.others) o.card.part_of = placed.card.id
    }
    if (!write) {
      result.linked++
      result.slides += placed.others.length
      if (note && placed.card.why_here === null) result.notes++
      take()
      continue
    }
    const [res] = await db.query<{ linked: number; slides: number; notes: number }>(
      LINK_SQL,
      [r.id, placed.card.id, JSON.stringify({ ...link, note }), note,
        JSON.stringify(placed.others.map(o => ({ id: o.card.id, link: { ...link, slide: o.slide } })))],
      { write: true },
    )
    result.linked += Number(res?.linked ?? 0)
    result.slides += Number(res?.slides ?? 0)
    result.notes += Number(res?.notes ?? 0)
    if (Number(res?.linked ?? 0)) take()
  }
}
