// This repository is public, and so are its Actions logs. A log line carries
// counts, ids, stage names and error classes, never Krish's words or what a
// claim says. The allowlist is the rule; anything else is dropped.
const ALLOWED = new Set([
  'stage', 'source', 'job', 'status', 'run_id', 'dry_run',
  'seen', 'written', 'skipped', 'failed', 'items', 'whys', 'claims',
  'proposed', 'eligible', 'synced', 'metrics', 'week', 'ms', 'error_class',
  'drafted', 'resolved', 'retired', 'code', 'hint',
  // Linking the links he pasted to their cards, and the cards job (src/tag/links.ts).
  'requests_linked', 'slides_folded', 'notes_kept', 'waiting_for_reading',
])

export function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    // Per-source and per-stage counters are numbers, so they are safe by shape.
    const counter = /^(seen|new|items|explain|distil|score|evidence)_[a-z_]+$/.test(k) && typeof v === 'number'
    if (!ALLOWED.has(k) && !counter) continue
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.length <= 80 ? v : `${v.slice(0, 77)}...`
  }
  return out
}

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(safeFields(fields)))
}
