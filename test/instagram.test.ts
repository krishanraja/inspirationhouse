import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { loadConfig } from '../src/config.ts'
import { serviceAccount } from '../src/google.ts'
import { postEvidence, themeEvidence, workbookRows } from '../src/collect/instagram.ts'

// Synthetic rows only: invented accounts, posts and themes.
const AT = '2026-10-22T05:17:00.000Z'
const POSTS = [
  ['Posts Instagram inspo'],
  ['One row per post.'],
  ['Post ID', 'Published (UTC)', 'Type', 'Headline', 'Faithful summary', 'Time horizon', 'Post URL', 'Account'],
  ['AbCdEf12345', '2026-10-13 21:32', 'Carousel', 'A lab ships a new model', 'The post says a lab shipped a model.', 'Now', 'https://example.invalid/p/AbCdEf12345/', 'example.account'],
  ['', '', '', 'a note row with no id', '', '', '', ''],
]
const THEMES = [
  ['Themes Instagram inspo'],
  ['Theme', 'What they are saying', 'Direction', 'Supporting source URLs', 'Evidence caveat'],
  ['Agents at work', 'Systems act inside tools.', 'Execution makes recovery a product requirement.', 'https://example.invalid/p/1/', 'Mostly demos.'],
]

describe('the Instagram workbook', () => {
  it('reads one observation per post, keyed by post id, never as his words', () => {
    const [e, ...rest] = postEvidence(POSTS, AT)
    expect(rest).toHaveLength(0)
    expect(e).toMatchObject({
      source: 'drive_cold', sourceRef: 'instagram:AbCdEf12345', attribution: 'observation', polarity: 'neutral',
      lane: 'strategy', layer: null, occurredAt: '2026-10-13T21:32:00.000Z', title: 'A lab ships a new model',
    })
    expect(e!.meta).toMatchObject({ kind: 'instagram_post', account: 'example.account', type: 'Carousel' })
  })

  it('reads themes as machine inference, which never counts toward a claim', () => {
    const [t] = themeEvidence(THEMES, AT)
    expect(t).toMatchObject({ sourceRef: 'instagram-theme:agents-at-work', attribution: 'machine_inference', occurredAt: AT })
    expect(t!.excerpt).toBe('Execution makes recovery a product requirement.')
  })

  it('reads nothing from a tab that is not one of the two', () => {
    expect(postEvidence(THEMES, AT)).toEqual([])
    expect(themeEvidence(POSTS, AT)).toEqual([])
  })

  it.each([['relative part paths, shared strings', false], ['absolute part paths, prefixed tags', true]])('reads every tab of an .xlsx with %s', (_, odd) => {
    const tabs = workbookRows(xlsx([['Themes', THEMES], ['Posts', POSTS]], odd as boolean))
    expect(tabs).toHaveLength(2)
    expect(tabs.flatMap(r => postEvidence(r, AT)).map(e => e.sourceRef)).toEqual(['instagram:AbCdEf12345'])
    expect(tabs.flatMap(r => themeEvidence(r, AT))).toHaveLength(1)
  })
})

// A minimal workbook written two ways: Excel's (relative targets, shared
// strings, unprefixed tags) and the other writers' (absolute targets, inline
// `str` cells, an `x:` prefix), the shape of the real Instagram file.
function xlsx(tabs: Array<[string, string[][]]>, odd: boolean): Uint8Array {
  const p = odd ? 'x:' : ''
  const ns = `xmlns${odd ? ':x' : ''}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
  const shared: string[] = []
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const col = (i: number) => String.fromCharCode(65 + i)
  const files: Record<string, Uint8Array> = {}
  tabs.forEach(([, rows], n) => {
    const body = rows.map((r, ri) => `<${p}row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${col(ci)}${ri + 1}`
      if (!v) return `<${p}c r="${ref}" />`
      if (odd) return `<${p}c r="${ref}" t="str"><${p}v>${esc(v)}</${p}v></${p}c>`
      shared.push(v)
      return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`
    }).join('')}</${p}row>`).join('')
    files[`xl/worksheets/sheet${n + 1}.xml`] = strToU8(`<${p}worksheet ${ns}><${p}sheetData>${body}</${p}sheetData></${p}worksheet>`)
  })
  const target = (t: string) => (odd ? `/xl/${t}` : t)
  files['_rels/.rels'] = strToU8(`<Relationships><Relationship Id="r1" Target="${odd ? '/xl/workbook.xml' : 'xl/workbook.xml'}" /></Relationships>`)
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${tabs.map((_, n) => `<Relationship Id="s${n}" Target="${target(`worksheets/sheet${n + 1}.xml`)}" />`).join('')}<Relationship Id="ss" Target="${target('sharedStrings.xml')}" /></Relationships>`)
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${shared.map(v => `<si><t>${esc(v)}</t></si>`).join('')}</sst>`)
  files['xl/workbook.xml'] = strToU8(`<${p}workbook ${ns}><${p}sheets>${tabs.map(([name], n) => `<${p}sheet name="${name}" sheetId="${n + 1}" r:id="s${n}" />`).join('')}</${p}sheets></${p}workbook>`)
  return zipSync(files)
}

describe('the Google service account secret', () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  it('takes the whole JSON key file, email included', () => {
    const json = JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', private_key: pem })
    const sa = serviceAccount(loadConfig({ GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: json }))
    expect(sa).toEqual({ email: 'reader@example.iam.gserviceaccount.com', key: pem })
  })

  it('still takes a bare PEM with escaped newlines beside an email', () => {
    const sa = serviceAccount(loadConfig({
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'reader@example.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
    }))
    expect(sa?.key).toBe(pem)
  })

  it('is not configured without a key, and says so plainly on a broken file', () => {
    expect(serviceAccount(loadConfig({}))).toBeNull()
    expect(() => serviceAccount(loadConfig({ GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '{"type":' }))).toThrow(/does not parse/)
  })
})
