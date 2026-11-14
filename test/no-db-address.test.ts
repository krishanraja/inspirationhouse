import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The main database's project address stays out of this public repository (Krish canon, Secrets; fleet audit I-01,
// 2026-11-14). Its ref is held here only as a sha256, so the test names no value. src/config.ts keeps it as the
// default for SUPABASE_PROJECT_REF because no workflow supplies that variable yet; it is the one place allowed.
const DB_REF_SHA256 = 'ed7e78e5a43de7e1448c2922d7ce87a52daf11a625da0360ce507b439b4b8bf0'
const ALLOWED = new Set(['src/config.ts'])
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('no database address in tracked files', () => {
  it('holds the address only in the one config default', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    const holders: string[] = []
    for (const file of files) {
      if (ALLOWED.has(file) || /\.(png|jpe?g|gif|webp|mp4|zip|pdf)$/i.test(file)) continue
      let body = ''
      try { body = readFileSync(file, 'utf8') } catch { continue }
      for (const m of body.matchAll(/\b[a-z]{20}\b/g)) if (sha256(m[0]) === DB_REF_SHA256) { holders.push(file); break }
    }
    expect(holders).toEqual([])
  })
})
