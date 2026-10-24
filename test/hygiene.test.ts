import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { safeFields } from '../src/log.ts'
import { GOOGLE_SCOPES } from '../src/config.ts'
import { readOnly, DryRunWriteRefused, type Db } from '../src/db.ts'
import { judgeRun } from '../src/runs.ts'

// This repository and its Actions logs are public. These are the guards that
// keep Krish's words out of both, and keep the engine from writing where it
// must not.

describe('public logs', () => {
  it('drops anything that could carry his words or a claim', () => {
    const out = safeFields({
      stage: 'collect', seen: 12, excerpt: 'something he said', statement: 'a claim', title: 'a title',
      krish: 'his words', why: 'a reason', reason: 'an error that quotes a row',
    })
    expect(out).toEqual({ stage: 'collect', seen: 12 })
  })

  it('keeps per-source counters, but only as numbers', () => {
    expect(safeFields({ seen_git_taste: 5, new_drive: 'leak' })).toEqual({ seen_git_taste: 5 })
  })

  it('keeps the linking counts, and never a link or his note', () => {
    expect(safeFields({ requests_linked: 2, slides_folded: 4, notes_kept: 1, waiting_for_reading: 1, url: 'https://example.org/p/1', note: 'his words' }))
      .toEqual({ requests_linked: 2, slides_folded: 4, notes_kept: 1, waiting_for_reading: 1 })
  })
})

describe('Drive stays read-only', () => {
  it('asks Google for read-only scopes and nothing else', () => {
    expect(GOOGLE_SCOPES.every(s => s.endsWith('.readonly'))).toBe(true)
  })

  it('names no write scope anywhere in the source', () => {
    const files: string[] = []
    const walk = (d: string) => readdirSync(d).forEach(f => {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    })
    walk('src')
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/auth\/drive(\.file)?['"\s]|auth\/spreadsheets['"\s]|auth\/drive\.appdata/)
    }
  })
})

describe('dry runs', () => {
  it('refuse any write', async () => {
    const calls: string[] = []
    const db: Db = { query: async (sql: string) => { calls.push(sql); return [] }, close: async () => {} }
    const ro = readOnly(db)
    await ro.query('select 1')
    await expect(ro.query('insert into x values (1)', [], { write: true })).rejects.toBeInstanceOf(DryRunWriteRefused)
    expect(calls).toEqual(['select 1'])
  })
})

describe('a green run that produced nothing', () => {
  it('is a failure when there was real input', () => {
    expect(judgeRun(12, 0).status).toBe('failed')
  })
  it('is a skip when there was no input', () => {
    expect(judgeRun(0, 0).status).toBe('skipped')
  })
  it('is fine when a small input honestly yields nothing', () => {
    expect(judgeRun(2, 0).status).toBe('ok')
  })
})
