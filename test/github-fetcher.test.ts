import { describe, it, expect, vi, afterEach } from 'vitest'
import { githubFetcher } from '../src/collect/gitTaste.ts'

// 16 Nov: the floor held for a day because content-engine's rulings could not be read. content-engine is public, so a
// token that has gone stale must never stop a read that needs no token.
const cfg = { CONTENT_ENGINE_REPO: 'owner/repo', CONTENT_ENGINE_REF: 'main', CONTENT_ENGINE_READ_TOKEN: 'stale' } as never

afterEach(() => vi.unstubAllGlobals())

describe('githubFetcher', () => {
  it('reads once more without the token when the token is refused', async () => {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers)
      return init.headers.authorization
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ records: {} }), { status: 200 })
    })
    await expect(githubFetcher(cfg)('config/floor-rulings.json')).resolves.toEqual({ records: {} })
    expect(calls.map(h => Boolean(h.authorization))).toEqual([true, false])
  })

  it('keeps the status on the error when the file cannot be read either way', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    await expect(githubFetcher(cfg)('x.json')).rejects.toMatchObject({ status: 404 })
  })
})
