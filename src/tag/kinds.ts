import { DRIVE } from '../config.ts'
import type { DriveFile } from '../google.ts'
import { mediaOf } from './hints.ts'

// What kind of thing a card is, so it is asked only its own question and its inspiration goes where that kind belongs
// (Krish, 2026-10-24): "if I post a video in here, it's because I like either the script, the narrative, or the
// production style. When I post images in here, it's because I like the clarity." A sheet like Instagram inspo "is
// always being updated and I likely want to pull the latest fresh posts", and a corpus is "all the research from
// Perplexity" on an idea, "for a specific article or a specific content piece".
//
// The file settles the kind when it can (a rule, kept as fact); the tagger's model reads a document the rules cannot
// settle; Krish can correct either on the page. Pure.

export const KINDS = ['video', 'image', 'feed', 'corpus', 'idea', 'document'] as const
export type Kind = typeof KINDS[number]
/** The kinds a model may choose, for a document the rules cannot settle. */
export const DOC_KINDS = ['corpus', 'idea', 'document'] as const
export type DocKind = typeof DOC_KINDS[number]

/** Why each video drop was saved: the three reasons he names. */
export const VIDEO_REASONS = ['script', 'narrative', 'production'] as const
export type VideoReason = typeof VIDEO_REASONS[number]

const SHEET = /spreadsheet|ms-excel|text\/csv/

/** The kind a file's id, type and name prove, or null when only reading it can tell. */
export function ruleKind(f: Pick<DriveFile, 'id' | 'name' | 'mimeType'>): Kind | null {
  if (f.id === DRIVE.instagramInspo) return 'feed'
  const media = mediaOf(f.mimeType)
  if (media === 'video') return 'video'
  if (media === 'image') return 'image'
  if (/corpus/i.test(f.name)) return 'corpus'
  if (/^content seed:/i.test(f.name) || /^\d{2}\s+index\b.*\bscripts?\b/i.test(f.name)) return 'idea'
  // A sheet he keeps refreshed: its name says so (inspo, feed, tracker of posts). Only the Instagram one is known today.
  if (SHEET.test(f.mimeType) && /\b(inspo|feed)\b/i.test(f.name)) return 'feed'
  return null
}

/** What a kind asks him on the page, for the prompt and the tests. */
export const KIND_MEANS: Record<Kind, string> = {
  video: 'a video he saved because he likes its script, its narrative or its production style',
  image: 'an image he saved because he likes its clarity',
  feed: 'a sheet that keeps itself fresh with posts from channels he follows; never asked about',
  corpus: 'research gathered on one topic for a specific piece, often from Perplexity',
  idea: 'a seed, outline or script for a piece he might make',
  document: 'an article, guide or note he saved that is none of the above',
}
