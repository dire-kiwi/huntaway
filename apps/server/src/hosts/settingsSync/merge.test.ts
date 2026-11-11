import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import type { SyncEntry, SyncLost } from "@huntaway/contracts"
import { canon, mergeEntry, parseEntries } from "./merge.ts"

// The merge rule of settings sync (the old settings_sync.test.ts, its pure cases), and its algebra as properties.

const entry = (value: unknown, vv: Record<string, number>, at: string, by: string, lost: Array<SyncLost> = []): SyncEntry => ({
  name: "global/default_model",
  value,
  vv,
  changed_at: at,
  changed_by: by,
  since: "",
  lost,
})
/** `e` with some fields changed (or broken). */
const changed = (e: SyncEntry, change: Readonly<Record<string, unknown>>): SyncEntry => Object.assign({}, e, change)
const lost = (value: unknown, by: string, at: string): SyncLost => ({ value, by, at, since: "" })
const T1 = "2026-11-11T10:00:00.000Z"
const T2 = "2026-11-11T11:00:00.000Z"
const T3 = "2026-11-11T12:00:00.000Z"

const merged = (entries: ReadonlyArray<SyncEntry>) => entries.reduce<SyncEntry | null>((m, e) => mergeEntry(m, e), null)

describe("settings sync's merge", () => {
  it("an entry that has seen the other's changes is kept: catching up is not a conflict", () => {
    const old = entry("opus", { a: 1 }, T1, "a")
    const newer = entry("sonnet", { a: 2, b: 1 }, T2, "b")
    assert.strictEqual(mergeEntry(old, newer), newer)
    assert.strictEqual(mergeEntry(newer, old), newer)
    assert.strictEqual(mergeEntry(newer, structuredClone(newer)), newer)
    assert.strictEqual(mergeEntry(null, old), old)
    // Even when the one that's behind has the later clock: its host's clock is wrong, or it was set back.
    const behind = entry("haiku", { a: 1 }, T3, "a")
    assert.strictEqual(mergeEntry(behind, newer), newer)
  })

  it("two changes made apart: the later wins, and the value that lost is kept", () => {
    const a = entry("opus", { a: 2, b: 1 }, T2, "a")
    const b = entry("sonnet", { a: 1, b: 2 }, T3, "b")
    const m = mergeEntry(a, b)
    assert.deepStrictEqual(m, entry("sonnet", { a: 2, b: 2 }, T3, "b", [lost("opus", "a", T2)]))
    assert.deepStrictEqual(mergeEntry(b, a), m)
    // Both hosts then have the merged entry, which covers either side's.
    assert.strictEqual(mergeEntry(m, a), m)
    assert.strictEqual(mergeEntry(m, b), m)
    // The same time: by host id, the same way round on both.
    const tie = mergeEntry(entry("opus", { a: 2 }, T2, "a"), entry("sonnet", { b: 2 }, T2, "b"))
    assert.strictEqual(tie.value, "sonnet")
    // The same value set on both is no conflict.
    const same = mergeEntry(entry("opus", { a: 2 }, T2, "a"), entry("opus", { b: 2 }, T3, "b"))
    assert.deepStrictEqual(same, entry("opus", { a: 2, b: 2 }, T3, "b"))
    // A later change drops what was lost.
    const next = entry("haiku", { a: 3, b: 2 }, T3, "a")
    assert.strictEqual(mergeEntry(m, next), next)
  })

  it("hosts end up with the same entry whatever order they merge in", () => {
    const es = [entry("opus", { a: 1 }, T1, "a"), entry("sonnet", { b: 1 }, T3, "b"), entry("haiku", { c: 1 }, T2, "c"), entry("sonnet", { d: 1 }, "", "d")]
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]
    const results = orders.map((o) => merged(o.flatMap((i) => es[i] ?? [])))
    // Pairs first, then the pairs.
    const [e0, e1, e2, e3] = es
    if (e0 === undefined || e1 === undefined || e2 === undefined || e3 === undefined) throw new Error("four entries")
    results.push(mergeEntry(mergeEntry(e0, e1), mergeEntry(e2, e3)))
    for (const r of results) assert.deepStrictEqual(r, results[0])
    assert.strictEqual(results[0]?.value, "sonnet")
    assert.deepStrictEqual(results[0]?.vv, { a: 1, b: 1, c: 1, d: 1 })
    assert.deepStrictEqual(
      results[0]?.lost.map((l) => l.value),
      ["haiku", "opus"],
    )
  })

  it("of two values from before sync, the one whose host began to sync first wins, whatever the ids", () => {
    const first = changed(entry("opus", { a: 1 }, "", "a"), { since: T1 })
    const joiner = changed(entry("haiku", { z: 1 }, "", "z"), { since: T2 })
    const early = changed(entry("haiku", { 0: 1 }, "", "0"), { since: T2 })
    for (const other of [joiner, early]) {
      const m = mergeEntry(first, other)
      assert.strictEqual(m.value, "opus")
      assert.strictEqual(m.since, T1)
      assert.deepStrictEqual(
        m.lost.map((l) => [l.value, l.since]),
        [["haiku", T2]],
      )
      assert.deepStrictEqual(mergeEntry(other, first), m)
    }
    // A real change beats either, however late its host joined.
    assert.strictEqual(mergeEntry(first, entry("fable", { z: 2 }, T3, "z")).value, "fable")
  })

  it.effect("entries from another host are checked", () =>
    Effect.gen(function* () {
      const ok = entry("opus", { a: 1 }, T1, "a")
      assert.deepStrictEqual(yield* parseEntries([ok]), [ok])
      for (const bad of [
        changed(ok, { vv: { a: -1 } }),
        changed(ok, { vv: [] }),
        changed(ok, { changed_at: "tomorrow" }),
        changed(ok, { name: "" }),
        changed(ok, { lost: [{}] }),
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(parseEntries([bad]))), canon(bad))
      }
      assert.isTrue(Exit.isFailure(yield* Effect.exit(parseEntries({}))))
    }),
  )

  it("canonical JSON sorts keys at every level and leaves undefined out", () => {
    assert.strictEqual(canon({ b: [1, { d: "x", c: null }], a: true, u: undefined }), '{"a":true,"b":[1,{"c":null,"d":"x"}]}')
    assert.strictEqual(canon(undefined), "null")
    assert.strictEqual(canon('a "quoted"\nline'), '"a \\"quoted\\"\\nline"')
  })
})

// The algebra, over entries made the way hosts make them: an entry's vector says which changes it has seen, and the
// value, time and host of the latest are what that history gives, so two entries with one vector are the same entry.
const Host = Schema.Literals(["a", "b", "c"])
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
const History = Schema.Struct({ a: Count, b: Count, c: Count, last: Host })
const VALUES = ["opus", "sonnet", "haiku"]
const TIMES = ["", T1, T2, T3]
const SINCES = [T1, T2]

/** The entry a history gives; null for a history of no changes. */
const ofHistory = (h: typeof History.Type): SyncEntry | null => {
  const vv: Record<string, number> = {}
  for (const host of ["a", "b", "c"] as const) if (h[host] > 0) vv[host] = h[host]
  const by = vv[h.last] === undefined ? Object.keys(vv)[0] : h.last
  if (by === undefined) return null
  const k = h.a * 9 + h.b * 3 + h.c + (by === "a" ? 0 : by === "b" ? 27 : 54)
  const at = TIMES[k % TIMES.length] ?? ""
  return {
    name: "global/default_model",
    value: VALUES[k % VALUES.length],
    vv,
    changed_at: at,
    changed_by: by,
    since: at === "" ? (SINCES[k % 2] ?? "") : "",
    lost: [],
  }
}

/** A change on one host alone, apart from the others: what concurrent edits look like. */
const Apart = Schema.Struct({ host: Host, n: Count, value: Schema.Literals(VALUES), at: Schema.Literals(TIMES), since: Schema.Literals(SINCES) })
const ofApart = (c: typeof Apart.Type, i: number): SyncEntry => ({
  name: "global/default_model",
  value: c.value,
  vv: { [`${c.host}${i}`]: c.n + 1 },
  changed_at: c.at,
  changed_by: `${c.host}${i}`,
  since: c.at === "" ? c.since : "",
  lost: [],
})

describe("settings sync's merge, as properties", () => {
  it.prop("merging an entry with itself changes nothing", { h: History }, ({ h }) => {
    const e = ofHistory(h)
    return e === null || mergeEntry(e, structuredClone(e)) === e
  })

  it.prop("merging is commutative", { x: History, y: History }, ({ x, y }) => {
    const a = ofHistory(x)
    const b = ofHistory(y)
    return a === null || b === null || canon(mergeEntry(a, b)) === canon(mergeEntry(b, a))
  })

  it.prop("merging what was merged again changes nothing", { x: History, y: History }, ({ x, y }) => {
    const a = ofHistory(x)
    const b = ofHistory(y)
    if (a === null || b === null) return true
    const m = mergeEntry(a, b)
    return mergeEntry(m, a) === m && mergeEntry(m, b) === m
  })

  it.prop("changes made apart merge to one entry in any grouping and order", { x: Apart, y: Apart, z: Apart }, ({ x, y, z }) => {
    const [a, b, c] = [ofApart(x, 0), ofApart(y, 1), ofApart(z, 2)]
    const all = [
      mergeEntry(mergeEntry(a, b), c),
      mergeEntry(a, mergeEntry(b, c)),
      mergeEntry(mergeEntry(c, a), b),
      mergeEntry(b, mergeEntry(c, a)),
      mergeEntry(mergeEntry(b, c), a),
    ].map(canon)
    return all.every((m) => m === all[0])
  })
})
