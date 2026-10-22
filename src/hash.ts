import { createHash } from 'node:crypto'

// Stable JSON: object keys sorted at every depth, so the same content always
// hashes the same way whatever order a file or API returned it in.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function contentHash(value: unknown): string {
  const text = typeof value === 'string' ? value : stableJson(value)
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}
