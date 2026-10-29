import { describe, it, expect } from 'vitest'
import { NEVERS, sortStandard, type Sortable } from '../src/rejection/layers.ts'
import { renderFloor, type StandardRow } from '../src/rejection/render.ts'

// His three layers: the floor (his eight nevers), aims, and dated examples. Synthetic statements only.
const st = (statement: string, o: Partial<Sortable> = {}): Sortable =>
  ({ theme: 'other', layer: null, kind: 'form', statement, how_to_check: 'synthetic: look.', ...o })

describe('sortStandard', () => {
  it('puts a standard that names one of his nevers under it', () => {
    const cases: Array<[string, string]> = [
      ['Never include two separate intro sequences in one cut.', 'one_opening_one_close'],
      ['Always end on one closing screen; never stack multiple outro screens.', 'one_opening_one_close'],
      ['Never cut edits mid-word so that words are clipped or chopped.', 'every_word_in_sync'],
      ['Never let picture and voice drift out of sync.', 'every_word_in_sync'],
      ["Never mention Krish's name in the copy.", 'his_name'],
      ['Never add eyebrow kickers or asterisks to a card.', 'empty_labels'],
      ['Never write em dashes in on-screen text.', 'no_em_dash_no_preaching'],
      ['Never close on a lesson for leaders or preach.', 'no_em_dash_no_preaching'],
      ['Never redraw a company logo; use the official mark.', 'real_marks_with_rights'],
      ['Always use properly licensed imagery with its source recorded.', 'real_marks_with_rights'],
      ['Never show a made-up number.', 'nothing_made_up'],
      ['Never show statistics without crediting their producer.', 'nothing_made_up'],
    ]
    for (const [statement, never] of cases) expect(sortStandard(st(statement)), statement).toMatchObject({ layer: 'floor', never })
  })
  it('keeps visual misalignment, a licensed music bed and a dash in the engine\'s own words off the floor', () => {
    expect(sortStandard(st('Never misalign text blocks on a card.', { theme: 'layout', layer: 'graphics' }))).toMatchObject({ layer: 'aim' })
    expect(sortStandard(st('Always keep a licensed music bed under the voice.', { theme: 'edit_av', layer: 'editing' }))).toMatchObject({ layer: 'example' })
  })
  it('makes the qualities he named aims, and everything else a dated example', () => {
    expect(sortStandard(st('Use the brand colours on every card.', { theme: 'brand' }))).toMatchObject({ layer: 'aim', rule: 'aim:theme:brand' })
    expect(sortStandard(st('Use motion that explains.', { theme: 'decorative_motion' }))).toMatchObject({ layer: 'aim' })
    expect(sortStandard(st('Keep cards in the graphics grid.', { layer: 'graphics' }))).toMatchObject({ layer: 'aim', rule: 'aim:layer:graphics' })
    expect(sortStandard(st('Keep the title short.', { theme: 'packaging', layer: 'packaging' }))).toEqual({ layer: 'example', never: null, rule: 'example' })
  })
  it('never makes how a session works with him a taste never, unless it is about going out without his yes', () => {
    expect(sortStandard(st('Never cut his words mid-word in the edit.', { kind: 'workflow', theme: 'process' }))).toMatchObject({ layer: 'example' })
    expect(sortStandard(st('Never schedule a post without his yes.', { kind: 'workflow', theme: 'process' }))).toMatchObject({ layer: 'floor', never: 'nothing_goes_out_without_him' })
    expect(sortStandard(st('Brand the board.', { kind: 'workflow', theme: 'brand' }))).toMatchObject({ layer: 'example' })
  })
})

describe('the floor file in his three layers', () => {
  const row = (fp: string, statement: string, standing: StandardRow['standing'], o: Partial<StandardRow> = {}): StandardRow => ({
    id: fp, fingerprint: fp.padEnd(32, '0'), formats: ['short_video'], theme: 'structure', layer: 'opening', kind: 'form', standing,
    statement, how_to_check: 'synthetic: watch the opening.', krish: null, support_n: 1, action_n: 0, quote_ids: [], record_refs: [],
    boundary_quote_ids: [], decided_at: standing === 'draft' ? null : '2026-10-29T10:00:00Z', ...o,
  })
  const doc = JSON.parse(renderFloor({
    standards: [
      row('aaaaaaaaaa', 'synthetic: never two intro sequences in one cut.', 'approved'),
      row('bbbbbbbbbb', 'synthetic: never stack multiple outro screens.', 'draft'),
      row('cccccccccc', 'synthetic: use the brand colours.', 'approved', { theme: 'brand', layer: 'packaging' }),
      row('dddddddddd', 'synthetic: keep the title short.', 'approved', { theme: 'packaging', layer: 'packaging' }),
    ],
    records: [], quotes: [], media: [],
  }))
  it('lists exactly his eight nevers, in his order, as the floor', () => {
    expect(doc.floor.nevers.map((n: { id: string }) => n.id)).toEqual(NEVERS.map(n => n.id))
    expect(doc.floor.nevers[6]).toEqual({ id: 'one_opening_one_close', listed: 'one opening, one close', standards: ['saaaaaaaaaa', 'sbbbbbbbbbb'], blocking: ['saaaaaaaaaa'] })
  })
  it('lets only a floor standard he approved block; aims and examples never do', () => {
    expect(doc.standards.saaaaaaaaaa).toMatchObject({ taste_layer: 'floor', never: 'one_opening_one_close', blocks: true, layer: 'opening' })
    expect(doc.standards.sbbbbbbbbbb).toMatchObject({ taste_layer: 'floor', blocks: false })
    expect(doc.standards.scccccccccc).toMatchObject({ taste_layer: 'aim', blocks: false })
    expect(doc.standards.sdddddddddd).toMatchObject({ taste_layer: 'example', blocks: false })
    expect(doc.aims).toEqual(['scccccccccc'])
    expect(doc.examples).toEqual(['sdddddddddd'])
    expect(doc.formats.short_video).toMatchObject({ blocking: ['saaaaaaaaaa'], aims: ['scccccccccc'], examples: ['sdddddddddd'] })
    expect(doc.counts).toMatchObject({ floor: 2, aims: 1, examples: 1, blocking: 1 })
  })
})
