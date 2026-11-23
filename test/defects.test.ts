import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db.ts'
import { classOfRecord, classOfStandard, hasDefectWords, moveDefects, stageOfFormats } from '../src/rejection/defects.ts'

const record = (over: Partial<Parameters<typeof classOfRecord>[0]> = {}) =>
  ({ kind: 'rejected', theme: 'layout', rule_kind: 'form', item: 'synthetic item', words: 'synthetic words', ...over })

describe('what is a defect and what is a preference', () => {
  it('a process record, a workflow rule and an A/V fault are defects', () => {
    expect(classOfRecord(record({ kind: 'process', theme: 'process', rule_kind: 'workflow' }))).toBe('defect')
    expect(classOfRecord(record({ rule_kind: 'workflow' }))).toBe('defect')
    expect(classOfRecord(record({ theme: 'edit_av' }))).toBe('defect')
  })

  it('a fault named in a craft theme is a defect, and a liked record never is', () => {
    expect(classOfRecord(record({ item: 'synthetic: the title is falling off the page' }))).toBe('defect')
    expect(classOfRecord(record({ kind: 'liked', theme: 'liked', item: 'synthetic: nothing is cut off here' }))).toBe('preference')
  })

  it('a preference theme stays taste even when it uses a fault word', () => {
    expect(classOfRecord(record({ theme: 'voice_tone', item: 'synthetic: short clipped words read as broken' }))).toBe('preference')
    expect(classOfStandard({ kind: 'form', theme: 'clipart_generic', statement: 'Never use broken-looking clipart' })).toBe('preference')
  })

  it('an edit he calls boring is his taste, even under edit and A/V', () => {
    expect(classOfStandard({ kind: 'form', theme: 'edit_av', statement: 'Never deliver a visually boring cut; always make it entertaining' })).toBe('preference')
    expect(classOfStandard({ kind: 'form', theme: 'edit_av', statement: 'Never let picture and voice drift out of sync' })).toBe('defect')
    expect(classOfRecord(record({ theme: 'edit_av', item: 'synthetic: a boring cut with one bad join' }))).toBe('mixed')
  })

  it('an unsorted record naming a fault is mixed: logged, and kept in taste', () => {
    expect(classOfRecord(record({ theme: 'other', item: null, words: 'synthetic: boring, and the logos overlap' }))).toBe('mixed')
    expect(classOfRecord(record({ theme: 'other', item: null, words: 'synthetic: it feels boring' }))).toBe('preference')
  })

  it('reads standards and fault words by fixed rules', () => {
    expect(classOfStandard({ kind: 'workflow', theme: 'structure', statement: 'Always ask once' })).toBe('defect')
    expect(classOfStandard({ kind: 'form', theme: 'layout', statement: 'Never let text overlap on screen' })).toBe('defect')
    expect(classOfStandard({ kind: 'form', theme: 'brand', statement: 'Always feel premium' })).toBe('preference')
    expect(hasDefectWords('the audio is too quiet')).toBe(true)
    expect(hasDefectWords('the audio is terrible')).toBe(false)
    expect(stageOfFormats(['session'], 'process')).toBe('session')
    expect(stageOfFormats(['short_video'], 'rejected')).toBe('cut')
    expect(stageOfFormats(['cover'], 'rejected')).toBe('package')
  })
})

function fakeDb() {
  const writes: string[] = []
  const db: Db = {
    async query<T>(sql: string, _params?: unknown[], opts?: { write?: boolean }) {
      if (opts?.write) { writes.push(sql); return (/insert into public\.engine_incidents/.test(sql) ? [{ id: 'i1' }, { id: 'i2' }] : []) as T[] }
      if (/from public\.taste_floor where/.test(sql)) return [{ id: 's1', fingerprint: 'a'.repeat(16), kind: 'workflow', theme: 'process', statement: 'Always ask once' },
        { id: 's2', fingerprint: 'b'.repeat(16), kind: 'form', theme: 'voice_tone', statement: 'Sound human' }] as T[]
      if (/from public\.taste_rejections r/.test(sql)) return [
        { id: 'r1', kind: 'process', theme: 'process', rule_kind: 'workflow', item: 'synthetic', piece: null, formats: ['session'], rejected_at: '2026-11-01', source: 'drive_dump', words: 'synthetic' },
        { id: 'r2', kind: 'rejected', theme: 'other', rule_kind: 'form', item: null, piece: null, formats: ['card'], rejected_at: '2026-11-02', source: 'drive_dump', words: 'boring and the logos overlap' },
        { id: 'r3', kind: 'rejected', theme: 'other', rule_kind: 'form', item: null, piece: null, formats: ['card'], rejected_at: '2026-11-03', source: 'drive_dump', words: 'boring' },
      ] as T[]
      if (/from public\.taste_evidence/.test(sql)) return [{ id: 'e1', title: 'Words fall off the page', excerpt: 'x' }, { id: 'e2', title: 'Sound human', excerpt: 'x' }] as T[]
      return [] as T[]
    },
    close: async () => {},
  }
  return { db, writes }
}

describe('moving defects out', () => {
  it('a dry run counts and writes nothing', async () => {
    const { db, writes } = fakeDb()
    const r = await moveDefects(db, false)
    expect(r).toMatchObject({ records_read: 3, records_moved: 1, records_mixed: 1, standards_moved: 1, learnings_withdrawn: 1, incidents_filed: 0 })
    expect(writes).toEqual([])
  })

  it('copies first and marks after: a standard to the engine, an incident for each defect and mixed record, then the taste row', async () => {
    const { db, writes } = fakeDb()
    const r = await moveDefects(db, true)
    expect(r.incidents_filed).toBe(2)
    const at = (re: RegExp) => writes.findIndex(w => re.test(w))
    expect(at(/insert into public\.engine_standards/)).toBeLessThan(at(/update public\.taste_floor_standards/))
    expect(at(/insert into public\.engine_incidents/)).toBeLessThan(at(/update public\.taste_rejections/))
    expect(writes.join('\n')).not.toMatch(/\bdelete\b/i)
    expect(writes.find(w => /update public\.taste_rejections/.test(w))).toMatch(/exists \(select 1 from public\.engine_incidents/)
  })
})
