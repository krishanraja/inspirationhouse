import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { anthropicLlm } from '../src/llm.ts'
import { TagSchema } from '../src/tag/items.ts'
import type { Config } from '../src/config.ts'

// A stand-in for the model API on this machine: it streams back whatever answer the test sets, as the real API does.
let answer = ''
let stop = 'end_turn'
let server: Server
let lastBody: Record<string, unknown> = {}
let baseURL = ''
const savedBase = process.env.ANTHROPIC_BASE_URL

function sse(text: string, stopReason: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'served-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...[text.slice(0, 20), text.slice(20)].map(t => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev('message_stop', {}),
  ].join('')
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { lastBody = JSON.parse(body || '{}'); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(answer, stop)) })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.ANTHROPIC_BASE_URL = baseURL
})
afterAll(() => { server.close(); if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedBase })

const llm = () => anthropicLlm({ ANTHROPIC_API_KEY: 'test-key-not-real', TASTE_MODEL: 'asked-model' } as Config)
const card = (tags: number) => JSON.stringify({
  tags: Array.from({ length: tags }, (_, i) => ({ label: `subject ${i}`, kind: 'subject', layer: null })),
  predicted: { why_here: [], why_like: [], would_do: [] }, route: 'taste_only', kind: null, opinion: null, reason: null, piece_ref: null,
  facets: { platform: 'web', format: 'document', source: null, creator: null, people: [], organisations: [], topics: [] },
})
const ask = () => llm().structured({ schema: TagSchema, system: 's', content: [{ type: 'text', text: 'x' }] })

describe('anthropicLlm.structured', () => {
  it('keeps a card whose answer ran one tag over, and says it repaired it', async () => {
    answer = card(9); stop = 'end_turn'
    const out = await ask()
    expect(out.failure).toBeNull()
    expect(out.data!.tags).toHaveLength(8)
    expect(out.repairs).toBe(1)
    expect(out.model).toBe('served-model')
  })
  it('reads the stop reason before the words', async () => {
    answer = card(2).slice(0, 40); stop = 'max_tokens'
    expect((await ask()).failure).toBe('max_tokens')
    answer = 'I can not help with that.'; stop = 'refusal'
    expect((await ask()).failure).toBe('refusal')
  })
  it('fails an answer that is not the schema, without throwing', async () => {
    answer = 'not json at all'; stop = 'end_turn'
    expect((await ask())).toMatchObject({ data: null, failure: 'unparsed' })
    answer = JSON.stringify({ tags: [] }); stop = 'end_turn'
    expect((await ask())).toMatchObject({ data: null, failure: 'unparsed' })
  })
})

describe('anthropicLlm meters every call', () => {
  it('records the tokens of each call under its stage and the model that answered, used or not', async () => {
    const { Meter } = await import('../src/meter.ts')
    const meter = new Meter()
    const base = anthropicLlm({ ANTHROPIC_API_KEY: 'test-key-not-real', TASTE_MODEL: 'asked-model' } as Config, meter, 'daily')
    answer = card(2); stop = 'end_turn'
    await base.forStage!('tag').structured({ schema: TagSchema, system: 's', content: [{ type: 'text', text: 'x' }] })
    answer = 'refused'; stop = 'refusal'
    await base.forStage!('tag').structured({ schema: TagSchema, system: 's', content: [{ type: 'text', text: 'x' }] })
    const rows = meter.rows('2026-10-29')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ unit_key: 'inspirationhouse-tag', bucket: 'served-model', runs: 2, failed: 1, units: 12,
      category: 'unpriced-model', usd: 0 })
  })
})

describe('anthropicLlm caches the system prompt when asked', () => {
  it('marks the system prompt for the cache only for a stage that asks, and meters the cache reads', async () => {
    answer = card(2); stop = 'end_turn'
    await ask()
    expect(lastBody.system).toBe('s')
    await llm().structured({ schema: TagSchema, system: 's', content: [{ type: 'text', text: 'x' }], cache: true })
    expect(lastBody.system).toEqual([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }])
  })
})
