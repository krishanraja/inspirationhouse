import { hashLine, syncPull, type GitHubApi, type PullSyncResult } from '../publish/harness.ts'
import { FLOOR_FILE } from './render.ts'

// The floor reaches content-engine the way the approved rules reach ai-harness: by one pull request he merges
// (Ruling, Krish, 2026-10-24: "Rules arrive by PR"). An open pull request already holding the file is left alone, and a
// file he closed without merging is never proposed again.

export const FLOOR_BRANCH = 'floor/rejections'

/** content-engine's closeout check (.claude/hooks/harness-closeout.mjs) takes this line in place of a NOW.md update. */
export const FLOOR_CLOSEOUT_LINE = 'Closeout: not needed, config/rejection-floor.json is rendered by the Rejections engine from what Krish rejected; NOW.md does not list it.'

export function floorPullBody(hash: string): string {
  return [
    "The rejection floor, rendered from Krish's rejections by the Rejections engine (`krishanraja/inspirationhouse`, `engine rejections`): what he rejected, his words, and the standards no finished piece may fall beneath, by format.",
    '',
    'Sessions read it with `python3 scripts/floor.py --format <format>`. Nothing changes until this is merged. This repository is public: his words in the file become public on merge, as config/learnings.json already holds them. The file holds no PC path, Drive id, session id or email (the engine refuses to render one that does).',
    '',
    'Closing this without merging declines this version of the file: it is never proposed again, and a pull request opens only once the floor changes.',
    '',
    FLOOR_CLOSEOUT_LINE,
    '',
    hashLine(hash),
  ].join('\n')
}

export async function publishFloor(gh: GitHubApi, text: string, write: boolean, base = 'main'): Promise<PullSyncResult> {
  return syncPull(gh, {
    files: [{ path: FLOOR_FILE, text, message: 'The rejection floor, from what Krish rejected' }],
    branch: FLOOR_BRANCH, base, write,
    title: 'The rejection floor: what Krish rejected, and the standards beneath which nothing ships',
    body: floorPullBody,
  })
}
