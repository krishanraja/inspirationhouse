import { describe, it, expect } from 'vitest'
import { parseDatabaseUrl } from '../src/db.ts'

// Invented credentials only.
const POOLER = 'aws-1-us-west-2.pooler.supabase.com'

describe('reading DATABASE_URL', () => {
  it('reads the session pooler string', () => {
    expect(parseDatabaseUrl(`postgresql://postgres.abcdefghijklmnopqrst:s3cret@${POOLER}:5432/postgres`)).toEqual({
      user: 'postgres.abcdefghijklmnopqrst', password: 's3cret', host: POOLER, port: 5432, database: 'postgres',
    })
  })

  it('takes a password with raw symbols as typed, including @ [ ] # / ? and spaces', () => {
    const pw = 'a@b[c]d#e/f?g h^'
    expect(parseDatabaseUrl(`postgresql://postgres.x:${pw}@${POOLER}:5432/postgres`).password).toBe(pw)
  })

  it('decodes a percent-encoded password and drops template brackets', () => {
    expect(parseDatabaseUrl(`postgres://u:p%40ss%23@${POOLER}:6543/postgres`).password).toBe('p@ss#')
    expect(parseDatabaseUrl(`postgres://u:[plain]@${POOLER}:5432/postgres`).password).toBe('plain')
  })

  it('turns on TLS when the string asks for it, and refuses what is not a Postgres URL', () => {
    expect(parseDatabaseUrl(`postgres://u:p@${POOLER}:5432/postgres?sslmode=require`).ssl).toEqual({ rejectUnauthorized: false })
    expect(() => parseDatabaseUrl('https://gojpffsrxybbpbdzzrvs.supabase.co')).toThrow(/not a postgresql/)
  })
})
