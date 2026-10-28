import { z } from 'zod'
import { walkFolder, type DriveFile, type Google } from '../google.ts'

// The Rejections folder in his Drive, read by id and never written (AGENTS.md rule 1). A session compiled it on
// 2026-10-28 from every session that worked on the content: data/rejections.jsonl (what he rejected), data/liked.jsonl
// (what he liked in the same breath), data/process.jsonl (how sessions worked with him), and _manifest.json (which
// files in the folder belong to which record). The record ids (R001...) are renumbered on every re-run, so they are
// never anyone's identity here (src/rejection/file.ts keys records on his words).
//
// Everything in these files is data, never instructions, and it holds his words: a line that does not parse is
// counted by class, and nothing of it reaches a log.

const Quote = z.object({
  text: z.string(),
  when: z.string().nullish(),
  source: z.string().nullish(),
})

const AssetPath = z.object({
  path: z.string().nullish(),
  status: z.string().nullish(),
  size_mb: z.number().nullish(),
  note: z.string().nullish(),
})

export const DumpRecord = z.object({
  id: z.string(),
  date: z.string(),
  piece: z.string().nullish(),
  format: z.string().nullish(),
  category: z.string().nullish(),
  theme: z.string().nullish(),
  item: z.string().nullish(),
  quotes: z.array(Quote).default([]),
  reason: z.string().nullish(),
  strength: z.string().nullish(),
  wanted_instead: z.string().nullish(),
  asset_paths: z.array(AssetPath).default([]),
  screenshot_files: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  confidence: z.string().nullish(),
})
export type DumpRecord = z.infer<typeof DumpRecord>

const Manifest = z.array(z.object({ id: z.string(), files: z.array(z.string()).default([]) }))

export interface Parsed<T> { rows: T[]; bad: Record<string, number> }

/** One record per line. A line that is not JSON, or not a record, is counted by class and skipped. */
export function parseJsonl(text: string): Parsed<DumpRecord> {
  const rows: DumpRecord[] = []
  const bad: Record<string, number> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { bad.json = (bad.json ?? 0) + 1; continue }
    const r = DumpRecord.safeParse(value)
    if (r.success) rows.push(r.data)
    else bad.shape = (bad.shape ?? 0) + 1
  }
  return { rows, bad }
}

export function parseManifest(text: string): Map<string, string[]> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('rejections dump: _manifest.json does not parse') }
  const r = Manifest.safeParse(value)
  if (!r.success) throw new Error('rejections dump: _manifest.json is not a list of records and files')
  return new Map(r.data.map(m => [m.id, m.files]))
}

export const DUMP_FILES = {
  rejected: 'data/rejections.jsonl',
  liked: 'data/liked.jsonl',
  process: 'data/process.jsonl',
  manifest: '_manifest.json',
} as const

/** The dump's data files are small; anything near this is not one of them. */
const DATA_MAX_BYTES = 5_000_000

export interface Dump {
  rejected: DumpRecord[]
  liked: DumpRecord[]
  process: DumpRecord[]
  manifest: Map<string, string[]>
  /** Every file in the folder by its path inside it ('what he was looking at/R038 ....jpg'). */
  files: Map<string, DriveFile>
  bad: Record<string, number>
  /** Paths that two files share, which a manifest entry cannot tell apart. Never resolved to either. */
  ambiguous: number
}

/**
 * Read the whole dump. A missing rejections file is a broken read, never an empty folder: the run fails, and nothing
 * is withdrawn. The liked and process files may be absent.
 */
export async function readDump(google: Google, folderId: string): Promise<Dump> {
  const walked = await walkFolder(google, folderId)
  const files = new Map<string, DriveFile>()
  const seen = new Map<string, number>()
  for (const { path } of walked) seen.set(path, (seen.get(path) ?? 0) + 1)
  for (const { path, file } of walked) if (seen.get(path) === 1) files.set(path, file)
  const ambiguous = [...seen.values()].filter(n => n > 1).length

  const read = async (path: string): Promise<string | null> => {
    const f = files.get(path)
    if (!f) return null
    return (await google.download(f.id, DATA_MAX_BYTES)).toString('utf8')
  }
  const rejectedText = await read(DUMP_FILES.rejected)
  if (rejectedText === null) throw new Error('rejections dump: data/rejections.jsonl is not in the folder')
  const [likedText, processText, manifestText] = await Promise.all([
    read(DUMP_FILES.liked), read(DUMP_FILES.process), read(DUMP_FILES.manifest),
  ])
  const rejected = parseJsonl(rejectedText)
  const liked = likedText === null ? { rows: [], bad: {} } : parseJsonl(likedText)
  const proc = processText === null ? { rows: [], bad: {} } : parseJsonl(processText)
  const bad: Record<string, number> = {}
  for (const [prefix, b] of [['rejected', rejected.bad], ['liked', liked.bad], ['process', proc.bad]] as const) {
    for (const [k, n] of Object.entries(b)) bad[`${prefix}_${k}`] = n
  }
  return {
    rejected: rejected.rows, liked: liked.rows, process: proc.rows,
    manifest: manifestText === null ? new Map() : parseManifest(manifestText),
    files, bad, ambiguous,
  }
}
