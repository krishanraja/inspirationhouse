import { createHash, createSign } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GOOGLE_SCOPES, type Config } from './config.ts'

// A service account with read-only scopes, and nothing else. The engine never
// writes into Krish's Drive (architecture 0a.5).
export interface Google {
  listFolder(folderId: string): Promise<DriveFile[]>
  readSheet(sheetId: string, range: string): Promise<string[][]>
  // A preview image Drive already made (videos included), at a card's width.
  thumbnail(file: DriveFile, width?: number): Promise<{ bytes: Buffer; mime: string } | null>
  // The text of a Doc, Markdown or plain-text file, for tagging. Capped.
  text(file: DriveFile, maxChars?: number): Promise<string | null>
  // A file's own bytes (an uploaded workbook, say). Refuses past the cap.
  download(fileId: string, maxBytes?: number): Promise<Buffer>
  // One file's listing fields by its id (a master a capture named), or null when the engine cannot see it.
  file(fileId: string): Promise<DriveFile | null>
  // A large file (a master) streamed to a local path, never held in memory, with the sha256 of what arrived. Stops,
  // and throws, the moment it passes the cap.
  downloadTo(fileId: string, path: string, maxBytes: number): Promise<{ bytes: number; sha256: string }>
  // Who owns a file and who last changed it, by Drive permission id, and who made each of its revisions where Drive
  // shows them (null when it does not, as for a viewer of a file some accounts cannot list): what the Rejections inbox
  // reads to tell his typing from a machine's (src/rejection/dropzone.ts). Optional, so a test's stand-in may leave it out.
  authorship?(fileId: string): Promise<Authorship | null>
}

export interface Authorship {
  owners: string[]
  lastModifier: string | null
  revisionAuthors: string[] | null
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * Every file under a folder, by its path inside it ('assets/<piece>/<name>'), walked by id one level at a time. A
 * folder deeper than maxDepth, or a walk past maxFiles, is cut short and throws: a half-read folder is never read as
 * a whole one.
 */
export async function walkFolder(google: Pick<Google, 'listFolder'>, folderId: string, opts: { maxDepth?: number; maxFiles?: number } = {}): Promise<Array<{ path: string; file: DriveFile }>> {
  const maxDepth = opts.maxDepth ?? 6
  const maxFiles = opts.maxFiles ?? 5000
  const out: Array<{ path: string; file: DriveFile }> = []
  const queue: Array<{ id: string; prefix: string; depth: number }> = [{ id: folderId, prefix: '', depth: 0 }]
  while (queue.length) {
    const { id, prefix, depth } = queue.shift()!
    for (const f of await google.listFolder(id)) {
      const path = `${prefix}${f.name}`
      if (f.mimeType === FOLDER_MIME) {
        if (depth + 1 > maxDepth) throw new Error('drive walk: the folder is nested deeper than the walk reads')
        queue.push({ id: f.id, prefix: `${path}/`, depth: depth + 1 })
      } else {
        out.push({ path, file: f })
        if (out.length > maxFiles) throw new Error('drive walk: the folder holds more files than the walk reads')
      }
    }
  }
  return out
}

const TEXT_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}
const PLAIN_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv'])
const CARD_IMAGE = /^image\/(jpeg|png|webp)$/

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  createdTime: string
  size?: string
  thumbnailLink?: string
  videoMediaMetadata?: { durationMillis?: string }
  /** Drive's sha256 of the file's bytes (lowercase hex). A link's request names its media by the same hash. */
  sha256Checksum?: string
}

export interface ServiceAccount { email: string; key: string }

// The secret holds either the PEM alone (with the email beside it) or the whole
// JSON key file. Either way, only the email and the private key are used.
export function serviceAccount(cfg: Config): ServiceAccount | null {
  const raw = cfg.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim()
  if (!raw) return null
  if (raw.startsWith('{')) {
    let file: { client_email?: unknown; private_key?: unknown }
    try { file = JSON.parse(raw) } catch { throw new Error('google key: the JSON key file does not parse') }
    const email = typeof file.client_email === 'string' ? file.client_email : cfg.GOOGLE_SERVICE_ACCOUNT_EMAIL
    if (typeof file.private_key !== 'string' || !email) throw new Error('google key: the JSON key file has no client_email or private_key')
    return { email, key: file.private_key }
  }
  if (!cfg.GOOGLE_SERVICE_ACCOUNT_EMAIL) return null
  return { email: cfg.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: raw.replace(/\\n/g, '\n') }
}

export function googleConfigured(cfg: Config): boolean {
  return serviceAccount(cfg) !== null
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

async function accessToken(cfg: Config): Promise<string> {
  const sa = serviceAccount(cfg)
  if (!sa) throw new Error('google auth failed: no service account configured')
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: sa.email,
    scope: GOOGLE_SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000,
  }))
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.key).toString('base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  })
  const body = await res.json().catch(() => ({})) as { access_token?: string; error?: string }
  if (!res.ok || !body.access_token) throw new Error(`google auth failed: ${body.error ?? res.status}`)
  return body.access_token
}

export async function connectGoogle(cfg: Config): Promise<Google> {
  const token = await accessToken(cfg)
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`google read failed: HTTP ${res.status}`)
    return res.json() as Promise<T>
  }
  return {
    async listFolder(folderId) {
      const files: DriveFile[] = []
      let pageToken: string | undefined
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
        const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,thumbnailLink,videoMediaMetadata,sha256Checksum)')
        const page = await get<{ files?: DriveFile[]; nextPageToken?: string }>(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
        )
        files.push(...(page.files ?? []))
        pageToken = page.nextPageToken
      } while (pageToken)
      return files
    },
    async readSheet(sheetId, range) {
      const body = await get<{ values?: string[][] }>(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
      )
      return body.values ?? []
    },
    async thumbnail(file, width = 640) {
      if (!file.thumbnailLink) return null
      // Drive links end in =s220; ask for the size a card draws at.
      const url = file.thumbnailLink.replace(/=s\d+$/, `=s${width}`)
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      const mime = (res.headers.get('content-type') || '').split(';')[0]!.trim()
      if (!res.ok || !CARD_IMAGE.test(mime)) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      return bytes.length <= 250_000 ? { bytes, mime } : null
    },
    async text(file, maxChars = 6000) {
      const exportAs = TEXT_EXPORT[file.mimeType]
      const url = exportAs
        ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`
        : PLAIN_TEXT.has(file.mimeType) ? `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media` : null
      if (!url) return null
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) return null
      return (await res.text()).replace(/\u0000/g, '').slice(0, maxChars)
    },
    async download(fileId, maxBytes = 20_000_000) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`google download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > maxBytes) throw new Error('google download refused: file is over the size cap')
      return bytes
    },
    async file(fileId) {
      const fields = encodeURIComponent('id,name,mimeType,modifiedTime,createdTime,size,thumbnailLink,videoMediaMetadata,sha256Checksum,trashed')
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.status === 404 || res.status === 403) return null
      if (!res.ok) throw new Error(`google read failed: HTTP ${res.status}`)
      const f = await res.json() as DriveFile & { trashed?: boolean }
      return f.trashed ? null : f
    },
    async authorship(fileId) {
      const id = encodeURIComponent(fileId)
      const fields = encodeURIComponent('owners(permissionId),lastModifyingUser(permissionId)')
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=${fields}&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.status === 404 || res.status === 403) return null
      if (!res.ok) throw new Error(`google read failed: HTTP ${res.status}`)
      const f = await res.json() as { owners?: Array<{ permissionId?: string }>; lastModifyingUser?: { permissionId?: string } }
      const owners = (f.owners ?? []).map(o => o.permissionId).filter((p): p is string => Boolean(p))
      // Revisions: every page, or null when Drive will not list them to this account.
      let revisionAuthors: string[] | null = []
      let pageToken: string | undefined
      do {
        const rf = encodeURIComponent('nextPageToken,revisions(lastModifyingUser(permissionId))')
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/revisions?fields=${rf}&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (r.status === 403 || r.status === 404) { revisionAuthors = null; break }
        if (!r.ok) throw new Error(`google read failed: HTTP ${r.status}`)
        const page = await r.json() as { revisions?: Array<{ lastModifyingUser?: { permissionId?: string } }>; nextPageToken?: string }
        for (const rev of page.revisions ?? []) revisionAuthors.push(rev.lastModifyingUser?.permissionId ?? '')
        pageToken = page.nextPageToken
      } while (pageToken)
      return { owners, lastModifier: f.lastModifyingUser?.permissionId ?? null, revisionAuthors }
    },
    async downloadTo(fileId, path, maxBytes) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok || !res.body) throw new Error(`google download failed: HTTP ${res.status}`)
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > maxBytes) {
        await res.body.cancel().catch(() => {})
        throw new Error('google download refused: file is over the size cap')
      }
      const hash = createHash('sha256')
      let bytes = 0
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length
          if (bytes > maxBytes) { done(new Error('google download refused: file is over the size cap')); return }
          hash.update(chunk)
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(path))
      return { bytes, sha256: hash.digest('hex') }
    },
  }
}
