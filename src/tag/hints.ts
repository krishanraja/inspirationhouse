// What a file's name and type already say about it, before any model looks. Krish's drops carry their origin in the
// name: a phone screenshot ends in the app it came from, and each saver tool stamps its own prefix. These are facts
// read from the name, given to the tagger as hints and kept when the model has nothing better. Pure.

export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'linkedin', 'x', 'substack', 'facebook', 'threads', 'web', 'unknown'] as const
export const FORMATS = ['short_video', 'long_video', 'single_image', 'carousel', 'screenshot', 'chart', 'document', 'article', 'thread', 'other'] as const
export const MEDIA = ['video', 'image', 'document'] as const
export type Platform = typeof PLATFORMS[number]
export type Format = typeof FORMATS[number]
export type Media = typeof MEDIA[number]

export interface Hints { platform: Platform | null; format: Format | null; media: Media; source: string | null }

const RULES: Array<{ test: RegExp; platform: Platform; format?: Format; source: string }> = [
  { test: /^Screenshot_\d{8}_\d{6}_Instagram\b/i, platform: 'instagram', format: 'screenshot', source: 'a screenshot on his phone, in Instagram' },
  { test: /^Screenshot_\d{8}_\d{6}_TikTok\b/i, platform: 'tiktok', format: 'screenshot', source: 'a screenshot on his phone, in TikTok' },
  { test: /^Screenshot_\d{8}_\d{6}_LinkedIn\b/i, platform: 'linkedin', format: 'screenshot', source: 'a screenshot on his phone, in LinkedIn' },
  { test: /^Screenshot_\d{8}_\d{6}_(X|Twitter)\b/i, platform: 'x', format: 'screenshot', source: 'a screenshot on his phone, in X' },
  { test: /^Screenshot_\d{8}_\d{6}_YouTube\b/i, platform: 'youtube', format: 'screenshot', source: 'a screenshot on his phone, in YouTube' },
  { test: /^Screenshot_\d{8}_\d{6}_Substack\b/i, platform: 'substack', format: 'screenshot', source: 'a screenshot on his phone, in Substack' },
  { test: /^Screenshot_\d{8}_\d{6}_Chrome\b/i, platform: 'web', format: 'screenshot', source: 'a screenshot on his phone, in Chrome' },
  { test: /^SaveClip\.App_/i, platform: 'instagram', source: 'saved from Instagram with SaveClip' },
  { test: /^igexport-/i, platform: 'instagram', source: 'exported from Instagram' },
  { test: /ytshorts|youtube[_ .-]?shorts/i, platform: 'youtube', format: 'short_video', source: 'saved from YouTube Shorts' },
  { test: /savetube|youtube|youtu\.be/i, platform: 'youtube', source: 'saved from YouTube' },
  { test: /snaptik|ssstik|tiktok/i, platform: 'tiktok', source: 'saved from TikTok' },
  { test: /linkedin/i, platform: 'linkedin', source: 'saved from LinkedIn' },
  { test: /instagram|insta(?:gram)?[_ .-]?reel/i, platform: 'instagram', source: 'saved from Instagram' },
  { test: /^https?:\/\//i, platform: 'web', source: 'a link he saved' },
]

export function mediaOf(mime: string): Media {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return 'document'
}

export function filenameHints(name: string, mime: string): Hints {
  const media = mediaOf(mime)
  const rule = RULES.find(r => r.test.test(name))
  let format: Format | null = rule?.format ?? null
  if (!format && media === 'document') format = 'document'
  if (!format && media === 'image') format = /^Screenshot_/i.test(name) ? 'screenshot' : null
  return { platform: rule?.platform ?? null, format, media, source: rule?.source ?? null }
}
