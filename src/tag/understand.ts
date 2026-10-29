import type { Db } from '../db.ts'
import type { DriveFile } from '../google.ts'

// The understanding pass (Wave 3, W3.2): what content-watcher measured of a card's file, as production tags on the
// card, and the stills it curated, as machine signals. No model is called. Each tag is a rule over what was measured
// (content-engine content_reads.read: the hook, the pace, the faces, the shots, the camera moves, the audio, the
// video's shape), so it is labelled measured, the machine's, never his and never taste evidence: it says how a thing he
// saved is made, so his page and the readers can sort by it. The topics stay the tagger's (facets.topics, a guess).
//
// Machine stills (content-watcher docs/READ_FORMAT.md, "Machine stills"): at most 8 curated stills per video reading,
// in a machine-owned folder outside his tree, tagged machine. They reach this engine only as the reading's
// machine_stills block, kept on the card as machine signals. They are never his inputs: a Drive file whose bytes are a
// machine still is never made a card and never taken as his action (inspirationTree in src/collect/drive.ts), whatever
// folder it turns up in.

/** Bump when a rule below changes what a reading is tagged. */
export const UNDERSTAND_REV = 'understand-2026-10-29'

type Read = Record<string, unknown>
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The production tags a reading measures. Pure: the same reading always gives the same tags, sorted. */
export function productionTags(read: Read): string[] {
  const tags = new Set<string>()
  const video = obj(read.video)
  const aspect = typeof video?.aspect === 'string' ? video.aspect : null
  if (aspect && /^\d{1,2}:\d{1,2}$/.test(aspect)) tags.add(`aspect:${aspect.replace(':', '_')}`)
  const faces = obj(read.faces)
  const onFace = num(faces?.share_on_face)
  if (faces?.available === true && onFace !== null) tags.add(onFace >= 0.5 ? 'on_camera' : onFace === 0 ? 'faceless' : 'partly_on_camera')
  if (typeof faces?.framing === 'string' && /^[a-z_]{2,20}$/.test(faces.framing)) tags.add(`framing:${faces.framing}`)
  const shots = obj(read.shots)
  const cpm = num(shots?.cuts_per_min)
  if (cpm !== null) tags.add(cpm === 0 ? 'single_take' : cpm >= 20 ? 'fast_cutting' : cpm >= 6 ? 'steady_cutting' : 'few_cuts')
  const moves = Array.isArray(read.camera_moves) ? read.camera_moves : []
  for (const m of moves) {
    const kind = obj(m)?.kind
    if (typeof kind === 'string' && /^[a-z_]{2,20}$/.test(kind)) tags.add(`move:${kind}`)
  }
  const hook = obj(read.hook)
  if (hook?.face_on_screen === true) tags.add('hook:face')
  if ((num(hook?.cuts) ?? 0) > 0) tags.add('hook:cut')
  if (Array.isArray(hook?.screen_text) && hook.screen_text.length) tags.add('hook:words_on_screen')
  const pace = obj(read.pace)
  const speech = num(pace?.speech_share)
  const bed = num(pace?.sound_without_words_share)
  if (speech !== null && speech >= 0.8) tags.add('talk_led')
  else if (bed !== null && bed >= 0.5) tags.add('sound_led')
  const wpm = num(pace?.words_per_min)
  if (wpm !== null) tags.add(wpm >= 190 ? 'speech:fast' : wpm <= 120 ? 'speech:slow' : 'speech:even')
  if (shots && Array.isArray(shots.list) && shots.list.some(s => Array.isArray(obj(s)?.screen_text) && (obj(s)!.screen_text as unknown[]).length)) tags.add('words_on_screen')
  if (typeof read.shape === 'string' && /^(video|image|carousel)$/.test(read.shape)) tags.add(`shape:${read.shape}`)
  return [...tags].sort()
}

export interface MachineStills { count: number; still_sha256: string[]; tags: string[] }

/** A reading's machine stills, when it carries them: always the machine's, whatever the block says of itself. */
export function machineStillsOf(read: Read): MachineStills | null {
  const block = obj(read.machine_stills)
  if (!block) return null
  const items = Array.isArray(block.items) ? block.items : []
  const shas = items.map(i => obj(i)?.still_sha256).filter((s): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))
  const tags = new Set<string>()
  for (const i of items) for (const t of (Array.isArray(obj(i)?.tags) ? obj(i)!.tags as unknown[] : [])) if (typeof t === 'string' && t !== 'machine' && /^[a-z0-9:_-]{1,40}$/.test(t)) tags.add(t)
  return { count: Math.min(8, shas.length), still_sha256: [...new Set(shas)].slice(0, 8).sort(), tags: [...tags].sort() }
}

/** Every machine still's sha256 in content-watcher's readings: bytes that are never his, wherever they turn up. */
export async function machineStillShas(db: Db): Promise<Set<string>> {
  const [reg] = await db.query<{ ok: boolean }>(`select to_regclass('public.content_reads') is not null as ok`)
  if (!reg?.ok) return new Set()
  const rows = await db.query<{ sha: string }>(
    `select distinct lower(i->>'still_sha256') as sha
     from public.content_reads c, jsonb_array_elements(case when jsonb_typeof(c.read->'machine_stills'->'items') = 'array'
                                                          then c.read->'machine_stills'->'items' else '[]'::jsonb end) i
     where i->>'still_sha256' ~ '^[A-Fa-f0-9]{64}$'`,
  )
  return new Set(rows.map(r => r.sha))
}

export interface UnderstandResult { read: number; understood: number; stills: number }

/**
 * Put each card's production tags and machine stills on its facets, from the reading of its file, where the reading
 * is there and the card does not already hold this revision's. A dry run counts. Only the facets' understanding and
 * machine_stills keys are written: nothing he answered and nothing the tagger guessed is touched.
 */
export async function understandCards(db: Db, files: Map<string, DriveFile>, write: boolean): Promise<UnderstandResult> {
  const result: UnderstandResult = { read: 0, understood: 0, stills: 0 }
  const [reg] = await db.query<{ ok: boolean }>(`select to_regclass('public.content_reads') is not null as ok`)
  if (!reg?.ok) return result
  const bySha = new Map([...files.values()].filter(f => f.sha256Checksum).map(f => [f.sha256Checksum!.toLowerCase(), f.id]))
  if (!bySha.size) return result
  const reads = await db.query<{ sha256: string; read: Read }>(
    `select lower(sha256) as sha256, read from public.content_reads where lower(sha256) = any(select jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify([...bySha.keys()])],
  )
  const rows: Array<{ drive_file_id: string; understanding: object; machine_stills: object | null }> = []
  for (const r of reads) {
    const fileId = bySha.get(r.sha256)
    if (!fileId) continue
    result.read++
    const stills = machineStillsOf(r.read)
    if (stills) result.stills++
    rows.push({
      drive_file_id: fileId,
      understanding: { rev: UNDERSTAND_REV, origin: 'measured', by: 'content-watcher reading, tagged by rule', production: productionTags(r.read) },
      machine_stills: stills ? { owner: 'machine', counts_as_his: false, ...stills } : null,
    })
  }
  if (!rows.length) return result
  const changed = await db.query<{ n: number }>(
    `${write ? 'with up as (update public.inspiration_items i set facets = i.facets || jsonb_build_object(\'understanding\', x.understanding)'
      + ' || case when x.machine_stills is null then \'{}\'::jsonb else jsonb_build_object(\'machine_stills\', x.machine_stills) end, updated_at = now()' : 'with up as (select 1 from public.inspiration_items i'}
     ${write ? 'from' : ','} jsonb_to_recordset($1::jsonb) as x(drive_file_id text, understanding jsonb, machine_stills jsonb)
     where i.drive_file_id = x.drive_file_id
       and (i.facets->'understanding' is distinct from x.understanding
            or (x.machine_stills is not null and i.facets->'machine_stills' is distinct from x.machine_stills))
     ${write ? 'returning 1' : ''})
     select count(*)::int as n from up`,
    [JSON.stringify(rows)],
    write ? { write: true } : undefined,
  )
  result.understood = Number(changed[0]?.n ?? 0)
  return result
}
