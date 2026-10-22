import pg from 'pg'
import type { Config } from './config.ts'

export type Row = Record<string, unknown>

export interface Db {
  query<T = Row>(sql: string, params?: unknown[], opts?: { write?: boolean }): Promise<T[]>
  close(): Promise<void>
}

// Every write must say so. A dry run wraps the database in this guard, so a
// write that slips through is an error, never a quiet change to live data.
export class DryRunWriteRefused extends Error {}

export function readOnly(db: Db): Db {
  return {
    async query<T>(sql: string, params?: unknown[], opts?: { write?: boolean }) {
      if (opts?.write) throw new DryRunWriteRefused('dry run: refused a write')
      return db.query<T>(sql, params, { write: false })
    },
    close: () => db.close(),
  }
}

export async function connect(cfg: Config): Promise<Db> {
  if (cfg.DATABASE_URL) return pgDb(cfg.DATABASE_URL)
  return managementApiDb(cfg)
}

function pgDb(url: string): Db {
  // Fail in seconds, not minutes, when the host is unreachable.
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 })
  return {
    async query(sql, params = [], opts) {
      const client = await pool.connect()
      try {
        if (!opts?.write) {
          await client.query('begin read only')
          const res = await client.query(sql, params)
          await client.query('commit')
          return res.rows
        }
        const res = await client.query(sql, params)
        return res.rows
      } catch (err) {
        if (!opts?.write) await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

function managementApiDb(cfg: Config): Db {
  const url = `${cfg.SUPABASE_API_URL}/v1/projects/${cfg.SUPABASE_PROJECT_REF}/database/query`
  return {
    async query<T>(sql: string, params: unknown[] = [], opts?: { write?: boolean }) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${cfg.SUPABASE_ACCESS_TOKEN}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: sql, parameters: params, read_only: !opts?.write }),
      })
      const body: unknown = await res.json().catch(() => null)
      // Trust the body, not the status: an error can come back as an object.
      if (!res.ok || !Array.isArray(body)) {
        const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : `HTTP ${res.status}`
        throw new Error(`database query failed: ${message.slice(0, 300)}`)
      }
      return body as T[]
    },
    close: async () => {},
  }
}
