import type { z } from 'zod'

// The limits in a schema (how many tags, how long an answer) never reach the model: the structured-output API strips
// every minLength, maxLength, minItems and maxItems before sending, and the SDK then enforces them on the answer
// (measured 2026-10-24: none of the tag schema's limits were sent, and one tag too many failed the parse). So one
// sentence over a limit used to lose a whole card, or a whole batch. Here the answer is read and any limit it overran
// is repaired: a list cut to its length, a string cut at a word boundary, an item that is too short or has an
// out-of-range number dropped. Anything else (a wrong type, a missing field, a word outside an enum) is still a failure.

type Path = PropertyKey[]
const MAX_PASSES = 200

/** Cut to at most `n` characters, at the last word boundary when there is one in the second half. */
export function cutAt(s: string, n: number): string {
  if (s.length <= n) return s
  const head = s.slice(0, n)
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
  // The items a cut list put aside, by the list itself (never by its path, which shifts when an outer item is dropped).
  const spare = new WeakMap<unknown[], unknown[]>()
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const res = schema.safeParse(value)
    if (res.success) return { data: res.data, repairs }
    const issues = res.error.issues as Array<{ code: string; origin?: string; maximum?: number | bigint; path: Path }>
    if (issues.some(i => i.code !== 'too_small' && i.code !== 'too_big')) return null
    const cuttable = (i: (typeof issues)[number]) => i.code === 'too_big' && (i.origin === 'array' || i.origin === 'string')
    // Drops one a pass, so the other issues' indexes stay true. Zod reports a list that is too long before it looks at
    // the items in it, so a cut list keeps what it cut aside, and a dropped item's place goes to the next good one.
    const drop = issues.find(i => !cuttable(i))
    if (drop) {
      // Too short a string or list, or a number out of range: drop the list item that holds it.
      const k = drop.path.findLastIndex(p => typeof p === 'number')
      const list = k < 0 ? undefined : at(value, drop.path.slice(0, k))
      if (!Array.isArray(list)) return null
      list.splice(drop.path[k] as number, 1)
      const next = spare.get(list)?.shift()
      if (next !== undefined) list.push(next)
      repairs++
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
