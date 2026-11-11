import { compare, newerThan, olderThan, parseVersion } from "./semver.ts"
import type { Semver } from "./semver.ts"

// `<data dir>/app/state.json` and the rules over it (the old staging.ts), as pure functions. The desktop shell reads
// and writes the file too, so it is written through a temp file and a rename, and the keys it doesn't know are kept
// (`other`). The service (`Releases`) reads and writes it; these decide what changes.

/** `app/state.json`. */
export interface Installed {
  /** The version that last came up from `app/`. */
  readonly current: string | null
  /** The one before it, kept for Roll back. */
  readonly previous: string | null
  /** Downloaded and checked, waiting for Update. */
  readonly staged: string | null
  /** The one an Update (or a start) is exec'ing into, until it is up. */
  readonly trying: string | null
  /** Versions that didn't start or were rolled back from: not offered again. */
  readonly bad: ReadonlyArray<string>
  /** Keys written by the desktop app or a newer server, kept as they are. */
  readonly other: Readonly<Record<string, unknown>>
}

export const emptyInstalled: Installed = { current: null, previous: null, staged: null, trying: null, bad: [], other: {} }

const str = (x: unknown) => (typeof x === "string" ? x : null)

const KNOWN = new Set(["current", "previous", "staged", "trying", "bad"])

/** The file's object as `Installed`: an odd value is none (the file is shared, so one doesn't lose the rest). */
export const fromRecord = (r: Readonly<Record<string, unknown>>): Installed => {
  const other: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) if (!KNOWN.has(k)) other[k] = v
  return {
    current: str(r["current"]),
    previous: str(r["previous"]),
    staged: str(r["staged"]),
    trying: str(r["trying"]),
    bad: Array.isArray(r["bad"]) ? r["bad"].filter((b): b is string => typeof b === "string") : [],
    other,
  }
}

/** As written: the known fields first, then the others by name. */
export const toRecord = (s: Installed): Record<string, unknown> => {
  const out: Record<string, unknown> = { current: s.current, previous: s.previous, staged: s.staged, trying: s.trying, bad: [...s.bad] }
  for (const k of Object.keys(s.other).toSorted()) out[k] = s.other[k]
  return out
}

/** Whether two states are the same (`other` is never changed here, so it is compared as the same object). */
export const sameInstalled = (a: Installed, b: Installed) =>
  a.current === b.current &&
  a.previous === b.previous &&
  a.staged === b.staged &&
  a.trying === b.trying &&
  a.other === b.other &&
  a.bad.length === b.bad.length &&
  a.bad.every((v, i) => b.bad[i] === v)

export const isBad = (s: Installed, v: string) => s.bad.includes(v)

const withBad = (s: Installed, v: string): Installed => (isBad(s, v) ? s : { ...s, bad: [...s.bad, v] })

/**
 * A server running from `app/<v>` has come up: `v` is current (and, after an Update, the one it replaced previous),
 * `trying` is cleared, and a staged version that isn't newer (or is bad) is dropped.
 */
export const settled = (s: Installed, v: string): Installed => {
  let next = s
  if (next.trying === v) next = { ...next, previous: next.current !== v ? next.current : next.previous, trying: null }
  next = { ...next, current: v }
  const running = parseVersion(v)
  const staged = next.staged
  if (staged !== null) {
    const sv = parseVersion(staged)
    const notNewer = sv === null ? true : running === null ? false : compare(sv, running) <= 0
    if (notNewer || isBad(next, staged)) next = { ...next, staged: null }
  }
  return next
}

/**
 * For a server whose version nothing else chooses (a tarball's, started again by its supervisor): the version in
 * `app/` to exec instead, as the desktop app chooses: `current`, else `previous`, the first newer than `running` that
 * isn't bad and is `complete`. It becomes `trying`, which `settled` clears once it is up. A `trying` still set never
 * came up, so it is marked bad first (`failed`): a version that exits on startup is tried once.
 */
export const chooseAtStartup = (
  s: Installed,
  running: Semver,
  complete: (v: string) => boolean,
): { readonly next: Installed; readonly pick: string | null; readonly failed: string | null } => {
  const failed = s.trying
  let next: Installed = { ...s, trying: null }
  if (failed !== null) next = withBad(next, failed)
  const ok = (v: string | null): v is string => v !== null && !isBad(next, v) && newerThan(v, running) && complete(v)
  const pick = ok(next.current) ? next.current : ok(next.previous) ? next.previous : null
  // Falling back to previous: it is current now, rather than the one passed over becoming previous when it settles.
  if (pick !== null && pick !== next.current) next = { ...next, current: pick, previous: null }
  return { next: { ...next, trying: pick }, pick, failed }
}

/**
 * For a server not running from `app/` (the desktop app's own, from a package newer than the versions there): forget
 * `current` and `previous` where they are older than it, so that an Update from it doesn't make one previous and Roll
 * back doesn't go back to it.
 */
export const superseded = (s: Installed, running: Semver): Installed => ({
  ...s,
  current: olderThan(s.current, running) ? null : s.current,
  previous: olderThan(s.previous, running) ? null : s.previous,
})

/** `s` once `current` is rolled back from to `previous` (null for the bundled server). */
export const rolledBack = (s: Installed, current: string, previous: string | null): Installed => ({
  ...withBad(s, current),
  current: previous,
  previous: null,
  trying: s.trying === current ? null : s.trying,
})

/** Undo `rolledBack(old, current, previous)` on `s`, for the fields it changed that nothing has changed since. */
export const notRolledBack = (s: Installed, old: Installed, current: string, previous: string | null): Installed => ({
  ...s,
  bad: isBad(old, current) ? s.bad : s.bad.filter((b) => b !== current),
  current: s.current === previous ? old.current : s.current,
  previous: s.previous === null ? old.previous : s.previous,
  trying: old.trying === current && s.trying === null ? old.trying : s.trying,
})

/** The versions `s` names, which stay in `app/`. */
export const kept = (s: Installed): ReadonlyArray<string> => [s.current, s.previous, s.staged, s.trying].filter((v): v is string => v !== null)

/**
 * What to delete in `app/`: folders but those `s` names (leftover `.partial` downloads, versions nothing needs) and
 * `state.json`'s temp files. Other files are the desktop app's and are left alone.
 */
export const toPrune = (entries: ReadonlyArray<{ readonly name: string; readonly dir: boolean }>, s: Installed): ReadonlyArray<string> => {
  const keep = kept(s)
  return entries
    .filter((e) => e.name !== "state.json" && !keep.includes(e.name) && (e.dir || (e.name.startsWith("state.json.") && e.name.endsWith(".tmp"))))
    .map((e) => e.name)
}
