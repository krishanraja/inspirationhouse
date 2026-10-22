import { createSign } from 'node:crypto'
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
}

export function googleConfigured(cfg: Config): boolean {
  return Boolean(cfg.GOOGLE_SERVICE_ACCOUNT_EMAIL && cfg.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

async function accessToken(cfg: Config): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: cfg.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: GOOGLE_SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000,
  }))
  const key = String(cfg.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).replace(/\\n/g, '\n')
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key).toString('base64url')
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
        const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,thumbnailLink,videoMediaMetadata)')
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
  }
}
