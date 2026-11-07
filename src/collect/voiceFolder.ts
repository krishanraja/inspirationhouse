import { z } from 'zod'
import { DRIVE } from '../config.ts'
import { clip, type Evidence } from '../evidence.ts'
import { walkFolder, type DriveFile, type Google } from '../google.ts'
import type { Llm } from '../llm.ts'
import { folderVenture } from '../venture.ts'

// His voice folder (Krish, 2026-11-07): "the new place that I put anyone whose voice I find inspiring". Each file is
// usually a screenshot of a LinkedIn post. Dropping it there is his action, in the voice lane: how the words are
// written, never what they are about.
//
// The screenshot is transcribed once, never interpreted here: the writer's name, their headline and the post's words
// as the image shows them, so the whys stage reads what he saved rather than a file name. A transcription is data; what
// he liked about it is left to the later stages and, above all, to his own words. A file already in the ledger is not
// read again, so a run spends nothing on what it has seen.

export const VOICE_REF = 'voice:'
const MAX_PER_RUN = 20

const Read = z.object({
  writer: z.string().max(120).nullable(),
  headline: z.string().max(200).nullable(),
  post_text: z.string().max(1800).nullable(),
})

const SYSTEM = [
  'You transcribe a screenshot Krish saved of a social post, usually LinkedIn, because he admires how the writer writes.',
  'Return the writer\'s name, their headline, and the post\'s own words exactly as the image shows them, in order, line breaks kept as new lines.',
  'Leave out the app\'s chrome (times, counts, buttons, other people\'s comments). If the screenshot holds more than one post, transcribe the first whole one.',
  'Transcribe only: no summary, no opinion, nothing the image does not show. Null for anything you cannot read.',
].join(' ')

export interface VoiceFolderDeps {
  /** The source_refs already in the ledger, so a file is transcribed once. */
  known?: ReadonlySet<string>
  llm?: Llm | null
}

function voiceEvidence(f: DriveFile, read: z.infer<typeof Read> | null, model: string | null): Evidence {
  const writer = read?.writer?.trim() || null
  const firstLine = read?.post_text?.split('\n').map(s => s.trim()).find(Boolean) ?? null
  return {
    source: 'drive_cold', sourceRef: `${VOICE_REF}${f.id}`, occurredAt: f.createdTime || f.modifiedTime,
    attribution: 'krish_action', polarity: 'likes', lane: 'voice', layer: null,
    title: clip(writer ? `${writer}${firstLine ? `: ${firstLine}` : ''}` : f.name, 300),
    excerpt: clip(read?.post_text ?? null, 1800),
    meta: {
      folder: 'voice_inspiration', mime: f.mimeType, file: f.name, writer, headline: read?.headline ?? null,
      transcribed_by: read ? model : null,
    },
    venture: folderVenture(DRIVE.voiceInspiration),
  }
}

/** Every file in his voice folder not yet in the ledger, transcribed when it is an image and a model is at hand. */
export async function collectVoiceFolder(google: Pick<Google, 'listFolder' | 'thumbnail'>, deps: VoiceFolderDeps = {}): Promise<Evidence[]> {
  const files = (await walkFolder(google, DRIVE.voiceInspiration, { maxDepth: 2 })).map(x => x.file)
  const fresh = files.filter(f => !deps.known?.has(`${VOICE_REF}${f.id}`)).slice(0, MAX_PER_RUN)
  const out: Evidence[] = []
  for (const f of fresh) {
    let read: z.infer<typeof Read> | null = null
    let model: string | null = null
    if (deps.llm && f.mimeType.startsWith('image/')) {
      const img = await google.thumbnail(f, 1600).catch(() => null)
      if (img) {
        const r = await deps.llm.structured({
          schema: Read, system: SYSTEM, maxTokens: 2000,
          content: [
            { type: 'image', source: { type: 'base64', media_type: img.mime as 'image/jpeg' | 'image/png' | 'image/webp', data: img.bytes.toString('base64') } },
            { type: 'text', text: 'Transcribe this saved post.' },
          ],
        }).catch(() => null)
        if (r?.data) { read = r.data; model = r.model }
      }
    }
    out.push(voiceEvidence(f, read, model))
  }
  return out
}
