import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TAG_BUDGET_MS } from '../src/tag/items.ts'
import { WATCH_WORST_MS } from '../src/tag/watch.ts'

// A job that GitHub cancels at its timeout records no run at all, so Control Center sees nothing. The tagging budget
// has to leave room inside the timeout for the card started just before it ran out, and for explaining after it.
describe('the daily job has time to finish', () => {
  const timeoutMs = Number(/timeout-minutes:\s*(\d+)/.exec(readFileSync('.github/workflows/taste-daily.yml', 'utf8'))![1]) * 60_000

  it('stops starting cards after about twelve minutes, in a job allowed an hour', () => {
    expect(TAG_BUDGET_MS).toBe(12 * 60_000)
    expect(timeoutMs).toBe(60 * 60_000)
  })

  it('leaves room for one more whole watch and half an hour of everything else', () => {
    expect(TAG_BUDGET_MS + WATCH_WORST_MS + 30 * 60_000).toBeLessThanOrEqual(timeoutMs)
  })
})
