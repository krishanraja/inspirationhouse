import { describe, it, expect } from 'vitest'
import { Meter, priceUsd, priceUsdUncached, priceFamily, readUsage, unitKey, NO_USAGE } from '../src/meter.ts'
import { staged, type Llm } from '../src/llm.ts'
import type { Db } from '../src/db.ts'

// Synthetic token counts only.
describe('the meter', () => {
  it('prices a call as Control Center does, cache reads and writes included', () => {
    const u = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 0 }
    // $2 in, $1 out, $0.40 read at a tenth, $2.50 written at a quarter more.
    expect(priceUsd('claude-sonnet-5', u)).toBeCloseTo(5.9, 6)
    expect(priceUsdUncached('claude-sonnet-5', u)).toBeCloseTo(9, 6)
    // Opus 5.5 reads back at its own rate.
    expect(priceUsd('claude-opus-5-5', { ...NO_USAGE, cacheRead: 1_000_000 })).toBeCloseTo(0.2, 6)
  })
  it('never borrows a rate: a dated snapshot prices as its model, a longer id is unpriced', () => {
    expect(priceFamily('claude-sonnet-5-20261001')).toBe('claude-sonnet-5')
    expect(priceFamily('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(priceFamily('claude-sonnet-5-9')).toBeNull()
    expect(priceUsd('claude-sonnet-5-9', { ...NO_USAGE, input: 1e6 })).toBe(0)
  })
  it('reads whatever usage fields are present, the hour-long cache write apart', () => {
    expect(readUsage({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 } }))
      .toEqual({ input: 10, cacheRead: 5, cacheWrite5m: 3, cacheWrite1h: 2 })
    expect(readUsage({ output_tokens: 7 })).toEqual({ output: 7 })
    expect(readUsage(null)).toEqual({})
  })
  it('keys a stage as Control Center normalises an agent', () => {
    expect(unitKey('tag')).toBe('inspirationhouse-tag')
    expect(unitKey('Rejections_Floor')).toBe('inspirationhouse-rejections-floor')
  })
  it('posts one row per stage and model through meter_add, once', async () => {
    const m = new Meter()
    m.record('tag', 'claude-sonnet-5', { input: 1000, output: 100 })
    m.record('tag', 'claude-sonnet-5', { input: 1000, output: 100, cacheRead: 500 })
    m.record('explain', 'claude-sonnet-5', { input: 10, output: 1 }, true)
    const sent: Array<{ sql: string; params: unknown[]; write?: boolean }> = []
    const db = { query: async (sql: string, params: unknown[] = [], opts?: { write?: boolean }) => { sent.push({ sql, params, write: opts?.write }); return [] } } as unknown as Db
    expect(await m.flush(db, '2026-10-29')).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sql).toContain('public.meter_add(')
    expect(sent[0]!.write).toBe(true)
    const rows = JSON.parse(String(sent[0]!.params[0]))
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'anthropic', unit_kind: 'agent', unit_key: 'inspirationhouse-tag', day: '2026-10-29',
        bucket: 'claude-sonnet-5', category: 'priced', runs: 2, failed: 0, units: 2700, cache_read_tokens: 500 }),
      expect.objectContaining({ unit_key: 'inspirationhouse-explain', runs: 1, failed: 1 }),
    ]))
    // A second flush adds nothing.
    expect(await m.flush(db, '2026-10-29')).toBe(0)
    expect(sent).toHaveLength(1)
  })
  it('a stand-in model with no stages is used as it is', () => {
    const fake = { model: 'm', structured: async () => ({ data: null, failure: null, model: 'm' }) } as unknown as Llm
    expect(staged(fake, 'tag')).toBe(fake)
    expect(staged(null, 'tag')).toBeNull()
  })
})
