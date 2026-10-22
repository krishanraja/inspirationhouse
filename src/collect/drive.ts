import { DRIVE } from '../config.ts'
import type { Evidence } from '../evidence.ts'
import type { DriveFile, Google } from '../google.ts'

// Dropping a file in a folder is his action: he liked it enough to keep it.
// What he liked about it comes later, in his own words, from Control Center's
// Inspiration page or the What I like sheet.
function fileEvidence(f: DriveFile, source: 'drive_cold' | 'drive_video', lane: 'strategy' | 'production'): Evidence {
  return {
    source, sourceRef: f.id, occurredAt: f.createdTime || f.modifiedTime,
    attribution: 'krish_action', polarity: 'likes', lane, layer: null,
    title: f.name, excerpt: null,
    meta: { mime: f.mimeType, modified: f.modifiedTime, bytes: f.size ? Number(f.size) : null },
  }
}

export async function collectDrive(google: Google): Promise<Evidence[]> {
  const [cold, video] = await Promise.all([
    google.listFolder(DRIVE.coldIdeas),
    google.listFolder(DRIVE.videoInspiration),
  ])
  const isFolder = (f: DriveFile) => f.mimeType === 'application/vnd.google-apps.folder'
  return [
    ...cold.filter(f => !isFolder(f)).map(f => fileEvidence(f, 'drive_cold', 'strategy')),
    // The sheet lives in the video folder but is not itself a reference.
    ...video.filter(f => !isFolder(f) && f.id !== DRIVE.whatILikeSheet).map(f => fileEvidence(f, 'drive_video', 'production')),
  ]
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
        layer: craft?.layer ?? null, title: video, excerpt: said, meta: { column: h },
      })
    })
  }
  return out
}
