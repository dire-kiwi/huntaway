import { Effect } from "effect"
import type { TurnStats } from "@huntaway/contracts"
import { lines } from "../paths.ts"
import { byteString, lossy, splitNul } from "./git.ts"
import type { Tools } from "./git.ts"
import { MAX_COMMITS } from "./model.ts"
import type { Checkpoint, Snap } from "./model.ts"

// What turns changed (huntaway's git/checkpoints/changed.ts): the files between two checkpoints, without those git
// brought in, and their stats and patches. Paths are byte strings (see git.ts).

/**
 * What the reflog says about how HEAD got to each commit: whether it was made in this worktree (committed, amended,
 * picked, merged) rather than moved to (a fast-forward, reset or checkout).
 */
export const createsCommit = (subject: string): boolean => {
  const action = subject.split(":")[0] ?? ""
  return (
    action.startsWith("commit") ||
    action.startsWith("cherry-pick") ||
    action.startsWith("revert") ||
    action === "am" ||
    ["(pick)", "(reword)", "(edit)", "(squash)", "(fixup)", "(continue)"].some((a) => action.endsWith(a)) ||
    subject.includes(": Merge made by")
  )
}

const decoder = new TextDecoder()

/** The commits made in the worktree at `top`, from its HEAD's reflog (null if it has none). */
const madeHere = Effect.fnUntraced(function* (t: Tools, top: string) {
  const o = yield* t.run(top, ["log", "-g", "-n", "20000", "--format=%H%x1f%gs", "HEAD", "--"]).pipe(Effect.orElseSucceed(() => null))
  if (o === null || !o.ok) return null
  const out = decoder.decode(o.stdout)
  const made = new Set<string>()
  for (const l of lines(out)) {
    const k = l.indexOf("\x1f")
    if (k < 0) continue
    if (createsCommit(l.slice(k + 1))) made.add(l.slice(0, k))
  }
  return out.trim() !== "" ? made : null
})

type Pair = readonly [commit: string, parent: string | null]

/** A `rev-list --parents` line's commit and first parent. */
const pair = (c: ReadonlyArray<string>): Pair => [c[0] ?? "", c[1] ?? null]

/** The paths each commit changed against the parent given with it. */
const changedBy = Effect.fnUntraced(function* (t: Tools, top: string, pairs: ReadonlyArray<Pair>) {
  if (pairs.length === 0) return new Set<string>()
  const input = pairs.map(([c, p]) => `${c}${p !== null ? ` ${p}` : ""}\n`).join("")
  const o = yield* t.ok(top, ["diff-tree", "--stdin", "-r", "--root", "--name-only", "-z", "--no-commit-id", "--no-renames"], { stdin: input })
  return new Set(splitNul(o))
})

/** The paths that differ between two trees or commits. */
export const names = Effect.fnUntraced(function* (t: Tools, top: string, from: string, to: string) {
  return new Set(splitNul(yield* t.ok(top, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to])))
})

/**
 * The files git brought in between two checkpoints of the worktree at `top` (from HEAD `fromHead` to HEAD `toHead` and
 * the files `toTree`) that weren't changed in the worktree itself: those changed by commits HEAD moved to rather than
 * made here (a pull, a fast-forward merge, the commits a rebase went onto) and by merges made here, except where a
 * merge's result isn't git's own (conflicts resolved), where a commit made here changed them too, or where they're
 * changed and not committed.
 */
export const broughtIn = Effect.fnUntraced(function* (t: Tools, top: string, fromHead: string | null, toHead: string | null, toTree: string) {
  if (fromHead === null || toHead === null || fromHead === toHead) return new Set<string>()
  const list = yield* t.ok(top, ["rev-list", "--parents", `--max-count=${MAX_COMMITS + 1}`, toHead, `^${fromHead}`, "--"])
  const commits = lines(decoder.decode(list))
    .map((l) => l.split(/\s+/).filter((w) => w !== ""))
    .filter((c) => c.length > 0)
  if (commits.length === 0 || commits.length > MAX_COMMITS) return new Set<string>()
  // Without a reflog it can't tell: nothing is left out.
  const made = yield* madeHere(t, top)
  if (made === null) return new Set<string>()
  const own = commits.filter((c) => made.has(c[0] ?? ""))
  const other = commits.filter((c) => !made.has(c[0] ?? ""))
  const merges = own.filter((c) => c.length > 2)
  if (other.length === 0 && merges.length === 0) return new Set<string>()
  const touched = yield* changedBy(t, top, own.filter((c) => c.length <= 2).map(pair))
  for (const m of merges) {
    const o = yield* t.run(top, ["show", "--remerge-diff", "--format=", "--name-only", "-z", m[0] ?? "", "--"]).pipe(Effect.orElseSucceed(() => null))
    if (o !== null && o.ok) for (const p of splitNul(o.stdout)) touched.add(p)
    // A git from before remerge diffs (2.36): all of the merge counts as the turn's.
    else for (const p of yield* changedBy(t, top, [pair(m)])) touched.add(p)
  }
  for (const p of yield* names(t, top, toHead, toTree)) touched.add(p)
  const brought = yield* changedBy(t, top, [...other.map(pair), ...merges.map(pair)])
  // Sorted by bytes, which byte strings compare as.
  return new Set([...brought].filter((p) => !touched.has(p)).toSorted())
})

const COUNT = /^\+?\d+$/

/** `git diff --numstat` from `from` to `to` (commits), without `excluded`: the stats, and the paths left out (as text). */
export const numstat = Effect.fnUntraced(function* (t: Tools, top: string, from: string, to: string, excluded: ReadonlySet<string>) {
  const o = yield* t.ok(top, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to, "--"])
  let files = 0
  let additions = 0
  let deletions = 0
  const leftOut: Array<string> = []
  for (const entry of byteString(o).split("\0")) {
    if (entry === "") continue
    const t1 = entry.indexOf("\t")
    const t2 = t1 < 0 ? -1 : entry.indexOf("\t", t1 + 1)
    if (t2 < 0) continue
    const [a, d, path] = [entry.slice(0, t1), entry.slice(t1 + 1, t2), entry.slice(t2 + 1)]
    if (excluded.has(path)) {
      leftOut.push(lossy(path))
      continue
    }
    files += 1
    additions += COUNT.test(a) ? Number(a) : 0
    deletions += COUNT.test(d) ? Number(d) : 0
  }
  return { files, additions, deletions, leftOut }
})

/** What a turn changed, from checkpoint `before` to `after`. */
export const turnStats = Effect.fnUntraced(function* (t: Tools, top: string, before: Checkpoint, after: Snap) {
  const excluded = yield* broughtIn(t, top, before.head, after.head, after.tree)
  const s = yield* numstat(t, top, before.sha, after.sha, excluded)
  const stats: TurnStats = {
    files: s.files,
    additions: s.additions,
    deletions: s.deletions,
    excluded: s.leftOut.slice(0, 200),
    excluded_count: s.leftOut.length,
  }
  return stats
})

const ESCAPES: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }
const encoder = new TextEncoder()

/** A C-quoted path from a diff header (`"a/x\ty"`), unquoted: the path, or null. */
const unquote = (s: string): string | null => {
  if (!s.startsWith('"')) return null
  const rest = s.slice(1)
  const out: Array<number> = []
  let j = 0
  while (j < rest.length) {
    const c = rest[j++] ?? ""
    if (c === '"') return decoder.decode(Uint8Array.from(out))
    if (c !== "\\") {
      out.push(...encoder.encode(c))
      continue
    }
    if (j >= rest.length) return null
    const e = rest[j++] ?? ""
    const simple = ESCAPES[e]
    if (simple !== undefined) out.push(simple)
    else if (e >= "0" && e <= "7") {
      let v = Number(e)
      for (let k = 0; k < 2; k++) {
        const d = rest[j]
        if (d === undefined || !(d >= "0" && d <= "7")) return null
        j++
        v = v * 8 + Number(d)
      }
      out.push(v & 0xff)
    } else out.push(...encoder.encode(e))
  }
  return null
}

/** The path a `diff --git a/<path> b/<path>` line (without renames, so both are the same) is for. */
export const headerPath = (line: string): string | null => {
  if (!line.startsWith("diff --git ")) return null
  const rest = line.slice("diff --git ".length)
  if (rest.startsWith('"')) {
    const u = unquote(rest)
    if (u === null) return null
    return u.startsWith("a/") ? u.slice(2) : null
  }
  // `a/<p> b/<p>`: the same path twice (lengths in bytes).
  const b = encoder.encode(rest)
  if (b.length < 5) return null
  const len = Math.floor((b.length - 5) / 2)
  const boundary = (k: number) => k === b.length || ((b[k] ?? 0) & 0xc0) !== 0x80
  return boundary(2) && boundary(2 + len) ? decoder.decode(b.subarray(2, 2 + len)) : null
}

/** `patch` without the files in `excluded`. */
export const withoutFiles = (patch: string, excluded: ReadonlySet<string>): string => {
  if (excluded.size === 0) return patch
  let out = ""
  let keep = true
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) {
      const p = headerPath(line.replace(/\n+$/, ""))
      keep = p === null || !excluded.has(p)
    }
    if (keep) out += line
  }
  return out
}
