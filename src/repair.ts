import type { z } from 'zod'

// The limits in a schema (how many tags, how long an answer) are not enforced by the model API: the SDK takes every
// minLength, maxLength, minItems and maxItems out of the schema it sends (they reach the model only as a hint in the
// description) and then enforces them on the answer (measured 2026-10-24: one tag too many failed the parse). So one
// sentence over a limit used to lose a whole card, or a whole batch. Here the answer is read and any limit it overran
// is repaired: a list cut to its length, a string cut at a word boundary, an item that is too short or has an
// out-of-range number dropped. Anything else (a wrong type, a missing field, a word outside an enum) is still a failure,
// except in an item that only came back to fill the place of a dropped one.

type Path = PropertyKey[]
const MAX_PASSES = 200

/** Cut to at most `n` characters, at the last word boundary when there is one in the second half. Never splits a
 *  character in two (half an emoji is text Postgres refuses, and would fail the whole write). */
export function cutAt(s: string, n: number): string {
  if (s.length <= n) return s
  let head = s.slice(0, n)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  const space = head.lastIndexOf(' ')
  return (space > n / 2 ? head.slice(0, space) : head).trimEnd()
}

function at(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((v, k) => (v != null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined), root)
}
function put(root: unknown, path: Path, value: unknown): void {
  const parent = at(root, path.slice(0, -1))
  if (parent != null && typeof parent === 'object') (parent as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value
}

/** The schema's answer, with the limits it overran repaired, or null when what is wrong is not a limit. */
export function repairToSchema<S extends z.ZodType>(schema: S, raw: unknown): { data: z.infer<S>; repairs: number } | null {
  const value = structuredClone(raw)
  let repairs = 0
  // The items a cut list put aside, by the list itself (never by its path, which shifts when an outer item is dropped),
  // and how many of the list's last items came back from that spare. Those are optional: the answer had them past the
  // limit, so one that is wrong in any way is dropped, never the reason the whole answer fails.
  const spare = new WeakMap<unknown[], unknown[]>()
  const refilled = new WeakMap<unknown[], number>()
  const isRefilled = (list: unknown[], idx: number) => idx >= list.length - (refilled.get(list) ?? 0)
  const dropAt = (list: unknown[], idx: number) => {
    if (isRefilled(list, idx)) refilled.set(list, (refilled.get(list) ?? 1) - 1)
    list.splice(idx, 1)
    const next = spare.get(list)?.shift()
    if (next !== undefined) { list.push(next); refilled.set(list, (refilled.get(list) ?? 0) + 1) }
    repairs++
  }
  /** The deepest list item on this path that came back from a spare, if there is one. */
  const refilledOn = (path: Path): { list: unknown[]; idx: number } | null => {
    for (let k = path.length - 1; k >= 0; k--) {
      const idx = path[k]
      if (typeof idx !== 'number') continue
      const list = at(value, path.slice(0, k))
      if (Array.isArray(list) && isRefilled(list, idx)) return { list, idx }
    }
    return null
  }
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const res = schema.safeParse(value)
    if (res.success) return { data: res.data, repairs }
    const issues = res.error.issues as Array<{ code: string; origin?: string; maximum?: number | bigint; path: Path }>
    // Not a limit (a wrong type, a missing field, a word outside an enum): a failure, unless it is in an optional item.
    const hard = issues.find(i => i.code !== 'too_small' && i.code !== 'too_big')
    if (hard) {
      const r = refilledOn(hard.path)
      if (!r) return null
      dropAt(r.list, r.idx)
      continue
    }
    const cuttable = (i: (typeof issues)[number]) => i.code === 'too_big' && (i.origin === 'array' || i.origin === 'string')
    // Drops one a pass, so the other issues' indexes stay true. Zod reports a list that is too long before it looks at
    // the items in it, so a cut list keeps what it cut aside, and a dropped item's place goes to the next one.
    const drop = issues.find(i => !cuttable(i))
    if (drop) {
      // Too short a string or list, or a number out of range: drop the list item that holds it.
      const k = drop.path.findLastIndex(p => typeof p === 'number')
      const list = k < 0 ? undefined : at(value, drop.path.slice(0, k))
      if (!Array.isArray(list)) return null
      dropAt(list, drop.path[k] as number)
      continue
    }
    for (const i of issues) {
      const target = at(value, i.path)
      if (i.origin === 'array' && Array.isArray(target)) {
        const kept = target.slice(0, Number(i.maximum))
        spare.set(kept, [...(spare.get(target) ?? []), ...target.slice(Number(i.maximum))])
        put(value, i.path, kept)
      } else if (i.origin === 'string' && typeof target === 'string') put(value, i.path, cutAt(target, Number(i.maximum)))
      else continue // gone already: an earlier cut in this pass took the list it was in
      repairs++
    }
  }
  return null
}
