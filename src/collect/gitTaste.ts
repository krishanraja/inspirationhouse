import type { Config } from '../config.ts'
import type { Evidence } from '../evidence.ts'
import { contentHash } from '../hash.ts'
import { SOURCE_VENTURE } from '../venture.ts'

// The taste files content-engine keeps in git. They are where Krish's live
// feedback lands (written in Claude Code sessions with his words), so they are
// the primary input. Read only; this engine never edits them.
export const TASTE_FILES = {
  learnings: 'config/learnings.json',
  titleVerdicts: 'config/title-verdicts.json',
  golden: 'config/golden-examples.json',
  rejected: 'config/rejected-lines.json',
  style: 'config/style-references.json',
} as const

export type FetchJson = (path: string) => Promise<unknown>

export function githubFetcher(cfg: Config): FetchJson {
  return async (path: string) => {
    const headers: Record<string, string> = { accept: 'application/vnd.github.raw+json', 'user-agent': 'inspirationhouse' }
    if (cfg.CONTENT_ENGINE_READ_TOKEN) headers.authorization = `Bearer ${cfg.CONTENT_ENGINE_READ_TOKEN}`
    const url = `https://api.github.com/repos/${cfg.CONTENT_ENGINE_REPO}/contents/${path}?ref=${encodeURIComponent(cfg.CONTENT_ENGINE_REF)}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`github read failed for ${path}: HTTP ${res.status}`)
    return res.json()
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown, key: string): Obj[] => {
  const arr = isObj(v) ? v[key] : v
  return Array.isArray(arr) ? arr.filter(isObj) : []
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export async function collectGitTaste(fetchJson: FetchJson, now = new Date().toISOString()): Promise<Evidence[]> {
  const [learnings, titles, golden, rejected, style] = await Promise.all([
    fetchJson(TASTE_FILES.learnings),
    fetchJson(TASTE_FILES.titleVerdicts),
    fetchJson(TASTE_FILES.golden),
    fetchJson(TASTE_FILES.rejected),
    fetchJson(TASTE_FILES.style),
  ])
  const out: Evidence[] = []

  // A learning is something he corrected, in his words, with the rule it set.
  for (const l of list(learnings, 'learnings')) {
    const krish = str(l.krish)
    if (!krish || !str(l.id)) continue
    out.push({
      source: 'learnings_json', sourceRef: String(l.id), occurredAt: isoDate(l.on, now),
      attribution: 'krish_words', polarity: 'dislikes', lane: 'voice', layer: null,
      title: str(l.means), excerpt: krish, meta: { why: str(l.why), means: str(l.means), status: str(l.status) },
      venture: SOURCE_VENTURE.learnings_json,
    })
  }

  // A title he picked or rejected, with what he said about it.
  for (const v of list(titles, 'verdicts')) {
    const title = str(v.title)
    const verdict = str(v.verdict)
    if (!title || (verdict !== 'picked' && verdict !== 'rejected')) continue
    const krish = str(v.krish)
    out.push({
      source: 'title_verdicts', sourceRef: `${str(v.on) ?? 'undated'}:${contentHash(title).slice(0, 16)}`,
      occurredAt: isoDate(v.on, now),
      attribution: krish ? 'krish_words' : 'krish_action',
      polarity: verdict === 'picked' ? 'likes' : 'dislikes', lane: 'voice', layer: 'packaging',
      title, excerpt: krish, meta: { why: str(v.why), surface: str(v.surface), piece: str(v.piece) },
      venture: SOURCE_VENTURE.title_verdicts,
    })
  }

  // A line of his own he holds up as the standard.
  for (const g of list(golden, 'examples')) {
    const said = str(g.said)
    const text = str(g.text)
    if (!said && !text) continue
    out.push({
      source: 'golden_examples', sourceRef: contentHash(text ?? said).slice(0, 16), occurredAt: isoDate(g.on, now),
      attribution: said ? 'krish_words' : 'krish_action', polarity: 'likes', lane: 'voice', layer: null,
      title: str(g.kind), excerpt: said ?? text, meta: { text, why: str(g.why) },
      venture: SOURCE_VENTURE.golden_examples,
    })
  }

  // A pattern he never wants to read again, and what to say instead.
  for (const r of list(rejected, 'rejected')) {
    const pattern = str(r.pattern)
    if (!pattern) continue
    out.push({
      source: 'rejected_lines', sourceRef: contentHash(pattern).slice(0, 16), occurredAt: isoDate(r.on, now),
      attribution: str(r.said) ? 'krish_words' : 'krish_action', polarity: 'dislikes', lane: 'voice', layer: null,
      title: pattern, excerpt: str(r.said), meta: { instead: str(r.instead) },
      venture: SOURCE_VENTURE.rejected_lines,
    })
  }

  // Videos he saved for their production quality, with his words where he gave them.
  for (const ref of list(style, 'references')) {
    const file = str(ref.file)
    if (!file) continue
    const likes = str(ref.krish_likes)
    out.push({
      source: 'style_references', sourceRef: str(ref.drive_id) ?? contentHash(file).slice(0, 16), occurredAt: isoDate(ref.added, now),
      attribution: likes ? 'krish_words' : 'krish_action', polarity: 'likes', lane: 'production', layer: null,
      title: file, excerpt: likes, meta: { status: str(ref.status), modules: Array.isArray(ref.modules) ? ref.modules : [] },
      venture: SOURCE_VENTURE.style_references,
    })
  }

  // A technique module only counts once he has given it a verdict.
  for (const m of list(style, 'bank')) {
    const verdict = str(m.krish_verdict)
    if (verdict !== 'liked' && verdict !== 'not for us') continue
    out.push({
      source: 'style_bank', sourceRef: String(m.id), occurredAt: now,
      attribution: 'krish_action', polarity: verdict === 'liked' ? 'likes' : 'dislikes', lane: 'production',
      layer: str(m.layer), title: str(m.name), excerpt: null, meta: { how: str(m.how), fits: str(m.fits) },
      venture: SOURCE_VENTURE.style_bank,
    })
  }

  return out
}

function isoDate(value: unknown, fallback: string): string {
  const s = str(value)
  if (!s) return fallback
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s)
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString()
}
