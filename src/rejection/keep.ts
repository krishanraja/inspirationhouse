import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DRIVE } from '../config.ts'
import type { Db } from '../db.ts'
import { FOLDER_MIME, type DriveFile, type Google } from '../google.ts'
import type { MasterRef, RecordRow } from './file.ts'
import { CUT_REV, cutMoment, keepStill, keepStrip, stripAcross, type Kept } from './media.ts'

// The media stage: for each standing record, keep what its plan names (src/rejection/file.ts mediaOf). A still or a
// strip already in the folder is fetched and kept as an image. A moment is cut from a master the engine can reach,
// and the master is deleted from the runner the moment the cut is made. A whole cut is pointed at by its master's
// Drive id. Nothing already kept is fetched again: media is found by the Drive file it came from and the recipe.
// Every outcome is counted; none fails the run except an error the engine could not explain.

/** A master larger than this is never fetched (the largest he rejected so far is about 1 GB). */
export const MASTER_MAX_BYTES = 1_200_000_000
const STILL_MAX_BYTES = 5_000_000
/** How many masters one run fetches, and when it stops starting new ones: the job is cancelled at 30 minutes. */
export const MASTERS_PER_RUN = 8
export const KEEP_BUDGET_MS = 18 * 60_000

export interface KeepResult {
  stills: number; strips: number; clips: number; reused: number
  missing: number; unreachableLocal: number; gone: number; unresolved: number; noMoment: number
  masters: number; tooBig: number; deferred: number; pointed: number; failed: number
  failures: Record<string, number>
}

export interface KeepDeps {
  now?: () => number
  cut?: typeof cutMoment
  across?: typeof stripAcross
}

const empty = (): KeepResult => ({
  stills: 0, strips: 0, clips: 0, reused: 0, missing: 0, unreachableLocal: 0, gone: 0, unresolved: 0, noMoment: 0,
  masters: 0, tooBig: 0, deferred: 0, pointed: 0, failed: 0, failures: {},
})

/**
 * Turns an H:\My Drive\... path into the file's Drive id by walking the folders the engine is shared on, one name at
 * a time, from the nearest root it knows. A name two files share, or a path under no known root, is never guessed.
 */
export function pathResolver(google: Pick<Google, 'listFolder'>) {
  const listings = new Map<string, Promise<DriveFile[]>>()
  const list = (id: string) => {
    if (!listings.has(id)) listings.set(id, google.listFolder(id))
    return listings.get(id)!
  }
  const roots: Array<[RegExp, string]> = [
    [/^[A-Z]:\\My Drive\\Ventures\\Active Ventures\\makeyourmindup\\3 Posts\\/i, DRIVE.posts],
    [/^[A-Z]:\\My Drive\\Ventures\\Active Ventures\\makeyourmindup\\Video Engine\\Archive\\/i, DRIVE.archive],
    [/^[A-Z]:\\My Drive\\Ventures\\Active Ventures\\makeyourmindup\\Video Engine\\Rejections\\/i, DRIVE.rejections],
  ]
  return async (path: string): Promise<{ file: DriveFile; root: string } | 'ambiguous' | null> => {
    const root = roots.find(([re]) => re.test(path))
    if (!root) return null
    const parts = path.replace(root[0], '').split('\\').filter(Boolean)
    let folder = root[1]
    for (const [i, name] of parts.entries()) {
      const matches = (await list(folder)).filter(f => f.name === name)
      if (matches.length > 1) return 'ambiguous'
      const next = matches[0]
      if (!next) return null
      if (i === parts.length - 1) return next.mimeType === FOLDER_MIME ? null : { file: next, root: root[1] }
      if (next.mimeType !== FOLDER_MIME) return null
      folder = next.id
    }
    return null
  }
}

interface Held { sha256: string; role: string }

async function heldFrom(db: Db, driveId: string, role: string): Promise<Held[]> {
  return db.query<Held>(
    `select sha256, role from public.taste_rejection_media where derived_from = $1 and role = $2 and cut_rev = $3`,
    [driveId, role, CUT_REV],
  )
}

/** What was already cut from a master: around this moment, or (at null) across the whole cut. */
async function heldMedia(db: Db, driveId: string, roles: string[], atMs: number | null): Promise<Held[]> {
  return db.query<Held>(
    `select sha256, role from public.taste_rejection_media
     where derived_from = $1 and role = any($2::text[]) and cut_rev = $3 and at_ms is not distinct from $4`,
    [driveId, roles, CUT_REV, atMs],
  )
}

export async function insertMedia(db: Db, k: Kept, derivedFrom: string | null, derivedSha: string | null): Promise<void> {
  await db.query(
    `insert into public.taste_rejection_media
       (sha256, role, mime, bytes, width, height, duration_ms, at_ms, window_from_ms, window_to_ms, frames_n,
        derived_from, derived_from_sha256, cut_rev)
     values ($1, $2, $3, decode($4, 'base64'), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (sha256) do nothing`,
    [k.sha256, k.role, k.mime, k.bytes.toString('base64'), k.width, k.height, k.durationMs, k.atMs, k.windowFromMs,
      k.windowToMs, k.framesN, derivedFrom, derivedSha, CUT_REV],
    { write: true },
  )
}

export async function attachMedia(db: Db, r: Pick<RecordRow, 'source' | 'sourceRef' | 'version'>, hashes: string[]): Promise<void> {
  if (!hashes.length) return
  await db.query(
    `update public.taste_rejections
     set media_sha256 = array(select distinct h from unnest(media_sha256 || $4::text[]) as h order by h)
     where source = $1 and source_ref = $2 and source_version = $3
       and not (media_sha256 @> $4::text[])`,
    [r.source, r.sourceRef, r.version, hashes],
    { write: true },
  )
}

async function pointAt(db: Db, r: RecordRow, driveId: string): Promise<boolean> {
  const done = await db.query<{ id: string }>(
    `update public.taste_rejections set master_drive_id = $4
     where source = $1 and source_ref = $2 and source_version = $3 and master_drive_id is distinct from $4
     returning id::text`,
    [r.source, r.sourceRef, r.version, driveId],
    { write: true },
  )
  return done.length > 0
}

const failClass = (err: unknown): string => {
  const m = String((err as Error)?.message ?? '')
  if (/size cap/.test(m)) return 'too_big'
  if (/HTTP 40[34]/.test(m)) return 'no_access'
  if (/does not fit/.test(m)) return 'cap'
  if (/no picture|states no length/.test(m)) return 'no_picture'
  return (err as Error)?.name === 'Error' ? 'cut' : String((err as Error)?.name ?? 'cut').slice(0, 20).toLowerCase()
}

/**
 * Keep the media of every record in the read. On a dry run, nothing is fetched or written: the plan is counted,
 * and the master paths are resolved (a read), so a dry run proves what a real run would reach.
 */
export async function keepMedia(
  db: Db, google: Google, records: RecordRow[], files: Map<string, DriveFile>, write: boolean, deps: KeepDeps = {},
): Promise<KeepResult> {
  const out = empty()
  const now = deps.now ?? Date.now
  const started = now()
  const cut = deps.cut ?? cutMoment
  const across = deps.across ?? stripAcross
  const resolve = pathResolver(google)
  const fail = (err: unknown) => { out.failed++; const c = failClass(err); out.failures[c] = (out.failures[c] ?? 0) + 1 }

  for (const r of records) {
    const hashes: string[] = []
    // Stills and strips already in the folder.
    for (const [paths, role] of [[r.media.stills, 'screenshot'], [r.media.strips, 'strip']] as const) {
      for (const path of paths) {
        const f = files.get(path)
        if (!f) { out.missing++; continue }
        const held = await heldFrom(db, f.id, role).catch(() => [])
        if (held.length) { hashes.push(...held.map(h => h.sha256)); out.reused++; continue }
        if (!write) { role === 'strip' ? out.strips++ : out.stills++; continue }
        try {
          const bytes = await google.download(f.id, STILL_MAX_BYTES)
          const k = role === 'strip' ? await keepStrip(bytes) : await keepStill(bytes)
          await insertMedia(db, k, f.id, f.sha256Checksum?.toLowerCase() ?? null)
          hashes.push(k.sha256)
          role === 'strip' ? out.strips++ : out.stills++
        } catch (err) { fail(err) }
      }
    }

    // A moment cut from its master, or a whole cut pointed at its master.
    if (r.capture === 'moment' || r.capture === 'whole_cut') {
      const reach = await reachable(r.media.masters, files, resolve, id => google.file(id))
      out.unreachableLocal += reach.local
      out.gone += reach.gone
      out.unresolved += reach.unresolved
      // A whole cut points at the original master, never at a copy someone put in the Rejections folder.
      const original = reach.found.find(m => m.original)
      if (r.capture === 'whole_cut' && original) {
        if (write) { if (await pointAt(db, r, original.file.id)) out.pointed++ } else out.pointed++
      }
      const master = reach.found[0]
      const moment = r.moment
      if (r.capture === 'moment' && !moment) out.noMoment++
      const wantsCut = Boolean(r.capture === 'moment' && master && moment)
      // Six frames across the cut when there is no moment to cut around and the folder holds no strip of it yet.
      const wantsAcross = Boolean(!wantsCut && master && !r.media.strips.length)
      if (master && (wantsCut || wantsAcross)) {
        const duration = Number(master.file.videoMediaMetadata?.durationMillis ?? 0) || null
        const at = wantsCut ? (moment!.ms ?? (moment!.anchor === 'end' && duration ? Math.max(0, duration - 2000) : 2000)) : null
        const held = await heldMedia(db, master.file.id, wantsCut ? ['clip', 'strip'] : ['strip'], at).catch(() => [])
        if (held.length) { hashes.push(...held.map(h => h.sha256)); out.reused++ }
        else if (Number(master.file.size ?? 0) > MASTER_MAX_BYTES) out.tooBig++
        else if (out.masters >= MASTERS_PER_RUN || now() - started > KEEP_BUDGET_MS) out.deferred++
        else if (!write) { out.masters++; if (wantsCut) out.clips++; out.strips++ }
        else {
          out.masters++
          const dir = await mkdtemp(join(tmpdir(), 'taste-master-'))
          try {
            const path = join(dir, 'master')
            const got = await google.downloadTo(master.file.id, path, MASTER_MAX_BYTES)
            const kept = wantsCut ? Object.values(await cut(path, at!)) : [await across(path)]
            for (const k of kept) {
              await insertMedia(db, k, master.file.id, got.sha256)
              hashes.push(k.sha256)
              if (k.role === 'clip') out.clips++; else out.strips++
            }
          } catch (err) { fail(err) } finally {
            // Let the master go.
            await rm(dir, { recursive: true, force: true }).catch(() => {})
          }
        }
      }
    }
    if (write && hashes.length) await attachMedia(db, r, [...new Set(hashes)]).catch(fail)
  }
  return out
}

interface Reach { found: Array<{ file: DriveFile; original: boolean }>; local: number; gone: number; unresolved: number }

async function reachable(masters: MasterRef[], files: Map<string, DriveFile>, resolve: ReturnType<typeof pathResolver>, getFile: Google['file']): Promise<Reach> {
  const out: Reach = { found: [], local: 0, gone: 0, unresolved: 0 }
  for (const m of masters) {
    if (m.where === 'gone') { out.gone++; continue }
    if (m.where === 'local') { out.local++; continue }
    if (m.where === 'folder') {
      const f = files.get(m.ref)
      if (f) out.found.push({ file: f, original: false })
      else out.unresolved++
      continue
    }
    if (m.where === 'drive_id') {
      const f = await getFile(m.ref).catch(() => null)
      if (f) out.found.push({ file: f, original: true })
      else out.unresolved++
      continue
    }
    const hit = await resolve(m.ref).catch(() => null)
    if (hit && hit !== 'ambiguous') out.found.push({ file: hit.file, original: hit.root !== DRIVE.rejections })
    else out.unresolved++
  }
  // An original first: a cut from the master he saw, a copy only when it is all there is.
  out.found.sort((a, b) => Number(b.original) - Number(a.original))
  return out
}
