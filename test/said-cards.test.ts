import { describe, it, expect } from 'vitest'
import { saidCardEvidence, saidEvidence } from '../src/tag/items.ts'
import type { Db } from '../src/db.ts'

// "Say it" cards (W3.2, content-engine 20261118093200_inspiration_said_cards): his said idea is his words. Synthetic words.
const row = (said: Record<string, unknown> | null) => ({ id: '00000000-0000-4000-8000-000000000101', said, said_at: '2026-10-29T17:50:27Z' })

describe('a "Say it" card', () => {
  it('is his words, under its own source_ref, from when he said it', () => {
    const e = saidEvidence(row({ title: 'synthetic idea', excerpt: 'synthetic: a piece on why the meeting never ends', landed_table: 'content_ideas' }))!
    expect(e).toMatchObject({ source: 'inspiration_page', sourceRef: 'said:00000000-0000-4000-8000-000000000101',
      occurredAt: '2026-10-29T17:50:27Z', attribution: 'krish_words', polarity: 'likes', lane: 'strategy',
      excerpt: 'synthetic: a piece on why the meeting never ends', venture: 'publication' })
    expect(e.meta).toMatchObject({ said: true, kind: 'idea', landed_table: 'content_ideas' })
  })
  it('falls back to the title, and files nothing with no words', () => {
    expect(saidEvidence(row({ title: 'synthetic: only a title' }))!.excerpt).toBe('synthetic: only a title')
    expect(saidEvidence(row({ excerpt: '  ' }))).toBeNull()
    expect(saidEvidence(row(null))).toBeNull()
  })
  it('reads nothing before the migration, and only standing said cards after it', async () => {
    const before = { query: async () => [{ ok: false }] } as unknown as Db
    expect(await saidCardEvidence(before)).toEqual([])
    const sqls: string[] = []
    const after = { query: async (sql: string) => {
      sqls.push(sql)
      return /information_schema/.test(sql) ? [{ ok: true }] : [row({ excerpt: 'synthetic words' }), row({})]
    } } as unknown as Db
    const ev = await saidCardEvidence(after)
    expect(ev).toHaveLength(1)
    expect(sqls[1]).toMatch(/said_part_id is not null and dismissed_at is null/)
  })
})
