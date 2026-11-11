// Versions as the `semver` crate orders them (the old release.ts's `parse_version` and `compare`): pure.

export interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly pre: ReadonlyArray<string>
  /** Build metadata (`+…`), compared last, as a tiebreaker. */
  readonly build: string
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** A semver version (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build`), or null. */
export const parseVersion = (v: string): Semver | null => {
  const m = SEMVER.exec(v)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split("."), build: m[5] ?? "" }
}

/** A version as a user or a hub may write it: trimmed, without leading `v`s. */
export const parseLoose = (v: string): Semver | null => parseVersion(v.trim().replace(/^v+/, ""))

const comparePre = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  if ((a.length === 0) !== (b.length === 0)) return a.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Semver precedence: below 0, 0 or above 0. */
export const compare = (a: Semver, b: Semver): number => {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  const pre = comparePre(a.pre, b.pre)
  if (pre !== 0) return pre
  return a.build === b.build ? 0 : a.build < b.build ? -1 : 1
}

/** A version as semver writes it. */
export const versionString = (v: Semver) =>
  `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join(".")}` : ""}${v.build === "" ? "" : `+${v.build}`}`

/** Whether `a` (a version, as text) is the same version as `b`. */
export const sameVersion = (a: string, b: Semver) => {
  const v = parseVersion(a)
  return v !== null && compare(v, b) === 0
}

/** Whether `v` (as text) is a version newer than `than`. */
export const newerThan = (v: string | null, than: Semver) => {
  const p = v === null ? null : parseVersion(v)
  return p !== null && compare(p, than) > 0
}

/** Whether `v` (as text) is a version older than `than`. */
export const olderThan = (v: string | null, than: Semver) => {
  const p = v === null ? null : parseVersion(v)
  return p !== null && compare(p, than) < 0
}
