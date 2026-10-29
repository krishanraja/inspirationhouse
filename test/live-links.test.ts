import { describe, it, expect, afterAll } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { connect, readOnly, type Db } from '../src/db.ts'

// The three live link tests of W3.2: one TikTok link, one LinkedIn link and one long YouTube link (ten minutes or more),
// each read by content-watcher, filed as a card, linked and tagged. They read the live database, read only, and cost
// nothing: no model and no fetch here. They run only with LIVE_LINKS=1 (and DATABASE_URL, or the Management API through
// a session proxy), and a platform with no link pasted yet stays pending until Krish pastes one on the Inspiration board.
const live = process.env.LIVE_LINKS === '1'
const LONG_S = 600

interface Row { platform: string; status: string; read: boolean; item: boolean; duration_s: number | null; tagged: boolean; read_from: string | null; media: number }

const PLATFORMS: Array<{ name: string; where: string; long?: boolean }> = [
  { name: 'tiktok', where: `q.platform = 'tiktok'` },
  { name: 'linkedin', where: `q.platform = 'linkedin'` },
  { name: 'long youtube', where: `q.platform = 'youtube' and coalesce((c.read->'video'->>'duration_s')::float, 0) >= ${LONG_S}`, long: true },
]

describe.skipIf(!live)('live links: read, tagged and filed', () => {
  let raw: Awaited<ReturnType<typeof connect>> | null = null
  let db: Db | null = null
  const open = async () => { if (!db) { raw = await connect(loadConfig()); db = readOnly(raw) } return db }
  afterAll(async () => { await raw?.close() })

  for (const p of PLATFORMS) {
    it(`${p.name}: the newest link pasted is read, filed as a card, linked and tagged from its reading`, async (t) => {
      const rows = await (await open()).query<Row>(
        `select q.platform, q.status, q.read_id is not null as read, q.item_id is not null as item,
                (c.read->'video'->>'duration_s')::float as duration_s, i.tagged_at is not null as tagged, i.facets->>'read_from' as read_from,
                coalesce(jsonb_array_length(case when jsonb_typeof(q.media) = 'array' then q.media else '[]'::jsonb end), 0)::int as media
         from public.content_watch_requests q
         left join public.content_reads c on c.id = q.read_id
         left join public.inspiration_items i on i.id = q.item_id
         where ${p.where} order by q.requested_at desc limit 1`,
      )
      // Pending, not passed: nothing of this platform has been pasted yet.
      if (!rows.length) { t.skip(); return }
      const r = rows[0]!
      expect(r).toMatchObject({ status: 'read', read: true, item: true, tagged: true, read_from: 'content_reads' })
      expect(r.media).toBeGreaterThan(0)
      if (p.long) expect(r.duration_s).toBeGreaterThanOrEqual(LONG_S)
    })
  }
})
