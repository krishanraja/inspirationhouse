import { DRIVE } from '../config.ts'
import type { Evidence } from '../evidence.ts'
import { walkFolder, type DriveFile, type Google } from '../google.ts'
import { SOURCE_VENTURE, folderVenture, type Venture } from '../venture.ts'

// Dropping a file in a folder is his action: he liked it enough to keep it.
// What he liked about it comes later, in his own words, from Control Center's
// Inspiration page or the What I like sheet.
// A file is the venture of the folder it was dropped in (src/venture.ts).
function fileEvidence(f: DriveFile, source: 'drive_cold' | 'drive_video', lane: 'strategy' | 'production', venture: Venture): Evidence {
  return {
    source, sourceRef: f.id, occurredAt: f.createdTime || f.modifiedTime,
    attribution: 'krish_action', polarity: 'likes', lane, layer: null,
    title: f.name, excerpt: null,
    meta: { mime: f.mimeType, modified: f.modifiedTime, bytes: f.size ? Number(f.size) : null },
    venture,
  }
}

export interface TreeFile { f: DriveFile; folder: 'cold_ideas' | 'video_inspiration'; lane: 'strategy' | 'production'; path: string }

export interface Tree {
  files: TreeFile[]; machine: number; duplicates: number
  /** Files a tool wrote beside what he saved (a checksum, a log, a collection's JSON): never a card (machineFile). */
  machineFiles: number
}

/**
 * The subfolder a file sits in below the top of its Inspo folder, by folder names only, or null for a loose drop.
 * A subfolder is a collection: a reference set he filed together (Krish, 2026-11-17, on a thumbnail study: "more for
 * inspiration on how to create thumbnails for short videos rather than inspiration on what content to make"), read
 * after the cards that carry his words and his loose drops (src/tag/items.ts, TAG_ORDER).
 */
export function collectionOf(path: string): { name: string; path: string } | null {
  const parts = path.split('/')
  if (parts.length < 2) return null
  const dir = parts.slice(0, -1)
  return { name: dir[dir.length - 1]!, path: dir.join('/') }
}

/**
 * A file a tool wrote, not one he saved: a checksum (`.sha256`), a log (`.log`), or a `.json` inside a collection
 * (cleanup-log.json, verification.json and the like beside a study's images). A loose `.json` he dropped at the top
 * stays a card.
 */
export function machineFile(name: string, inCollection: boolean): boolean {
  return /\.(sha256|log)$/i.test(name) || (inCollection && /\.json$/i.test(name))
}

/**
 * His Inspiration tree (Wave 3, W3.2): every file under Content Inspo and Production Inspo, however deep he filed it,
 * each under the folder at the top of its branch. What is never his input is left out:
 *   - the What I like sheet, read as a sheet (it moved to Content Inspo on 2026-10-24);
 *   - a machine still: bytes content-watcher curated from a reading (src/tag/understand.ts, machineStillShas), wherever
 *     a copy turns up, since a machine signal never counts as his;
 *   - a second copy of the same bytes (Drive's sha256): the oldest file is the card, so one thing he saved is counted once;
 *   - a file a tool wrote beside what he saved (machineFile).
 */
export async function inspirationTree(google: Pick<Google, 'listFolder'>, machine: ReadonlySet<string> = new Set()): Promise<Tree> {
  const [cold, video] = await Promise.all([walkFolder(google, DRIVE.coldIdeas, { maxDepth: 4 }), walkFolder(google, DRIVE.videoInspiration, { maxDepth: 4 })])
  const all: TreeFile[] = [
    ...cold.map(({ path, file }) => ({ f: file, folder: 'cold_ideas' as const, lane: 'strategy' as const, path })),
    ...video.map(({ path, file }) => ({ f: file, folder: 'video_inspiration' as const, lane: 'production' as const, path })),
  ].filter(t => t.f.id !== DRIVE.whatILikeSheet)
  const machineFiles = all.filter(t => machineFile(t.f.name, collectionOf(t.path) !== null)).length
  const own = all.filter(t => !machineFile(t.f.name, collectionOf(t.path) !== null))
  const out: TreeFile[] = []
  const seen = new Set<string>()
  let machineN = 0
  let duplicates = 0
  // Oldest first, so the card a copy folds into is the one he saved first.
  for (const t of [...own].sort((a, b) => (a.f.createdTime || '').localeCompare(b.f.createdTime || '') || a.f.id.localeCompare(b.f.id))) {
    const sha = t.f.sha256Checksum?.toLowerCase()
    if (sha && machine.has(sha)) { machineN++; continue }
    if (sha && seen.has(sha)) { duplicates++; continue }
    if (sha) seen.add(sha)
    out.push(t)
  }
  return { files: out, machine: machineN, duplicates, machineFiles }
}

export async function collectDrive(google: Google, machine: ReadonlySet<string> = new Set()): Promise<Evidence[]> {
  const tree = await inspirationTree(google, machine)
  const [coldVenture, videoVenture] = [folderVenture(DRIVE.coldIdeas), folderVenture(DRIVE.videoInspiration)]
  return tree.files.map(t => t.folder === 'cold_ideas'
    ? fileEvidence(t.f, 'drive_cold', 'strategy', coldVenture)
    : fileEvidence(t.f, 'drive_video', 'production', videoVenture))
}

// The What I like sheet: one row per video, one column per craft he rates.
const CRAFT_COLUMNS: Array<{ header: RegExp; layer: string }> = [
  { header: /^narrative/i, layer: 'structure' },
  { header: /^editing/i, layer: 'editing' },
  { header: /^camerawork/i, layer: 'camerawork' },
  { header: /^zoom/i, layer: 'camerawork' },
  { header: /^breakdown/i, layer: 'breakdown' },
  { header: /^tone/i, layer: 'tone' },
  { header: /^production/i, layer: 'production' },
]

export function sheetEvidence(rows: string[][], now: string): Evidence[] {
  const [header, ...body] = rows
  if (!header) return []
  const notCopy = header.findIndex(h => /would not copy/i.test(h))
  const dateCol = header.findIndex(h => /^date/i.test(h))
  const out: Evidence[] = []
  for (const row of body) {
    const video = row[0]?.trim()
    if (!video) continue
    const at = row[dateCol]?.trim() ? new Date(`${row[dateCol]!.trim()}T12:00:00Z`).toISOString() : now
    header.forEach((h, i) => {
      const said = row[i]?.trim()
      if (!said || i === 0 || i === dateCol) return
      const craft = CRAFT_COLUMNS.find(c => c.header.test(h))
      if (!craft && i !== notCopy) return
      out.push({
        source: 'what_i_like_sheet', sourceRef: `${video}#${h}`.slice(0, 300), occurredAt: at,
        attribution: 'krish_words', polarity: i === notCopy ? 'dislikes' : 'likes', lane: 'production',
        layer: craft?.layer ?? null, title: video, excerpt: said, meta: { column: h }, venture: SOURCE_VENTURE.what_i_like_sheet,
      })
    })
  }
  return out
}
