import { describe, it, expect } from 'vitest'
import { DRIVE } from '../src/config.ts'
import { FOLDER_MIME, type Authorship, type DriveFile, type Google } from '../src/google.ts'
import { fileDrop, kindOf, proofOf, readDropZone, type DropFile } from '../src/rejection/dropzone.ts'

// The drop zone (Rejections/Inbox/): a file is his words only when it is provably his typing. Synthetic files, ids and
// permission ids only.
const DOC = 'application/vnd.google-apps.document'
const OWNER = 'perm-synthetic-owner'
const OTHER = 'perm-synthetic-other'
const file = (id: string, name: string, mimeType: string, at = '2026-10-29T09:30:00Z'): DriveFile =>
  ({ id, name, mimeType, modifiedTime: at, createdTime: '2026-10-29T09:00:00Z' })
const his: Authorship = { owners: [OWNER], lastModifier: OWNER, revisionAuthors: [OWNER, OWNER] }

describe('proofOf', () => {
  it('takes only a Doc owned, last changed and wholly revised by the folder owner as his typing', () => {
    const doc = file('1SYNdoc', 'a doc', DOC)
    expect(proofOf(doc, his, OWNER)).toBe('his_typing')
    expect(proofOf(file('1SYNtxt', 'a note.md', 'text/markdown'), his, OWNER)).toBe('not_a_doc')
    expect(proofOf(doc, his, null)).toBe('no_owner')
    expect(proofOf(doc, { ...his, owners: [OTHER] }, OWNER)).toBe('not_his_account')
    expect(proofOf(doc, { ...his, owners: [OWNER, OTHER] }, OWNER)).toBe('not_his_account')
    expect(proofOf(doc, { ...his, lastModifier: OTHER }, OWNER)).toBe('touched_by_another')
    expect(proofOf(doc, { ...his, revisionAuthors: [OWNER, OTHER] }, OWNER)).toBe('touched_by_another')
    // Where Drive will not list the revisions, nothing proves it.
    expect(proofOf(doc, { ...his, revisionAuthors: null }, OWNER)).toBe('revisions_unlisted')
    expect(proofOf(doc, null, OWNER)).toBe('not_his_account')
  })
})

describe('fileDrop', () => {
  const words = 'synthetic: the short cut opens twice, cut the second intro'
  it('files his typing whole, as his words, when he left it', () => {
    const d: DropFile = { path: 'Inbox/short cut', file: file('1SYNdoc', 'short cut', DOC), proof: 'his_typing', text: words }
    const f = fileDrop(d)!
    expect(f.quote).toMatchObject({ text: words, saidAt: '2026-10-29T09:30:00.000Z', precision: 'second', attribution: 'krish_words', source: 'capture' })
    expect(f.record).toMatchObject({ source: 'inbox', sourceRef: 'drop:1SYNdoc', kind: 'rejected', attribution: 'krish_words', item: null,
      capture: 'words', quoteKeys: [f.quote!.key], venture: 'publication' })
    expect(f.record.formats).toContain('intro_outro')
  })
  it('files anything else as an observation with no words of his, and keeps a picture or a clip', () => {
    const note = fileDrop({ path: 'Inbox/note.md', file: file('1SYNmd', 'short cut note.md', 'text/markdown'), proof: 'not_a_doc', text: words })!
    expect(note.quote).toBeNull()
    expect(note.record).toMatchObject({ attribution: 'observation', quoteKeys: [], item: words, capture: 'words' })
    expect(note.record.formats).toContain('short_video')
    const touched = fileDrop({ path: 'Inbox/doc', file: file('1SYNdoc2', 'doc', DOC), proof: 'touched_by_another', text: words })!
    expect(touched.quote).toBeNull()
    expect(touched.record.attribution).toBe('observation')
    const shot = fileDrop({ path: 'Inbox/shot.png', file: file('1SYNpng', 'shot.png', 'image/png'), proof: 'not_a_doc', text: null })!
    expect(shot.record).toMatchObject({ capture: 'still', media: { stills: ['Inbox/shot.png'], masters: [] } })
    const clip = fileDrop({ path: 'Inbox/cut.mp4', file: file('1SYNmp4', 'cut.mp4', 'video/mp4'), proof: 'not_a_doc', text: null })!
    expect(clip.record).toMatchObject({ capture: 'whole_cut', media: { masters: [{ where: 'drive_id', ref: '1SYNmp4' }] } })
  })
  it('files nothing from a file with nothing to keep, and reads the kind from the name', () => {
    expect(fileDrop({ path: 'Inbox/empty', file: file('1SYNe', 'empty', DOC), proof: 'his_typing', text: null })).toBeNull()
    expect(kindOf('liked the grade')).toBe('liked')
    expect(kindOf('Process: asking too much')).toBe('process')
    expect(kindOf('the intro')).toBe('rejected')
  })
  it('gives an edited Doc a new version of the same record', () => {
    const d = (text: string, at: string): DropFile => ({ path: 'Inbox/doc', file: file('1SYNdoc', 'doc', DOC, at), proof: 'his_typing', text })
    const a = fileDrop(d(words, '2026-10-29T09:30:00Z'))!.record
    const b = fileDrop(d(`${words}, and the close`, '2026-10-29T10:30:00Z'))!.record
    expect(a.sourceRef).toBe(b.sourceRef)
    expect(a.version).not.toBe(b.version)
  })
})

describe('readDropZone', () => {
  const inbox = file('1SYNinbox', 'Inbox', FOLDER_MIME)
  const docs = [file('1SYNdocA', 'mine', DOC), file('1SYNdocB', 'theirs', DOC), file('1SYNmdC', 'note.md', 'text/markdown')]
  const google = (o: { inbox?: boolean; folderOwner?: string[] } = {}): Google => ({
    listFolder: async (id: string) => id === DRIVE.rejections ? (o.inbox === false ? [] : [inbox]) : id === inbox.id ? docs : [],
    text: async (f: DriveFile) => `synthetic words of ${f.name}`,
    authorship: async (id: string) => id === DRIVE.rejections ? { owners: o.folderOwner ?? [OWNER], lastModifier: OWNER, revisionAuthors: null }
      : id === '1SYNdocA' ? his : { owners: [OWNER], lastModifier: OTHER, revisionAuthors: [OTHER] },
  }) as unknown as Google
  it('reads every file under the zone with its proof and words', async () => {
    const z = await readDropZone(google())
    expect(z.owner).toBe(true)
    expect(z.files.map(f => [f.path, f.proof, f.text])).toEqual([
      // Oldest first, then by id.
      ['Inbox/mine', 'his_typing', 'synthetic words of mine'],
      ['Inbox/theirs', 'touched_by_another', 'synthetic words of theirs'],
      ['Inbox/note.md', 'not_a_doc', 'synthetic words of note.md'],
    ])
  })
  it('reads a zone that is not there as empty, and a folder with no single owner proves nothing', async () => {
    expect(await readDropZone(google({ inbox: false }))).toEqual({ files: [], more: 0, owner: false })
    const z = await readDropZone(google({ folderOwner: [] }))
    expect(z.owner).toBe(false)
    expect(z.files.every(f => f.proof !== 'his_typing')).toBe(true)
  })
})
