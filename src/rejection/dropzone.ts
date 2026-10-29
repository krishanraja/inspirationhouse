import { contentHash } from '../hash.ts'
import { FOLDER_MIME, walkFolder, type Authorship, type DriveFile, type Google } from '../google.ts'
import { clip } from '../evidence.ts'
import { folderVenture } from '../venture.ts'
import { DRIVE } from '../config.ts'
import { quoteKey, type Capture, type QuoteRow, type RecordRow } from './file.ts'
import { RULES_REV, craftNamed, formatsOf } from './vocab.ts'

// The drop zone: Rejections/Inbox/ in his Drive (Wave 2, W2.10). Anyone working for him can drop a rejection there: he
// can, and so can a Codex session on his computer, which runs no hooks and has no other door (W3.3), through Drive for
// desktop. So a file counts as his words only when it is provably his typing:
//
//   - a Google Doc (typed in Docs; Drive for desktop syncs files but cannot make one, and Codex holds no Google tools),
//   - owned by the account that owns the Rejections folder, and last changed by it,
//   - with every revision Drive lists made by that account. Where Drive will not list the revisions to the engine,
//     nothing proves it, so the file is not his words.
//
// Anything else is an observation: a machine's note, a text or Markdown file, a screenshot or a clip, or a Doc someone
// else touched. It is kept as context with its still, strip or pointer, and never counts toward a standard (only
// krish_words and krish_action do, src/rejection/distil.ts), so a session's note is never filed as what he said.
//
// Each file is filed once by its Drive id (source 'inbox', source_ref drop:<id>); a Doc he edits is a new version of the
// same record. The zone is never written and never emptied by the engine (AGENTS.md rule 1), and it is never read whole:
// a file that leaves it withdraws nothing, as a capture in the inbox table never does.

export const DROP_FOLDER = 'Inbox'
const DOC_MIME = 'application/vnd.google-apps.document'
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv'])
/** His words are kept whole (AGENTS.md rule 9), up to what a quote holds. */
export const DROP_WORDS_MAX = 20_000
/** At most this many files are read a run: a zone that fills faster is read over several runs, oldest first. */
export const DROP_PER_RUN = 100

export type Proof = 'his_typing' | 'not_a_doc' | 'not_his_account' | 'touched_by_another' | 'revisions_unlisted' | 'no_owner'

export interface DropFile { path: string; file: DriveFile; proof: Proof; text: string | null }

/** Whether a file is provably his typing, from its type and who made it. Pure. */
export function proofOf(file: DriveFile, a: Authorship | null, owner: string | null): Proof {
  if (file.mimeType !== DOC_MIME) return 'not_a_doc'
  if (!owner) return 'no_owner'
  if (!a || a.owners.length !== 1 || a.owners[0] !== owner) return 'not_his_account'
  if (a.lastModifier !== owner) return 'touched_by_another'
  if (a.revisionAuthors === null || !a.revisionAuthors.length) return 'revisions_unlisted'
  if (a.revisionAuthors.some(p => p !== owner)) return 'touched_by_another'
  return 'his_typing'
}

/**
 * Every file in the zone, oldest first, with its proof and its text. A zone that is not there reads as empty: he may not
 * have made it yet. The Rejections folder's owner is whoever owns it in Drive, read each run, never written here.
 */
export async function readDropZone(google: Google, rejectionsId: string = DRIVE.rejections): Promise<{ files: DropFile[]; more: number; owner: boolean }> {
  const inbox = (await google.listFolder(rejectionsId)).find(f => f.mimeType === FOLDER_MIME && f.name === DROP_FOLDER)
  if (!inbox) return { files: [], more: 0, owner: false }
  const folder = google.authorship ? await google.authorship(rejectionsId) : null
  const owner = folder && folder.owners.length === 1 ? folder.owners[0]! : null
  const walked = (await walkFolder(google, inbox.id, { maxDepth: 2, maxFiles: 2000 }))
    .sort((a, b) => a.file.createdTime.localeCompare(b.file.createdTime) || a.file.id.localeCompare(b.file.id))
  const files: DropFile[] = []
  for (const { path, file } of walked.slice(0, DROP_PER_RUN)) {
    const a = file.mimeType === DOC_MIME && google.authorship ? await google.authorship(file.id) : null
    const proof = proofOf(file, a, owner)
    const text = file.mimeType === DOC_MIME || TEXT_MIMES.has(file.mimeType) ? await google.text(file, DROP_WORDS_MAX) : null
    files.push({ path: `${DROP_FOLDER}/${path}`, file, proof, text: text?.trim() || null })
  }
  return { files, more: Math.max(0, walked.length - DROP_PER_RUN), owner: owner !== null }
}

/** The kind of record a file is: a name that starts with liked or process says so, anything else is a rejection. */
export function kindOf(name: string): RecordRow['kind'] {
  return /^liked\b/i.test(name) ? 'liked' : /^process\b/i.test(name) ? 'process' : 'rejected'
}

/**
 * One file of the zone as a record, and as a quote when it is his typing. Pure. A Doc of his with no words files
 * nothing; anything else with nothing to keep (no words, no picture, no clip) files nothing either.
 */
export function fileDrop(d: DropFile): { quote: QuoteRow | null; record: RecordRow } | null {
  const { file, text } = d
  const image = /^image\//.test(file.mimeType)
  const video = /^video\//.test(file.mimeType)
  if (!text && !image && !video) return null
  const his = d.proof === 'his_typing' && Boolean(text)
  // When he typed it: the Doc's last change, to the second, since a Doc is typed over time and kept as he left it.
  const at = new Date(his ? file.modifiedTime : file.createdTime)
  if (Number.isNaN(at.getTime())) return null
  const kind = kindOf(file.name)
  const quote: QuoteRow | null = his ? {
    key: quoteKey(text!, at.toISOString().slice(0, 10)), text: text!, saidAt: at.toISOString(), precision: 'second',
    // The quote's class is capture (his words, captured where he put them); where says the rest.
    saidWhere: 'a Google Doc he typed in the Rejections inbox', source: 'capture',
    attribution: 'krish_words',
  } : null
  const craft = text && his ? craftNamed(text) : []
  const formats = craft.length ? craft : formatsOf(file.name, { item: text ?? '' })
  const capture: Capture = image ? 'still' : video ? 'whole_cut' : 'words'
  const content = { k: kind, q: quote ? [quote.key] : [], t: his ? null : contentHash(text ?? file.id), f: formats, c: capture, p: d.proof, rules: RULES_REV }
  return {
    quote,
    record: {
      source: 'inbox', sourceRef: `drop:${file.id}`, version: contentHash(content), kind,
      rejectedAt: at.toISOString(), quoteKeys: quote ? [quote.key] : [], attribution: his ? 'krish_words' : 'observation',
      // A machine's note is shown as what it says the thing was, never as his words.
      item: his ? null : clip(text, 4000),
      reason: null, wantedInstead: null, strength: kind === 'liked' ? 'liked' : 'unstated',
      theme: kind === 'liked' ? 'liked' : kind === 'process' ? 'process' : 'other', formats,
      ruleKind: kind === 'process' ? 'workflow' : 'form', capture, piece: null,
      media: { stills: image ? [d.path] : [], strips: [], masters: video ? [{ where: 'drive_id', ref: file.id }] : [], texts: 0 },
      moment: null,
      meta: { drop_zone: true, proof: d.proof, mime: file.mimeType },
      venture: folderVenture(DRIVE.rejections),
    },
  }
}
