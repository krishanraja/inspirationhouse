import { describe, it, expect } from 'vitest'
import {
  groupsOf, renderGroup, resolveStandard, standardFingerprint, distilFloor, FLOOR_CHUNK_RECORDS,
  type DraftStandard, type FloorQuote, type FloorRecord,
} from '../src/rejection/distil.ts'
import {
  scrub, assertPublic, renderFloor, loadFloor, FLOOR_FILE,
  type MediaViewRow, type QuoteViewRow, type RecordViewRow, type RenderInput, type StandardRow, productionOf } from '../src/rejection/render.ts'
import { floorPullBody, publishFloor, FLOOR_BRANCH, FLOOR_CLOSEOUT_LINE } from '../src/rejection/publish.ts'
import { fileCapture, fileReportDislike, type InboxRow, type ReportEvidence } from '../src/rejection/arrivals.ts'
import { FORMATS, FORMAT_GROUPS, type FormatSlug } from '../src/rejection/vocab.ts'
import { quoteKey } from '../src/rejection/file.ts'
import { hashLine, type GitHubApi } from '../src/publish/harness.ts'
import { contentHash } from '../src/hash.ts'
import { safeFields } from '../src/log.ts'
import { readOnly, type Db } from '../src/db.ts'
import type { Llm } from '../src/llm.ts'

// Synthetic records, quotes and ids only; nothing here is anything Krish said or any file in his Drive.
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DRIVE_ID = '1SYNTHETICfileid000000000001'
const RUN = '00000000-0000-4000-8000-0000000000aa'

const quote = (n: number, text: string, attribution = 'krish_words'): FloorQuote =>
  ({ id: UUID(n), text, attribution, said_at: `2026-10-01T12:00:${String(n % 60).padStart(2, '0')}.000Z` })
const floorRec = (over: Partial<FloorRecord> = {}): FloorRecord => ({
  source: 'drive_dump', source_ref: 'synthetic-1', kind: 'rejected', theme: 'clipart_generic', formats: ['card'], rule_kind: 'form',
  item: 'synthetic: a stock robot on the chapter card', wanted_instead: null, strength: 'rejected', capture: 'still',
  quotes: [quote(1, 'synthetic: the robot is boring clipart')], near: [], ...over,
})
const draft = (over: Partial<DraftStandard> = {}): DraftStandard => ({
  statement: 'Never put stock clipart on a card.', how_to_check: 'Look at every card frame before delivery.',
  formats: ['card'], theme: 'clipart_generic', layer: 'graphics', kind: 'form', records: [0],
  krish_quote_ref: null, krish_quote: null, boundary: [], ...over,
})
// Resolved the way distilFloor does: refs come from the rendered group, formats from the group's makers.
const resolve = (d: DraftStandard, records: FloorRecord[], group = 'motion_and_cards', liked = new Map<string, FloorQuote>()) => {
  const { words, likedRefs } = renderGroup(records, liked, [])
  const allowed = [...FORMAT_GROUPS[group]!].filter(f => f !== 'other') as FormatSlug[]
  return resolveStandard(d, group, allowed, records, words, likedRefs)
}

describe('which group a floor record is drafted in', () => {
  it('sends a process record to the workflow floor alone, whatever its formats', () => {
    expect(groupsOf({ kind: 'process', formats: ['session'] })).toEqual(['workflow'])
    expect(groupsOf({ kind: 'process', formats: ['short_video', 'cover'] })).toEqual(['workflow'])
  })

  it('sends a rejection to every group one of its formats is in', () => {
    expect(groupsOf({ kind: 'rejected', formats: ['short_video'] })).toEqual(['video_edit'])
    expect(groupsOf({ kind: 'rejected', formats: ['cover', 'motion', 'audio'] })).toEqual(['video_edit', 'motion_and_cards', 'packaging'])
    expect(groupsOf({ kind: 'rejected', formats: ['script', 'site'] })).toEqual(['words', 'surfaces'])
  })

  it('sends a rejection with no production format to everything', () => {
    expect(groupsOf({ kind: 'rejected', formats: ['all'] })).toEqual(['everything'])
    expect(groupsOf({ kind: 'rejected', formats: ['other'] })).toEqual(['everything'])
    expect(groupsOf({ kind: 'rejected', formats: [] })).toEqual(['everything'])
  })
})

describe('the records of one group, as the model reads them', () => {
  const liked = new Map([[UUID(50), quote(50, 'synthetic: the hand-drawn arrows work')], [UUID(51), quote(51, 'synthetic: the plain grid is fine')]])
  const records = [
    floorRec({
      quotes: [quote(1, 'synthetic: the robot is boring clipart'), quote(2, 'synthetic: yes to all', 'krish_action')],
      near: [{ quote_id: UUID(50), basis: 'same breath' }, { quote_id: UUID(99), basis: 'a liked quote no longer standing' }],
      wanted_instead: 'synthetic: a drawn diagram',
    }),
    floorRec({
      source_ref: 'synthetic-2', theme: 'layout', formats: ['card', 'motion'], item: null, strength: 'disliked', capture: 'moment',
      quotes: [quote(3, 'synthetic: a session paraphrase', 'observation')],
      near: [{ quote_id: UUID(50), basis: 'same breath' }, { quote_id: UUID(51), basis: 'same breath' }],
    }),
  ]
  const g = renderGroup(records, liked, ['Never synthetic existing standard.'])

  it('numbers each record, each of his words and each liked line', () => {
    expect(g.text).toContain('<record ref="0" theme="clipart_generic" formats="card" strength="rejected" kept_as="still">')
    expect(g.text).toContain('<record ref="1" theme="layout" formats="card,motion" strength="disliked" kept_as="moment">')
    expect(g.text).toContain('<words ref="0">synthetic: the robot is boring clipart</words>')
    expect(g.words.map(w => w.id)).toEqual([UUID(1), UUID(2), UUID(3)])
    // A liked line seen twice keeps its first ref; one no longer standing is left out.
    expect(g.likedRefs.map(q => q.id)).toEqual([UUID(50), UUID(51)])
    expect(g.text.match(/<liked ref="0">synthetic: the hand-drawn arrows work<\/liked>/g)).toHaveLength(2)
    expect(g.text).toContain('<liked ref="1">synthetic: the plain grid is fine</liked>')
    expect(g.text).toContain('<what>synthetic: a stock robot on the chapter card</what>')
    expect(g.text).toContain('<wanted>synthetic: a drawn diagram</wanted>')
    expect(g.text).not.toContain('<what></what>')
    expect(g.text).not.toMatch(/\n\n/)
  })

  it('marks an approval or a paraphrase as not his words', () => {
    expect(g.text).toContain('<words ref="1" kind="approval or paraphrase, not his words">synthetic: yes to all</words>')
    expect(g.text).toContain('<words ref="2" kind="approval or paraphrase, not his words">synthetic: a session paraphrase</words>')
  })

  it('lists the existing standards first, so the model can reuse their wording', () => {
    expect(g.text.startsWith('Existing standards:\n- Never synthetic existing standard.\n<record ref="0"')).toBe(true)
    expect(renderGroup(records, liked, []).text.startsWith('<record ref="0"')).toBe(true)
  })
})

describe('a drafted standard, checked', () => {
  const a = floorRec({
    quotes: [
      quote(1, 'synthetic: the robot   is\nboring clipart, every time'),
      quote(2, 'synthetic: yes, the robot is boring clipart', 'krish_action'),
      quote(4, 'synthetic: a session summary', 'observation'),
    ],
  })
  const b = floorRec({ source_ref: 'synthetic-2', formats: ['motion'], theme: 'clipart_generic', quotes: [quote(3, 'synthetic: the spinning robot again')] })

  it('keeps the formats of its group, sorted, and resolves its records and quotes', () => {
    const s = resolve(draft({ formats: ['motion', 'card', 'cover', 'card'], records: [1, 0, 0] }), [a, b])!
    expect(s.formats).toEqual(['card', 'motion'])
    // His words and his approvals are its support; a paraphrase is context and never counted.
    expect(s.quoteIds).toEqual([UUID(1), UUID(2), UUID(3)])
    expect(s.recordRefs).toEqual(['drive_dump:synthetic-1', 'drive_dump:synthetic-2'])
    expect(s).toMatchObject({ theme: 'clipart_generic', layer: 'graphics', kind: 'form', krish: null, krishQuoteId: null })
    expect(s.fingerprint).toBe(standardFingerprint(['card', 'motion'], 'Never put stock clipart on a card.'))
  })

  it('drops a standard whose formats all fall outside its group', () => {
    expect(resolve(draft({ formats: ['cover', 'synthetic_format'] }), [a])).toBeNull()
    expect(resolve(draft({ formats: [] }), [a])).toBeNull()
  })

  it('drops a standard none of whose cited records holds his words', () => {
    const approvalOnly = floorRec({ quotes: [quote(5, 'synthetic: yes', 'krish_action'), quote(6, 'synthetic: a summary', 'observation')] })
    expect(resolve(draft({ records: [0] }), [approvalOnly])).toBeNull()
    // His words in a record it does not cite do not count.
    expect(resolve(draft({ records: [0] }), [approvalOnly, a])).toBeNull()
    expect(resolve(draft({ records: [1] }), [approvalOnly, a])).not.toBeNull()
  })

  it('keeps his phrase only when a cited quote of his words holds it, whatever the spacing', () => {
    const c = floorRec({ source_ref: 'synthetic-3', quotes: [quote(7, 'synthetic: the robot is boring clipart')] })
    // words: 0 and 1 are a's words and approval, 2 is a's summary, 3 is b's, 4 is c's (not cited below).
    const recs = [a, b, c]
    const krish = (krish_quote: string | null, krish_quote_ref: number | null) =>
      resolve(draft({ records: [0, 1], krish_quote, krish_quote_ref }), recs)!
    expect(krish('  the robot is\tboring clipart ', 0)).toMatchObject({ krish: 'the robot is boring clipart', krishQuoteId: UUID(1) })
    // Character for character: a changed case or word is not his.
    expect(krish('The Robot is boring clipart', 0).krish).toBeNull()
    expect(krish('the robot is dull', 0).krish).toBeNull()
    // An approval holds the phrase, but an approval is not his words.
    expect(krish('the robot is boring clipart', 1).krish).toBeNull()
    // A quote of his in a record the standard does not rest on.
    expect(krish('the robot is boring clipart', 4)).toMatchObject({ krish: null, krishQuoteId: null })
    expect(krish('the robot is boring clipart', 99).krish).toBeNull()
    expect(krish('the robot is boring clipart', null).krish).toBeNull()
    expect(krish(null, 0).krish).toBeNull()
  })

  it('ignores a record, quote or boundary ref out of range', () => {
    const liked = new Map([[UUID(50), quote(50, 'synthetic: the drawn arrows work')]])
    const withNear = floorRec({ ...a, near: [{ quote_id: UUID(50), basis: 'same breath' }] })
    const s = resolve(draft({ records: [0, 7, -1], boundary: [0, 5, -2] }), [withNear], 'motion_and_cards', liked)!
    expect(s.recordRefs).toEqual(['drive_dump:synthetic-1'])
    expect(s.boundaryIds).toEqual([UUID(50)])
    expect(resolve(draft({ records: [3, 9] }), [a])).toBeNull()
  })

  it("falls back to the cited records' majority theme when the model's is not a standard theme", () => {
    const recs = [
      floorRec({ theme: 'layout' }), floorRec({ source_ref: 'synthetic-2', theme: 'layout' }), floorRec({ source_ref: 'synthetic-3', theme: 'brand' }),
    ]
    for (const theme of ['synthetic_theme', 'liked', 'other', 'story_angle']) {
      expect(resolve(draft({ theme, records: [0, 1, 2] }), recs)!.theme, theme).toBe('layout')
    }
    expect(resolve(draft({ theme: 'brand', records: [0, 1, 2] }), recs)!.theme).toBe('brand')
    // A tie goes to the first by name, so the same records always give the same theme.
    expect(resolve(draft({ theme: 'synthetic_theme', records: [0, 2] }), recs)!.theme).toBe('brand')
    expect(resolve(draft({ layer: 'synthetic_layer' }), recs)!.layer).toBeNull()
  })

  // Bug: `d.theme in THEMES` is true for any Object.prototype name, so 'constructor' passes the vocabulary check.
  it('falls back from a theme that is only a name on Object.prototype', () => {
    const recs = [floorRec({ theme: 'layout' })]
    expect(resolve(draft({ theme: 'constructor' }), recs)!.theme).toBe('layout')
  })

  it('makes every standard of the workflow group a workflow standard', () => {
    const p = floorRec({ kind: 'process', theme: 'process', formats: ['session'], rule_kind: 'workflow', quotes: [quote(8, 'synthetic: stop asking twice')] })
    expect(resolve(draft({ formats: ['session'], theme: 'process', kind: 'form' }), [p], 'workflow')!.kind).toBe('workflow')
    expect(resolve(draft({ kind: 'workflow' }), [a])!.kind).toBe('workflow')
    expect(resolve(draft({ kind: 'synthetic' }), [a])!.kind).toBe('form')
  })

  it('drops a statement or a check under 8 characters once its spacing is squashed', () => {
    expect(resolve(draft({ statement: '  Never \n  ' }), [a])).toBeNull()
    expect(resolve(draft({ how_to_check: 'Look.' }), [a])).toBeNull()
    expect(resolve(draft({ statement: 'Never x.' }), [a])!.statement).toBe('Never x.')
    expect(resolve(draft({ statement: 'Never\n\n  use   clipart.' }), [a])!.statement).toBe('Never use clipart.')
  })
})

describe('the fingerprint of a standard', () => {
  it('ignores case, spacing, punctuation and the order of formats', () => {
    const fp = standardFingerprint(['card', 'cover'], 'Never use stock clipart.')
    expect(standardFingerprint(['cover', 'card'], '  never USE stock,   clipart!  ')).toBe(fp)
  })

  it('tells apart different formats and different words', () => {
    const fp = standardFingerprint(['card'], 'Never use stock clipart.')
    expect(standardFingerprint(['cover'], 'Never use stock clipart.')).not.toBe(fp)
    expect(standardFingerprint(['card', 'cover'], 'Never use stock clipart.')).not.toBe(fp)
    expect(standardFingerprint(['card'], 'Never use drawn clipart.')).not.toBe(fp)
  })
})

describe('distilling the floor', () => {
  const cut = floorRec({ formats: ['short_video'], theme: 'edit_av', capture: 'moment', quotes: [quote(10, 'synthetic: the cut jumps mid word')] })
  const asked = floorRec({
    source_ref: 'synthetic-p1', kind: 'process', theme: 'process', formats: ['session'], rule_kind: 'workflow', capture: 'words',
    quotes: [quote(11, 'synthetic: stop asking before every step')],
  })
  const answers: Record<string, DraftStandard[]> = {
    video_edit: [draft({
      statement: 'Never cut inside a spoken word.', how_to_check: 'Listen to every join at full volume.', formats: ['short_video'],
      theme: 'edit_av', layer: 'editing', krish_quote_ref: 0, krish_quote: 'the cut jumps',
    })],
    workflow: [draft({
      statement: 'Never ask again about a step he approved.', how_to_check: 'Read the session for a repeated question.',
      formats: ['session'], theme: 'process', layer: null, kind: 'workflow',
    })],
  }
  // Every system prompt names workflow as a kind; only the workflow group's says its records are about sessions.
  const groupOf = (system: string) => (/These records are about how a session works with him/.test(system) ? 'workflow' : 'video_edit')

  function stubDb(o: { cursor?: string; open?: number; existing?: Array<{ statement: string; formats: string[] }> } = {}) {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], opts?: { write?: boolean }) {
        if (opts?.write) writes.push({ sql, params })
        if (/json_agg/.test(sql)) return [cut, asked] as T[]
        if (/^select q\.id::text, q\.text, q\.attribution, q\.said_at::text from public\.taste_rejection_quotes/.test(sql)) return [] as T[]
        if (/select cursor from public\.taste_watermarks/.test(sql)) return (o.cursor === undefined ? [] : [{ cursor: o.cursor }]) as T[]
        if (/count\(\*\)::int as n from public\.taste_floor_standards/.test(sql)) return [{ n: o.open ?? 0 }] as T[]
        if (/select statement, formats from public\.taste_floor_standards/.test(sql)) return (o.existing ?? []) as T[]
        if (/^with prior as/.test(sql)) return [{ n: 1 }] as T[]
        if (/set status = 'superseded'/.test(sql)) return [{ id: 'synthetic-superseded' }] as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, writes }
  }
  function stubLlm(fail: string[] = []) {
    const groups: string[] = []
    const texts: string[] = []
    const llm: Llm = {
      model: 'synthetic-model',
      async structured(args) {
        const g = groupOf(args.system)
        groups.push(g)
        texts.push((args.content[0] as { text: string }).text)
        if (fail.includes(g)) return { data: null, failure: 'unparsed', model: 'synthetic-model' } as never
        return { data: { standards: answers[g] }, failure: null, model: 'synthetic-model', repairs: 0 } as never
      },
    }
    return { llm, groups, texts }
  }

  it('on a dry run, reads each group with the model and writes nothing, returning the preview', async () => {
    const s = stubDb({ existing: [{ statement: 'Never synthetic existing cut standard.', formats: ['short_video'] }] })
    const m = stubLlm()
    // readOnly refuses any write, so a write that slipped through would fail the run here.
    const r = await distilFloor(readOnly(s.db), m.llm, RUN, false)
    expect(r).toMatchObject({ records: 2, groups: 2, drafted: 2, resolved: 2, written: 0, superseded: 0, skipped: false, failed: 0 })
    expect(s.writes).toEqual([])
    expect(m.groups.sort()).toEqual(['video_edit', 'workflow'])
    expect(r.preview.map(p => p.statement).sort()).toEqual(['Never ask again about a step he approved.', 'Never cut inside a spoken word.'])
    expect(r.preview.find(p => p.kind === 'workflow')!.formats).toEqual(['session'])
    expect(r.preview.find(p => p.kind === 'form')).toMatchObject({ krish: 'the cut jumps', krishQuoteId: UUID(10) })
    // Each group reads only its own records, and only the existing standards for its makers.
    const videoText = m.texts[m.groups.indexOf('video_edit')]!
    const workflowText = m.texts[m.groups.indexOf('workflow')]!
    expect(videoText).toContain('synthetic: the cut jumps mid word')
    expect(videoText).not.toContain('synthetic: stop asking')
    expect(videoText).toContain('Never synthetic existing cut standard.')
    expect(workflowText).not.toContain('Existing standards')
  })

  // A group of n records, each a cut with words of his: enough to need parts.
  const many = (n: number) => Array.from({ length: n }, (_, i) => floorRec({
    source_ref: `synthetic-many-${String(i).padStart(3, '0')}`, formats: ['short_video'], theme: i % 2 ? 'edit_av' : 'layout', capture: 'moment',
    quotes: [quote(200 + i, `synthetic: cut ${i} jumps mid word`)],
  }))
  function manyDb(records: ReturnType<typeof floorRec>[]) {
    const writes: Array<{ sql: string; params: unknown[] }> = []
    const db: Db = {
      async query<T>(sql: string, params: unknown[] = [], opts?: { write?: boolean }) {
        if (opts?.write) writes.push({ sql, params })
        if (/json_agg/.test(sql)) return records as T[]
        if (/^with prior as/.test(sql)) return [{ n: 1 }] as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    return { db, writes }
  }
  // Each call drafts one standard per distinct record in its part, citing the part's first record.
  function partLlm(o: { maxTokensAbove?: number } = {}) {
    const sizes: number[] = []
    const texts: string[] = []
    const llm: Llm = {
      model: 'synthetic-model',
      async structured(args) {
        const text = (args.content[0] as { text: string }).text
        const n = (text.match(/<record /g) ?? []).length
        sizes.push(n)
        texts.push(text)
        if (o.maxTokensAbove !== undefined && n > o.maxTokensAbove) return { data: null, failure: 'max_tokens', model: 'synthetic-model' } as never
        const statement = `Never synthetic standard number ${sizes.length}.`
        return { data: { standards: [draft({ statement, how_to_check: 'Synthetic: check every join.', formats: ['short_video'], theme: 'edit_av', records: [0] })] }, failure: null, model: 'synthetic-model', repairs: 0 } as never
      },
    }
    return { llm, sizes, texts }
  }

  it(`reads a group of more than ${FLOOR_CHUNK_RECORDS} records in parts, each told what the group has drafted so far`, async () => {
    const s = manyDb(many(70))
    const m = partLlm()
    const r = await distilFloor(s.db, m.llm, RUN, true)
    expect(m.sizes).toEqual([30, 30, 10])
    expect(r).toMatchObject({ groups: 1, calls: 3, failed: 0, resolved: 3, written: 3 })
    // The second part sees the first part's standard; the third sees both.
    expect(m.texts[1]).toContain('Never synthetic standard number 1.')
    expect(m.texts[2]).toContain('Never synthetic standard number 1.')
    expect(m.texts[2]).toContain('Never synthetic standard number 2.')
    // The same records always make the same parts, whatever order they were read in.
    const again = partLlm()
    await distilFloor(manyDb(many(70).reverse()).db, again.llm, RUN, false)
    expect(again.texts).toEqual(m.texts)
  })

  it('reads a part whose answer runs out of room again as two halves, and counts what still fails by why', async () => {
    const s = manyDb(many(30))
    const m = partLlm({ maxTokensAbove: 15 })
    const r = await distilFloor(s.db, m.llm, RUN, true)
    expect(m.sizes).toEqual([30, 15, 15])
    expect(r).toMatchObject({ calls: 3, failed: 0, failures: {}, resolved: 2 })
    // A part too small to halve that still runs out of room is a failure, counted as max_tokens, and supersedes nothing.
    const t = manyDb(many(12))
    const tight = await distilFloor(t.db, partLlm({ maxTokensAbove: 5 }).llm, RUN, true)
    expect(tight).toMatchObject({ calls: 1, failed: 1, failures: { max_tokens: 1 }, superseded: 0 })
    expect(t.writes.some(w => /taste_watermarks/.test(w.sql))).toBe(false)
  })

  it('writes each standard, supersedes what it no longer drafts, and sets the watermark', async () => {
    const s = stubDb()
    const r = await distilFloor(s.db, stubLlm().llm, RUN, true)
    expect(r).toMatchObject({ written: 2, superseded: 1, failed: 0 })
    expect(s.writes.filter(w => /^with prior as/.test(w.sql))).toHaveLength(2)
    const mark = s.writes.find(w => /insert into public\.taste_watermarks/.test(w.sql))!
    expect(mark.params[0]).toBe('rejections_distil')
  })

  it('skips the model when the records are as they were, whether or not he has decided every standard', async () => {
    const first = stubDb()
    await distilFloor(first.db, stubLlm().llm, RUN, true)
    const cursor = first.writes.find(w => /insert into public\.taste_watermarks/.test(w.sql))!.params[1] as string

    const again = stubDb({ cursor, open: 3 })
    const m = stubLlm()
    const r = await distilFloor(again.db, m.llm, RUN, true)
    expect(r.skipped).toBe(true)
    expect(m.groups).toEqual([])
    expect(again.writes).toEqual([])

    // The same records with nothing left open (he decided every standard) are not drafted again either.
    const none = stubLlm()
    expect((await distilFloor(stubDb({ cursor, open: 0 }).db, none.llm, RUN, false)).skipped).toBe(true)
    expect(none.groups).toEqual([])
    // Records that changed are drafted again too.
    expect((await distilFloor(stubDb({ cursor: 'synthetic-older-cursor', open: 3 }).db, stubLlm().llm, RUN, false)).skipped).toBe(false)
  })

  it('counts a failed group and supersedes nothing, keeping its candidates until a reading succeeds', async () => {
    const s = stubDb()
    const r = await distilFloor(s.db, stubLlm(['workflow']).llm, RUN, true)
    expect(r).toMatchObject({ groups: 2, calls: 2, failed: 1, failures: { unparsed: 1 }, resolved: 1, written: 1, superseded: 0 })
    expect(s.writes.filter(w => /^with prior as/.test(w.sql))).toHaveLength(1)
    expect(s.writes.some(w => /set status = 'superseded'/.test(w.sql))).toBe(false)
    expect(s.writes.some(w => /taste_watermarks/.test(w.sql))).toBe(false)
  })
})

describe('scrubbing text for the public floor file', () => {
  it('takes out Windows and Drive-for-desktop paths, up to where the sentence goes on', () => {
    expect(scrub('synthetic: open C:\\Users\\synthetic\\cut.mp4, then H:\\My Drive\\synthetic\\still.png'))
      .toBe('synthetic: open [path], then [path]')
  })

  it('takes out Drive, Docs and claude.ai links, uuids, session ids, emails and Drive-id-shaped tokens', () => {
    expect(scrub(`synthetic: see https://drive.google.com/file/d/${DRIVE_ID}/view and https://docs.google.com/document/d/x/edit`))
      .toBe('synthetic: see [link] and [link]')
    expect(scrub('synthetic: from https://claude.ai/code/session_SYNTHETIC0001 today')).toBe('synthetic: from [link] today')
    expect(scrub(`synthetic: row ${UUID(1)} and cse_SYNTHETIC0001 and session_SYNTHETIC0002`)).toBe('synthetic: row [id] and [session] and [session]')
    expect(scrub('synthetic: mail synthetic.person@example.org now')).toBe('synthetic: mail [email] now')
    expect(scrub(`synthetic: the file ${DRIVE_ID} again`)).toBe('synthetic: the file [id] again')
  })

  it('leaves ordinary words alone, and null as null', () => {
    expect(scrub('synthetic: the 9:16 cut at 0:42 drags, see example.org')).toBe('synthetic: the 9:16 cut at 0:42 drags, see example.org')
    expect(scrub('synthetic: 10:30/11:00, 16:9/9:16 and https://example.org/home/x stay')).toBe('synthetic: 10:30/11:00, 16:9/9:16 and https://example.org/home/x stay')
    expect(scrub(null)).toBeNull()
  })

  it('takes out a path with either slash and either case, in Drive for desktop, on a Mac or Linux, and an older Drive id', () => {
    expect(scrub('synthetic: c:\\Users\\synthetic\\cut.mp4 is wrong')).toBe('synthetic: [path] is wrong')
    expect(scrub('synthetic: play H:/My Drive/synthetic/cut.mp4 at 3 s.')).toBe('synthetic: play [path] at 3 s.')
    expect(scrub('synthetic: My Drive/synthetic/cut.mp4, then')).toBe('synthetic: [path], then')
    expect(scrub('synthetic: /Users/synthetic/Movies/cut.mp4 and /home/synthetic/cut.mp4')).toBe('synthetic: [path] and [path]')
    expect(scrub('synthetic: /users/synthetic/cut.mp4')).toBe('synthetic: [path]')
    expect(scrub('synthetic: 0B1syntheticSYNTHETICsynth and 0AsyntheticSYNTHETIC1')).toBe('synthetic: [id] and [id]')
  })

  it('ends a path at a line break, a pipe or the space after its extension, so the rest of what he said stays', () => {
    expect(scrub('synthetic: H:\\My Drive\\synthetic\\cut.mp4\nthe join chops a word')).toBe('synthetic: [path]\nthe join chops a word')
    expect(scrub('synthetic: C:\\synthetic|then')).toBe('synthetic: [path]|then')
    expect(scrub('synthetic: before H:\\clip.mp4 and after')).toBe('synthetic: before [path] and after')
  })

  it('leaves nothing the last check refuses, however the path, link, id or session name is written', () => {
    for (const t of ['synthetic: drop the cut in /Users/ and stop', 'synthetic: just open claude.ai/code and do it there',
      'synthetic: the brief was already in docs.google.com, read it', 'synthetic: never touch the session_transcript_store table',
      'synthetic: drive.google.com/drive/folders', 'synthetic: (C:/x)', 'synthetic: a.b@c.de']) {
      expect(() => assertPublic(scrub(t)!), t).not.toThrow()
    }
    // A sentence of his keeps what is around them.
    expect(scrub('synthetic: just open claude.ai/code and do it there')).toBe('synthetic: just open [link] and do it there')
    expect(scrub('synthetic: never touch the session_transcript_store table')).toBe('synthetic: never touch the [session] table')
  })

  it('never lets a made-up mix of paths, links, ids and words through to a file the last check refuses', () => {
    const parts = ['C:', 'c:', 'H:', '\\', '/', 'Users', 'home', 'My Drive', 'My drive', 'drive.google.com', 'docs.google.com',
      'claude.ai/', 'https://', 'session_', 'cse_', 'abcdefgh12', 'ABCDEFGH', '0B', '0A', '1', DRIVE_ID, UUID(7), '@', 'example.org',
      ' ', ' ', '  ', '\n', ',', '.', ';', '(', ')', '"', "'", '|', '<', '-', '_', 'mp4', '.png', 'synthetic', 'the cut']
    // A fixed seed: the same strings every run.
    let seed = 20261028
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 3000; i++) {
      const t = Array.from({ length: 1 + Math.floor(next() * 12) }, () => parts[Math.floor(next() * parts.length)]).join('')
      expect(() => assertPublic(scrub(t)!), JSON.stringify(t)).not.toThrow()
    }
  })

  it('leaves nothing the last check refuses, so an unchangeable quote can never block the render', () => {
    const nasty = [
      'synthetic: H:\\My Drive\\a b\\c.mp4\nnext line C:/x/y', 'synthetic: c:/x|y<z>', 'synthetic: /Volumes/synthetic/x.mov;',
      'synthetic: My Drive\\x\\y and /mnt/x', `synthetic: ${DRIVE_ID} 0B1syntheticSYNTHETICsynth`, 'synthetic: (D:\\x\\y)',
    ]
    for (const t of nasty) expect(() => assertPublic(scrub(t)!), t).not.toThrow()
  })
})

describe('refusing a floor file that is not public', () => {
  it('throws on a path, a Drive or Docs link, a uuid, a cse_ session id and an email', () => {
    expect(() => assertPublic('synthetic: H:\\My Drive\\synthetic')).toThrow(/path/)
    expect(() => assertPublic('synthetic: C:\\Users\\synthetic')).toThrow(/path/)
    expect(() => assertPublic('synthetic: https://drive.google.com/file/d/x')).toThrow(/link/)
    expect(() => assertPublic('synthetic: https://docs.google.com/document/d/x')).toThrow(/link/)
    expect(() => assertPublic(`synthetic: ${UUID(1)}`)).toThrow(/id/)
    expect(() => assertPublic('synthetic: cse_SYNTHETIC0001')).toThrow(/session/)
    expect(() => assertPublic('synthetic: synthetic.person@example.org')).toThrow(/email/)
  })

  it('throws on a path with a forward slash, a lowercase drive, Drive for desktop, a Mac or Linux home, and an older Drive id', () => {
    for (const t of ['synthetic: C:/Users/synthetic', 'synthetic: c:\\users\\synthetic', 'synthetic: My Drive/synthetic',
      'synthetic: /Users/synthetic/x', 'synthetic: /home/synthetic/x']) expect(() => assertPublic(t), t).toThrow(/path/)
    expect(() => assertPublic('synthetic: 0B1syntheticSYNTHETICsynth')).toThrow(/drive id/)
  })

  it('lets through what the file holds by design: hex hashes, short refs and dates', () => {
    expect(() => assertPublic(`"version": "1${'a'.repeat(31)}", "sha256": "1${'b'.repeat(63)}", "rabc1234567": "2026-10-28"`)).not.toThrow()
  })

  // Bug: scrub takes these out of his words, but assertPublic, the last check before publishing, does not refuse them.
  it('throws on a claude.ai link', () => {
    expect(() => assertPublic('synthetic: https://claude.ai/code/synthetic')).toThrow()
  })
  it('throws on a session_ id', () => {
    expect(() => assertPublic('synthetic: session_SYNTHETIC0001')).toThrow()
  })
  it('throws on a Drive-id-shaped token', () => {
    expect(() => assertPublic(`synthetic: ${DRIVE_ID}`)).toThrow()
  })
})

// The floor's rows, as loadFloor reads them.
const vq = (n: number, text: string, attribution = 'krish_words', said_at = '2026-10-02 09:00:00+00'): QuoteViewRow =>
  ({ id: UUID(n), text, attribution, said_at })
const vrec = (over: Partial<RecordViewRow> = {}): RecordViewRow => ({
  source: 'drive_dump', source_ref: 'synthetic-r1', kind: 'rejected', rejected_at: '2026-10-02 09:00:00+00', theme: 'clipart_generic',
  formats: ['card'], rule_kind: 'form', capture: 'still', piece: 'synthetic: piece one', item: 'synthetic: a stock robot on the card',
  wanted_instead: null, strength: 'rejected', quote_ids: [UUID(1)], near: [], media_sha256: [], pointed: false, moment_ms: null, ...over,
})
const vstd = (over: Partial<StandardRow> = {}): StandardRow => ({
  id: UUID(900), fingerprint: 'a'.repeat(32), formats: ['card'], theme: 'clipart_generic', layer: 'graphics', kind: 'form',
  standing: 'draft', statement: 'Never put stock clipart on a card.', how_to_check: 'Look at every card frame before delivery.',
  krish: null, support_n: 1, action_n: 0, quote_ids: [UUID(1)], record_refs: ['drive_dump:synthetic-r1'], boundary_quote_ids: [],
  decided_at: null, ...over,
})

const SHA = 'f'.repeat(64)
const floorInput = (): RenderInput => ({
  standards: [
    vstd({ fingerprint: 'a'.repeat(32), standing: 'approved', decided_at: '2026-10-05 10:00:00+00', krish: 'synthetic: the robot is boring', quote_ids: [UUID(1), UUID(2)] }),
    vstd({ id: UUID(901), fingerprint: 'b'.repeat(32), standing: 'reworded', decided_at: '2026-10-06 10:00:00+00', statement: 'synthetic: Never his reworded line.' }),
    vstd({ id: UUID(902), fingerprint: 'c'.repeat(32), standing: 'draft', formats: ['all'], record_refs: ['drive_dump:synthetic-r2'], quote_ids: [UUID(3)] }),
  ],
  records: [
    vrec({ quote_ids: [UUID(2), UUID(1)], near: [{ quote_id: UUID(50), basis: 'same breath' }], media_sha256: [SHA], pointed: true }),
    vrec({ source_ref: 'synthetic-r2', formats: ['all'], item: 'synthetic: every cut ends on a logo', quote_ids: [UUID(3)] }),
    vrec({ source_ref: 'synthetic-l1', kind: 'liked', theme: 'liked', strength: 'liked', item: 'synthetic: the drawn arrows', quote_ids: [UUID(50)] }),
    vrec({
      source_ref: 'synthetic-p1', kind: 'process', theme: 'process', formats: ['session'], rule_kind: 'workflow', capture: 'words',
      item: 'synthetic: asked the same question twice', quote_ids: [UUID(4)],
    }),
  ],
  quotes: [
    vq(1, 'synthetic: the robot is boring clipart'),
    vq(2, 'synthetic: yes, all of them', 'krish_action', '2026-10-02 09:00:01+00'),
    vq(3, `synthetic: like this one https://drive.google.com/file/d/${DRIVE_ID}/view instead`),
    vq(4, 'synthetic: stop asking twice', 'observation'),
    vq(50, 'synthetic: the drawn arrows work'),
  ],
  media: [
    { sha256: SHA, role: 'still', mime: 'image/jpeg', bytes: 1000, at_ms: 1520, derived_from: null },
    { sha256: 'e'.repeat(64), role: 'clip', mime: 'video/mp4', bytes: 9000, at_ms: null, derived_from: null },
  ],
})

type FloorFile = {
  version: string; as_of: string; counts: Record<string, number>
  formats: Record<string, { maker: string; approved: string[]; draft: string[]; rejected: string[] }>
  standards: Record<string, { standing: string; decided_on?: string; never_beneath: string; check_before_delivery: string; in_his_words?: string; his_words: Array<{ said: string; is: string }>; records: string[] }>
  records: Record<string, { kind: string; formats: string[]; what: string | null; his_words: Array<{ said: string; on: string; is: string }>; liked_nearby: Array<{ said: string; on: string }>; media: Array<Record<string, unknown>>; master?: string }>
}
const parse = (text: string) => JSON.parse(text) as FloorFile
const keyOf = (doc: FloorFile, item: string) => Object.entries(doc.records).find(([, r]) => r.what === item)![0]

describe('rendering the floor', () => {
  it('weighs each standard by the productions it was raised about, patterns first', () => {
    const input = floorInput()
    // A second production for the approved standard's words: the record behind quote 2 moves to another piece.
    input.records.push(vrec({ source_ref: 'synthetic-r3', piece: 'synthetic: another piece', quote_ids: [UUID(2)] }))
    input.records[0] = { ...input.records[0]!, piece: 'synthetic: first piece', quote_ids: [UUID(1)] }
    const doc = parse(renderFloor(input)) as unknown as { counts: Record<string, number>; standards: Record<string, { weight: string; productions: number }> }
    const keys = Object.keys(doc.standards)
    expect(doc.standards[keys[0]!]).toMatchObject({ weight: 'pattern', productions: 2 })
    expect(Object.values(doc.standards).slice(1).every(s => s.weight === 'one_off' && s.productions <= 1)).toBe(true)
    expect(doc.counts.patterns).toBe(1)
    expect(productionOf({ piece: '  Synthetic   PIECE ', rejected_at: '2026-10-20 10:00:00+00' })).toBe('synthetic piece')
    expect(productionOf({ piece: null, rejected_at: '2026-10-20 10:00:00+00' })).toBe('day:2026-10-20')
  })

  it('renders the same bytes for the same floor, whatever order the quotes and media were read in', () => {
    const one = renderFloor(floorInput())
    expect(renderFloor(floorInput())).toBe(one)
    // loadFloor reads quotes and media in no order, so their order must not reach the file.
    const shuffled = floorInput()
    shuffled.quotes.reverse()
    shuffled.media.reverse()
    expect(renderFloor(shuffled)).toBe(one)
    expect(parse(one).version).toMatch(/^[0-9a-f]{32}$/)
    expect(one.endsWith('}\n')).toBe(true)
    // A changed floor is a new version.
    const changed = floorInput()
    changed.standards[2]!.statement = 'Never end a cut on a synthetic logo.'
    expect(parse(renderFloor(changed)).version).not.toBe(parse(one).version)
  })

  it('labels each standard approved, reworded or draft, and lists them by format', () => {
    const doc = parse(renderFloor(floorInput()))
    const [approved, reworded, drafted] = ['a', 'b', 'c'].map(c => `s${c.repeat(10)}`) as [string, string, string]
    expect(doc.standards[approved]).toMatchObject({ standing: 'approved', decided_on: '2026-10-05', in_his_words: 'synthetic: the robot is boring' })
    expect(doc.standards[reworded]).toMatchObject({ standing: 'reworded', decided_on: '2026-10-06', never_beneath: 'synthetic: Never his reworded line.' })
    expect(doc.standards[drafted]!.standing).toBe('draft')
    expect(doc.standards[drafted]!.decided_on).toBeUndefined()
    expect(doc.formats.card!.approved).toEqual([approved, reworded])
    expect(doc.formats.card!.draft).toEqual([drafted])
    expect(doc.counts).toMatchObject({ standards: 3, approved: 2 })
    expect(doc.as_of).toBe('2026-10-06')
  })

  it('finds a standard\'s records by the words it rests on, so a record re-filed under a new identity stays with it', () => {
    const input = floorInput()
    // The record the draft named is gone (a merge pass re-filed it), and a new one carries the same words of his.
    input.records = input.records.map(r => (r.source_ref === 'synthetic-r2' ? { ...r, source_ref: 'synthetic-r2-refiled' } : r))
    const doc = parse(renderFloor(input))
    const drafted = `s${'c'.repeat(10)}`
    expect(doc.standards[drafted]!.records).toEqual([keyOf(doc, 'synthetic: every cut ends on a logo')])
  })

  it('says the engine wrote every check, and whether he approved it with the statement or has not seen it', () => {
    const doc = parse(renderFloor(floorInput())) as unknown as { standards: Record<string, { check_by: string }> }
    const [approved, reworded, drafted] = ['a', 'b', 'c'].map(c => `s${c.repeat(10)}`) as [string, string, string]
    expect(doc.standards[approved]!.check_by).toBe('the engine, approved by him with the statement')
    expect(doc.standards[reworded]!.check_by).toBe('the engine, a draft: he reworded the statement, not this check')
    expect(doc.standards[drafted]!.check_by).toBe('the engine, a draft he has not seen')
  })

  it("puts an 'all' record and standard under every production format, never under session, pipeline, board or other", () => {
    const doc = parse(renderFloor(floorInput()))
    const all = keyOf(doc, 'synthetic: every cut ends on a logo')
    const allStandard = `s${'c'.repeat(10)}`
    for (const f of Object.keys(FORMATS)) {
      if (['session', 'pipeline', 'board', 'other'].includes(f)) {
        expect(doc.formats[f]?.rejected ?? [], f).not.toContain(all)
        expect(doc.formats[f]?.draft ?? [], f).not.toContain(allStandard)
      } else {
        expect(doc.formats[f]?.rejected, f).toContain(all)
        expect(doc.formats[f]?.draft, f).toContain(allStandard)
      }
    }
    // The workflow record is the session's alone.
    expect(doc.formats.session!.rejected).toEqual([keyOf(doc, 'synthetic: asked the same question twice')])
    expect(doc.formats.card!.rejected).not.toContain(keyOf(doc, 'synthetic: asked the same question twice'))
  })

  it('shows a link inside his words as [link], and the file holds no link', () => {
    const text = renderFloor(floorInput())
    const doc = parse(text)
    expect(doc.records[keyOf(doc, 'synthetic: every cut ends on a logo')]!.his_words[0]!.said).toBe('synthetic: like this one [link] instead')
    expect(text).not.toContain('drive.google.com')
    expect(text).not.toContain(DRIVE_ID)
    expect(() => assertPublic(text)).not.toThrow()
  })

  it("labels his words 'his words', an approval 'his approval', and a paraphrase as not his", () => {
    const doc = parse(renderFloor(floorInput()))
    const robot = doc.records[keyOf(doc, 'synthetic: a stock robot on the card')]!
    expect(robot.his_words).toEqual([
      { said: 'synthetic: the robot is boring clipart', on: '2026-10-02', is: 'his words' },
      { said: 'synthetic: yes, all of them', on: '2026-10-02', is: 'his approval' },
    ])
    expect(doc.records[keyOf(doc, 'synthetic: asked the same question twice')]!.his_words[0]!.is).toBe('a paraphrase, not his words')
    // A standard shows only his words, never an approval, as what he said.
    expect(doc.standards[`s${'a'.repeat(10)}`]!.his_words.map(w => w.is)).toEqual(['his words'])
  })

  it('counts what he liked nearby apart from what he rejected', () => {
    const doc = parse(renderFloor(floorInput()))
    expect(doc.counts).toMatchObject({ records: 3, liked_nearby: 1 })
    const robot = doc.records[keyOf(doc, 'synthetic: a stock robot on the card')]!
    expect(robot.liked_nearby).toEqual([{ said: 'synthetic: the drawn arrows work', on: '2026-10-02' }])
    // A liked record is never listed as rejected for a maker.
    expect(doc.formats.card!.rejected).not.toContain(keyOf(doc, 'synthetic: the drawn arrows'))
    // Media by sha256 only, and a master by a note, never its id.
    expect(robot.media).toEqual([{ role: 'still', sha256: SHA, bytes: 1000, at_s: 1.5 }])
    expect(robot.master).toMatch(/never copied/)
  })

  it('never emits a subject record: loadFloor reads only form and workflow records', async () => {
    const input = floorInput()
    const subject = vrec({ source_ref: 'synthetic-s1', theme: 'story_angle', rule_kind: 'subject', item: 'synthetic: the angle is stale', quote_ids: [UUID(60)] })
    const quotes = [...input.quotes, vq(60, 'synthetic: nobody wants this topic')]
    const sqls: string[] = []
    const db: Db = {
      async query<T>(sql: string) {
        sqls.push(sql)
        // Like the database: a query that names the filter gets only the form and workflow records.
        const standing = sql.includes("rule_kind in ('form', 'workflow')") ? input.records : [...input.records, subject]
        if (/from public\.taste_floor\s/.test(sql)) return input.standards as T[]
        if (/^select source, source_ref/.test(sql)) return standing as T[]
        if (/from public\.taste_rejection_quotes q/.test(sql)) {
          return quotes.filter(q => standing.some(r => r.quote_ids.includes(q.id) || r.near.some(n => n.quote_id === q.id))) as T[]
        }
        if (/from public\.taste_rejection_media m/.test(sql)) return input.media as T[]
        return [] as T[]
      },
      close: async () => {},
    }
    const loaded = await loadFloor(db)
    expect(sqls).toHaveLength(4)
    expect(loaded.records.map(r => r.rule_kind)).not.toContain('subject')
    const text = renderFloor(loaded)
    expect(text).not.toContain('synthetic: the angle is stale')
    expect(text).not.toContain('synthetic: nobody wants this topic')
    expect(Object.keys(parse(text).records)).toHaveLength(4)
    // The dry run before the migration renders what it read, subject records already left out (src/rejection/job.ts).
    expect(renderFloor({ ...loaded, standards: [], media: [] })).not.toContain('synthetic: the angle is stale')
  })

  // Bug: never_beneath and check_before_delivery are model text and are not scrubbed, so a claude.ai link or a
  // Drive id the model copied from a record's description reaches the public file (assertPublic misses both).
  it("shows a standard's statement and check with links and Drive ids taken out", () => {
    const input = floorInput()
    input.standards[2]!.statement = `Never reuse the card ${DRIVE_ID} again.`
    input.standards[2]!.how_to_check = 'Compare the cut with https://claude.ai/code/session_SYNTHETIC0001 before delivery.'
    const text = renderFloor(input)
    expect(text).not.toContain(DRIVE_ID)
    expect(text).not.toContain('claude.ai')
    const s = parse(text).standards[`s${'c'.repeat(10)}`]!
    expect(s.never_beneath).toBe('Never reuse the card [id] again.')
    expect(s.check_before_delivery).toBe('Compare the cut with [link] before delivery.')
  })

  // Bug: assertPublic runs on the JSON text, where a quote or a line break after "B:" is written B:\" or B:\n, and
  // reads as a drive letter, so a floor holding such words is never rendered.
  it('renders his words that hold a capital letter and a colon before a line break or a quote mark', () => {
    const input = floorInput()
    input.quotes[0] = vq(1, 'synthetic: two fixes, plan B:\nthe hook first, then "C:" on the card')
    const doc = parse(renderFloor(input))
    expect(doc.records[keyOf(doc, 'synthetic: a stock robot on the card')]!.his_words[0]!.said).toBe('synthetic: two fixes, plan B:\nthe hook first, then "C:" on the card')
  })
})

describe('proposing the floor to content-engine', () => {
  it('carries the closeout line and the hash line in the pull request body', () => {
    expect(FLOOR_CLOSEOUT_LINE.startsWith('Closeout: not needed,')).toBe(true)
    const lines = floorPullBody('synthetic-hash').split('\n')
    expect(lines).toContain(FLOOR_CLOSEOUT_LINE)
    expect(lines.at(-1)).toBe(hashLine('synthetic-hash'))
  })

  function stubGh(o: { base?: string | null; branch?: string | null; open?: number | null; closed?: Array<{ number: number; merged: boolean; body: string }> } = {}) {
    const resets: string[] = []
    const writes: Array<{ path: string; branch: string; text: string }> = []
    const created: Array<{ branch: string; base: string; body: string }> = []
    const updated: Array<{ pull: number; body: string }> = []
    const gh: GitHubApi = {
      async readFile(_path, ref) {
        const text = ref === 'main' ? o.base : o.branch
        return text == null ? null : { text, sha: `synthetic-sha-${ref}` }
      },
      async resetBranch(branch) { resets.push(branch) },
      async writeFile(path, branch, text) { writes.push({ path, branch, text }) },
      async openPull() { return o.open ?? null },
      async closedPulls() { return o.closed ?? [] },
      async createPull(branch, base, _title, body) { created.push({ branch, base, body }); return 41 },
      async updatePull(pull, body) { updated.push({ pull, body }) },
    }
    return { gh, resets, writes, created, updated }
  }
  const text = renderFloor(floorInput())
  const hash = contentHash([{ path: FLOOR_FILE, text }])

  it('opens one pull request on floor/rejections holding the file', async () => {
    const g = stubGh({ base: '{"synthetic":"older floor"}\n' })
    const r = await publishFloor(g.gh, text, true)
    expect(r).toEqual({ changed: 1, written: 1, pull: 41, declined: null })
    expect(FLOOR_BRANCH).toBe('floor/rejections')
    expect(g.resets).toEqual([FLOOR_BRANCH])
    expect(g.writes).toEqual([{ path: FLOOR_FILE, branch: FLOOR_BRANCH, text }])
    expect(g.created).toEqual([{ branch: FLOOR_BRANCH, base: 'main', body: floorPullBody(hash) }])
  })

  it('leaves an open pull request already holding the same file alone, writing only its body', async () => {
    const g = stubGh({ base: null, branch: text, open: 7 })
    const r = await publishFloor(g.gh, text, true)
    expect(r).toEqual({ changed: 1, written: 0, pull: 7, declined: null })
    expect(g.resets).toEqual([])
    expect(g.writes).toEqual([])
    expect(g.created).toEqual([])
    expect(g.updated).toEqual([{ pull: 7, body: floorPullBody(hash) }])
  })

  it('opens nothing on a dry run, when content-engine already holds the file, or when he declined it', async () => {
    const dry = stubGh({ base: null })
    expect(await publishFloor(dry.gh, text, false)).toMatchObject({ changed: 1, written: 0, pull: null })
    const same = stubGh({ base: text })
    expect(await publishFloor(same.gh, text, true)).toMatchObject({ changed: 0, written: 0, pull: null })
    const declined = stubGh({ base: null, closed: [{ number: 5, merged: false, body: floorPullBody(hash) }] })
    expect(await publishFloor(declined.gh, text, true)).toMatchObject({ written: 0, pull: null, declined: 5 })
    for (const g of [dry, same, declined]) expect([...g.resets, ...g.writes, ...g.created, ...g.updated]).toEqual([])
  })
})

describe('a session report of his words that dislikes something', () => {
  const report = (over: Partial<ReportEvidence> = {}): ReportEvidence => ({
    source_ref: 'synthetic-report-1', occurred_at: '2026-10-03T14:05:06Z', lane: 'production', title: 'synthetic: the thumbnail draft',
    excerpt: 'synthetic: the face is too small and the...',
    meta: { said_where: 'synthetic: a session on a thumbnail', full_text: 'synthetic: the face is too small and the title fights it', repository: 'synthetic/repo' },
    venture: 'publication',
    ...over,
  })

  it('files nothing without where he said it, his words, or a date', () => {
    expect(fileReportDislike(report({ meta: { full_text: 'synthetic: words with no place' } }))).toBeNull()
    expect(fileReportDislike(report({ meta: { said_where: '   ', full_text: 'synthetic: words' } }))).toBeNull()
    expect(fileReportDislike(report({ meta: { said_where: 42, full_text: 'synthetic: words' } }))).toBeNull()
    expect(fileReportDislike(report({ excerpt: null, meta: { said_where: 'synthetic: a session' } }))).toBeNull()
    expect(fileReportDislike(report({ occurred_at: 'synthetic: not a date' }))).toBeNull()
  })

  it('files his whole words from meta.full_text over a cut excerpt, as his words, to the second', () => {
    const f = fileReportDislike(report())!
    expect(f.quote).toMatchObject({
      text: 'synthetic: the face is too small and the title fights it', attribution: 'krish_words', source: 'session_report',
      precision: 'second', saidAt: '2026-10-03T14:05:06.000Z', saidWhere: 'synthetic: a session on a thumbnail',
      key: quoteKey('synthetic: the face is too small and the title fights it', '2026-10-03'),
    })
    expect(f.record).toMatchObject({ source: 'session_report', sourceRef: 'synthetic-report-1', kind: 'rejected', quoteKeys: [f.quote.key], ruleKind: 'form', capture: 'words' })
    expect(f.record.formats).toEqual(['thumbnail'])
    // Without a full text, the excerpt is what there is.
    expect(fileReportDislike(report({ meta: { said_where: 'synthetic: a session' } }))!.quote.text).toBe('synthetic: the face is too small and the...')
    // His words are never cut to fit.
    const long = `synthetic: ${'the hook drags '.repeat(400).trim()}`
    expect(fileReportDislike(report({ meta: { said_where: 'synthetic: a session', full_text: long } }))!.quote.text).toBe(long)
  })

  it('keeps a strategy-lane dislike as a subject record, never a standard', () => {
    expect(fileReportDislike(report({ lane: 'strategy' }))!.record.ruleKind).toBe('subject')
    expect(fileReportDislike(report({ lane: 'visibility' }))!.record.ruleKind).toBe('subject')
    expect(fileReportDislike(report({ lane: 'voice' }))!.record.ruleKind).toBe('form')
  })

  it('keeps a dislike about an idea or a card as subject, unless his words name the craft they fault', () => {
    const about = (ref: string, words: string) => fileReportDislike(report({
      title: 'synthetic idea: why a synthetic tariff reshapes a synthetic supply chain',
      meta: { said_where: 'synthetic: a session', full_text: words, subject_ref: ref },
    }))!.record
    expect(about('idea:synthetic-1', 'synthetic: nobody wants this').ruleKind).toBe('subject')
    expect(about('card:synthetic-2', 'synthetic: not this one').ruleKind).toBe('subject')
    expect(about('idea:synthetic-1', 'synthetic: the captions cover his mouth').ruleKind).toBe('form')
    expect(about('piece:synthetic-3', 'synthetic: nobody wants this').ruleKind).toBe('form')
  })

  it('counts his words as naming a craft only by a craft he names, never by "video", "story", "line" or "cost"', () => {
    const about = (words: string, lane = 'voice') => fileReportDislike(report({
      lane, title: 'synthetic idea: why a synthetic tariff reshapes a synthetic supply chain',
      meta: { said_where: 'synthetic: a session', full_text: words, subject_ref: 'idea:synthetic-1' },
    }))!.record
    for (const words of ['synthetic: who would watch a video about this, skip it', 'synthetic: same narrative as last week, skip it',
      'synthetic: this line of thinking costs too much', 'synthetic: the question is boring', 'synthetic: not this card']) {
      expect(about(words).ruleKind, words).toBe('subject')
    }
    // A craft he names is form, and binds that maker, not every maker.
    expect(about('synthetic: the captions cover his mouth').formats).toEqual(['captions'])
    const script = fileReportDislike(report({ title: null, meta: { said_where: 'synthetic: a session', full_text: 'synthetic: the script reads like an advert' } }))!.record
    expect(script).toMatchObject({ ruleKind: 'form', formats: ['script'] })
  })

  it('never shows the session\'s subject line as what was rejected: only his words', () => {
    const r = fileReportDislike(report())!.record
    expect(r.item).toBeNull()
    expect(r.formats).toEqual(['thumbnail'])
  })
})

describe('a capture from the inbox', () => {
  const capture = (over: Partial<InboxRow & { venture: string }> = {}): InboxRow & { venture: string } => ({
    id: UUID(700), kind: 'rejected', said: 'synthetic: that join clips the word', said_where: 'synthetic: a capture in a session',
    said_at: '2026-10-04T08:00:00Z', piece: 'synthetic: short cut one', formats: [], note: null, screenshot_b64: null, screenshot_mime: null,
    master_drive_id: null, master_sha256: null, at_ms: null, whole_cut: false, repository: 'synthetic/repo', session_ref: 'synthetic-session',
    reported_at: '2026-10-04T08:05:00Z', venture: 'publication',
    ...over,
  })

  it('keeps a screenshot as a still, a moment he named as his, and a whole cut by its master', () => {
    expect(fileCapture(capture({ screenshot_b64: 'c3ludGhldGlj', screenshot_mime: 'image/png', at_ms: 1200 })).record.capture).toBe('still')
    const moment = fileCapture(capture({ at_ms: 12345, master_drive_id: DRIVE_ID })).record
    expect(moment.capture).toBe('moment')
    expect(moment.moment).toEqual({ ms: 12345, anchor: null, origin: 'krish' })
    const whole = fileCapture(capture({ whole_cut: true, master_drive_id: DRIVE_ID })).record
    expect(whole.capture).toBe('whole_cut')
    expect(whole.moment).toBeNull()
    expect(whole.media.masters).toEqual([{ where: 'drive_id', ref: DRIVE_ID }])
    expect(fileCapture(capture()).record.capture).toBe('words')
  })

  it('keeps the formats it named that are in the vocabulary, and reads the rest from the piece', () => {
    expect(fileCapture(capture({ formats: ['synthetic_format', 'cover', 'cover', 'other'] })).record.formats).toEqual(['cover'])
    expect(fileCapture(capture({ formats: ['thumbnail', 'audio'] })).record.formats).toEqual(['audio', 'thumbnail'])
    expect(fileCapture(capture({ formats: ['synthetic_format'], piece: 'synthetic: a thumbnail draft', said: 'synthetic: the face is lost' })).record.formats).toEqual(['thumbnail'])
  })

  // Bug: `f in FORMATS` is true for any Object.prototype name, so 'constructor' is kept as a format.
  it('ignores a named format that is only a name on Object.prototype', () => {
    expect(fileCapture(capture({ formats: ['constructor', 'cover'] })).record.formats).toEqual(['cover'])
  })
})

describe('the rejections counters in the public log', () => {
  it('keeps a rejections_ counter and drops any text', () => {
    expect(safeFields({ rejections_floor_bytes: 2048, rejections_distil_failed: 0 })).toEqual({ rejections_floor_bytes: 2048, rejections_distil_failed: 0 })
    expect(safeFields({ rejections_statement: 'synthetic: a standard', rejections_said: 'synthetic: his words', statement: 'synthetic: a claim' })).toEqual({})
  })
})
