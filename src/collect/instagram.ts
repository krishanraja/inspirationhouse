import { DRIVE } from '../config.ts'
import { clip, type Evidence } from '../evidence.ts'
import type { Google } from '../google.ts'
import { readXlsx } from '../xlsx.ts'

// The Instagram workbook in Cold Ideas ("Instagram inspo.xlsx"): the posts of
// the accounts Krish follows for strategy, captured one row per post, and a
// tab of themes written from them.
//
// Keeping the workbook is his action, and the file itself is already counted
// by collectDrive. The rows inside it are other people's posts and a written
// synthesis of them, so they are context, never proof: a post is an
// `observation`, a theme a `machine_inference`. Neither counts toward a claim.
//
// Each row is keyed by its post id (or theme name), so a refresh that adds
// posts writes only the new ones, and an edited row becomes a new version.

export type Sheet = string[][]

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

// The header row is the first row naming every column we read; title and
// note rows above it are skipped.
function table(rows: Sheet, need: string[]): { col: (name: string) => number; body: Sheet } | null {
  const at = rows.findIndex(r => need.every(n => r.some(c => norm(c) === n)))
  if (at < 0) return null
  const header = rows[at]!.map(norm)
  return { col: name => header.indexOf(name), body: rows.slice(at + 1) }
}

// "2026-10-13 21:32", in UTC as the column says.
function utc(s: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s ?? '').trim())
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}:00Z`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function postEvidence(rows: Sheet, fileAt: string): Evidence[] {
  const t = table(rows, ['post id', 'headline', 'post url'])
  if (!t) return []
  const get = (r: string[], name: string) => {
    const i = t.col(name)
    return i >= 0 ? String(r[i] ?? '').trim() : ''
  }
  const out: Evidence[] = []
  for (const r of t.body) {
    const id = get(r, 'post id')
    if (!/^[\w-]{5,40}$/.test(id)) continue
    out.push({
      source: 'drive_cold', sourceRef: `instagram:${id}`,
      occurredAt: utc(get(r, 'published (utc)')) ?? fileAt,
      attribution: 'observation', polarity: 'neutral', lane: 'strategy', layer: null,
      title: clip(get(r, 'headline'), 300),
      excerpt: clip(get(r, 'faithful summary') || get(r, 'future-of-ai claims'), 400),
      meta: {
        kind: 'instagram_post',
        account: get(r, 'account') || null,
        type: get(r, 'type') || null,
        url: get(r, 'post url') || null,
        horizon: clip(get(r, 'time horizon'), 120),
        capture: clip(get(r, 'capture status'), 120),
        file: DRIVE.instagramInspo,
      },
    })
  }
  return out
}

export function themeEvidence(rows: Sheet, fileAt: string): Evidence[] {
  const t = table(rows, ['theme', 'what they are saying', 'direction'])
  if (!t) return []
  const get = (r: string[], name: string) => {
    const i = t.col(name)
    return i >= 0 ? String(r[i] ?? '').trim() : ''
  }
  const out: Evidence[] = []
  for (const r of t.body) {
    const theme = get(r, 'theme')
    if (!theme || theme.length > 120) continue
    out.push({
      source: 'drive_cold', sourceRef: `instagram-theme:${theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 300),
      occurredAt: fileAt,
      attribution: 'machine_inference', polarity: 'neutral', lane: 'strategy', layer: null,
      title: clip(theme, 300),
      excerpt: clip(get(r, 'direction') || get(r, 'what they are saying'), 400),
      meta: { kind: 'instagram_theme', caveat: clip(get(r, 'evidence caveat'), 300), file: DRIVE.instagramInspo },
    })
  }
  return out
}

// Every tab as rows of text, the way a sheet reads.
export function workbookRows(bytes: Uint8Array): Sheet[] {
  return readXlsx(bytes).map(t => t.rows)
}

export async function collectInstagram(google: Google, now: string): Promise<Evidence[]> {
  const tabs = workbookRows(await google.download(DRIVE.instagramInspo))
  return tabs.flatMap(rows => [...postEvidence(rows, now), ...themeEvidence(rows, now)])
}
