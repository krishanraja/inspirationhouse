import { unzipSync, strFromU8 } from 'fflate'

// Every tab of an .xlsx workbook as rows of cell text, in tab order.
//
// Small on purpose: it reads cell values and nothing else (no styles, no
// formulas, no dates by format). It follows the package's own relationships,
// so it reads both Excel's relative part paths and the absolute ones other
// writers use (the Instagram workbook is one: exceljs could not open it).

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

// Tags may carry a namespace prefix (`x:c`) or none (`c`).
const tag = (name: string) => `(?:\\w+:)?${name}`

function texts(xml: string): string {
  const out: string[] = []
  for (const m of xml.matchAll(new RegExp(`<${tag('t')}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag('t')}>`, 'g'))) out.push(decode(m[1]!))
  return out.join('')
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function resolve(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

function relationships(files: Record<string, Uint8Array>, part: string): Map<string, string> {
  const dir = part.split('/').slice(0, -1).join('/')
  const name = part.split('/').pop()
  const rels = files[`${dir ? `${dir}/` : ''}_rels/${name}.rels`]
  const map = new Map<string, string>()
  if (!rels) return map
  for (const m of strFromU8(rels).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]!)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(m[1]!)?.[1]
    if (id && target) map.set(id, resolve(part, decode(target)))
  }
  return map
}

export function readXlsx(bytes: Uint8Array): Array<{ name: string; rows: string[][] }> {
  const files = unzipSync(bytes)
  const rootRels = relationships(files, '')
  const workbookPart = [...rootRels.values()].find(p => /workbook\.xml$/.test(p)) ?? 'xl/workbook.xml'
  const workbook = files[workbookPart]
  if (!workbook) throw new Error('xlsx: no workbook part')
  const rels = relationships(files, workbookPart)

  const sharedPart = [...rels.values()].find(p => /sharedStrings\.xml$/.test(p))
  const shared: string[] = []
  if (sharedPart && files[sharedPart]) {
    for (const m of strFromU8(files[sharedPart]!).matchAll(new RegExp(`<${tag('si')}>([\\s\\S]*?)</${tag('si')}>`, 'g'))) shared.push(texts(m[1]!))
  }

  const sheets: Array<{ name: string; rows: string[][] }> = []
  for (const m of strFromU8(workbook).matchAll(new RegExp(`<${tag('sheet')}\\b([^>]*)/?>`, 'g'))) {
    const name = decode(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? '')
    const rid = /\br:id="([^"]+)"/.exec(m[1]!)?.[1] ?? /\b\w+:id="([^"]+)"/.exec(m[1]!)?.[1]
    const part = rid ? rels.get(rid) : undefined
    const xml = part && files[part] ? strFromU8(files[part]!) : null
    if (!xml) continue
    const rows: string[][] = []
    for (const r of xml.matchAll(new RegExp(`<${tag('row')}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${tag('row')}>)`, 'g'))) {
      const cells: string[] = []
      for (const c of (r[1] ?? '').matchAll(new RegExp(`<${tag('c')}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag('c')}>)`, 'g'))) {
        const attrs = c[1]!
        const body = c[2] ?? ''
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
        const type = /\bt="(\w+)"/.exec(attrs)?.[1]
        const v = new RegExp(`<${tag('v')}>([\\s\\S]*?)</${tag('v')}>`).exec(body)?.[1]
        let text = ''
        if (type === 's') text = shared[Number(v)] ?? ''
        else if (type === 'inlineStr') text = texts(body)
        else if (v !== undefined) text = decode(v)
        const at = ref ? columnIndex(ref) : cells.length
        cells[at] = text
      }
      if (cells.some(c => c && c.trim())) rows.push(Array.from(cells, c => c ?? ''))
    }
    sheets.push({ name, rows })
  }
  return sheets
}
