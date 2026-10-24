import { describe, expect, it } from 'vitest'
import { DRIVE } from '../src/config.ts'
import { collectDrive } from '../src/collect/drive.ts'

// Krish moved both inspiration folders into Ventures > Inspiration on 2026-10-24: Content Inspo keeps Cold Ideas'
// ID, Production Inspo replaces Video Engine > Inspiration, whose ID no longer exists, and the What I like sheet
// moved into Content Inspo. Synthetic files only.

const file = (id: string, name: string, mimeType: string) => ({ id, name, mimeType, modifiedTime: '2026-10-24T00:00:00Z', createdTime: '2026-10-24T00:00:00Z' })

describe('the inspiration folders', () => {
  it('reads Production Inspo by its ID, never the gone Video Engine > Inspiration', () => {
    expect(DRIVE.videoInspiration).toBe('1QxrzxISYFXq0er0DG0XSapm7qhvuRmh-')
    expect(DRIVE.coldIdeas).toBe('1FNztJOU82M8zb6IIbUAbvuI6Kr0pF5Hu')
    expect(Object.values(DRIVE)).not.toContain('1eqdc1hoMn6CwqkbKlG5mAmKCYNoR8otU')
  })

  it('never takes the What I like sheet for a reference, now that it sits in Content Inspo', async () => {
    const listed: Record<string, ReturnType<typeof file>[]> = {
      [DRIVE.coldIdeas]: [file(DRIVE.whatILikeSheet, 'What I like', 'application/vnd.google-apps.spreadsheet'), file('doc-1', 'a-post.png', 'image/png')],
      [DRIVE.videoInspiration]: [file('clip-1', 'a-reel.mp4', 'video/mp4')],
    }
    const google = { listFolder: async (id: string) => listed[id] ?? [] } as never
    const evidence = await collectDrive(google)
    expect(evidence).toHaveLength(2)
    expect(JSON.stringify(evidence)).not.toContain(DRIVE.whatILikeSheet)
  })
})
