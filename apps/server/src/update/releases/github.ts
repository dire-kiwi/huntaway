import { DateTime, Schema } from "effect"
import type { DesktopShell, ReleaseAsset } from "@huntaway/contracts"
import { compare, parseLoose, parseVersion, sameVersion } from "./semver.ts"
import type { Semver } from "./semver.ts"

// What GitHub's releases API says, and the rules for picking a release from it (the old release.ts): pure.

/** An asset of `GET /repos/{repo}/releases`, with the fields used here. `digest` is `sha256:<hex>` when GitHub lists one. */
export const GhAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.optional(Schema.Finite),
  digest: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface GhAsset extends Schema.Schema.Type<typeof GhAsset> {}

export const GhRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  prerelease: Schema.optional(Schema.NullOr(Schema.Boolean)),
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  assets: Schema.optional(Schema.NullOr(Schema.Array(GhAsset))),
})
export interface GhRelease extends Schema.Schema.Type<typeof GhRelease> {}

export const GhReleases = Schema.fromJsonString(Schema.Array(GhRelease))

/** A release's `huntaway-<v>-release.json`: which desktop shell it was built with. */
export const Manifest = Schema.fromJsonString(Schema.Struct({ shell: Schema.String }))

/** GitHub's error answer: `{ message }`. */
export const GhMessage = Schema.fromJsonString(Schema.Struct({ message: Schema.String }))

/** The sha256 (hex) GitHub lists for an asset, if it lists one. */
export const sha256Of = (a: GhAsset): string | null => {
  const hex = a.digest?.startsWith("sha256:") === true ? a.digest.slice(7) : null
  return hex !== null && /^[0-9a-fA-F]{64}$/.test(hex) ? hex : null
}

export const assetJson = (a: GhAsset): ReleaseAsset => ({ name: a.name, url: a.browser_download_url, size: a.size ?? 0, sha256: sha256Of(a) })

/** A release's server tarball to download: only one with a sha256. */
export interface Asset {
  readonly name: string
  readonly url: string
  readonly size: number
  readonly sha256: string
}

export const toAsset = (a: GhAsset): Asset | null => {
  const sha256 = sha256Of(a)
  return sha256 === null ? null : { name: a.name, url: a.browser_download_url, size: a.size ?? 0, sha256 }
}

/** A tag's version text, without the optional `v`. */
export const tagVersion = (tag: string) => (tag.startsWith("v") ? tag.slice(1) : tag)

/** A release a check could pick, with its version and its server tarball for this platform. */
export interface Offer {
  readonly version: Semver
  readonly release: GhRelease
  readonly asset: GhAsset
}

/**
 * The releases a check could pick: not drafts, not prereleases unless they are included, not `bad`, with a semver tag
 * and a server tarball for `platform` (`huntaway-server-<v>-<platform>.tar.gz`) that has a sha256 digest.
 */
export const offered = (releases: ReadonlyArray<GhRelease>, platform: string, pre: boolean, bad: ReadonlyArray<string>): ReadonlyArray<Offer> =>
  releases.flatMap((r): ReadonlyArray<Offer> => {
    if (r.draft === true || (!pre && r.prerelease === true)) return []
    const text = tagVersion(r.tag_name)
    const version = parseVersion(text)
    if (version === null) return []
    if (bad.some((b) => sameVersion(b, version))) return []
    const name = `huntaway-server-${text}-${platform}.tar.gz`
    const asset = (r.assets ?? []).find((a) => a.name === name && sha256Of(a) !== null)
    return asset === undefined ? [] : [{ version, release: r, asset }]
  })

/** The highest of `offered`. */
export const pick = (releases: ReadonlyArray<GhRelease>, platform: string, pre: boolean, bad: ReadonlyArray<string>): Offer | null =>
  offered(releases, platform, pre, bad).reduce<Offer | null>((best, o) => (best === null || compare(o.version, best.version) >= 0 ? o : best), null)

/** The release a check picked, with its manifest when it has one. */
export interface Latest extends Offer {
  readonly manifest: { readonly shell: string } | null
}

/**
 * The desktop package for an install `kind` in release `version`, as electron-builder names it: the pacman package with
 * `platform`'s arch, the AppImage with AppImage's own (`x86_64`, `arm64`).
 */
export const packageName = (kind: string, version: string, platform: string): string | null => {
  if (kind === "pacman") return `huntaway-${version}-${platform}.pacman`
  if (kind === "appimage") {
    const at = platform.indexOf("-")
    if (at < 0) return null
    const arch = platform.slice(at + 1)
    return `huntaway-${version}-${platform.slice(0, at)}-${arch === "x64" ? "x86_64" : arch}.AppImage`
  }
  return null
}

/** What the update area knows of the desktop app that started this server. */
export interface Desktop {
  readonly version: string | null
  readonly shell: string | null
  readonly install: string | null
  readonly platform: string
}

/** The desktop app this server was started by, and whether the latest release has a newer shell (null when no app started it). */
export const shellStatus = (desktop: Desktop, latest: Latest | null): DesktopShell | null => {
  if (desktop.version === null && desktop.install === null && desktop.shell === null) return null
  const install = desktop.install ?? "other"
  const at = install.indexOf(":")
  const kind = at < 0 ? install : install.slice(0, at)
  const path = at < 0 ? null : install.slice(at + 1)
  // Only a newer release's: an app installed from a release the checks don't pick (a prerelease, with them off) would
  // otherwise be offered an older package, which would start its older server on a database the newer one migrated.
  const app = desktop.version === null ? null : parseLoose(desktop.version)
  const newer = (l: Latest) => desktop.version === null || (app !== null && compare(l.version, app) > 0)
  const theirs = latest !== null && newer(latest) ? (latest.manifest?.shell ?? null) : null
  const outdated = theirs !== null && desktop.shell !== null ? theirs !== desktop.shell : false
  const name = latest === null ? null : packageName(kind, tagVersion(latest.release.tag_name), desktop.platform)
  const pkg = latest === null || name === null ? undefined : (latest.release.assets ?? []).find((a) => a.name === name)
  return { version: desktop.version, install: kind, path, outdated, package: pkg === undefined ? null : assetJson(pkg) }
}

/** HTTP reason phrases, for GitHub's refusals. */
const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

/** A status as `500 Internal Server Error`. */
export const statusText = (status: number) => `${status}${REASONS[status] === undefined ? "" : ` ${REASONS[status]}`}`

/**
 * When GitHub turned a request away for its rate limit: `{ reset }` (ISO, or null when it didn't say), else null.
 * `headers` are lower-case.
 */
export const rateLimit = (status: number, headers: Readonly<Record<string, string | undefined>>): { readonly reset: string | null } | null => {
  if ((status !== 403 && status !== 429) || headers["x-ratelimit-remaining"]?.trim() !== "0") return null
  const r = headers["x-ratelimit-reset"]?.trim()
  const seconds = r !== undefined && /^-?\d+$/.test(r) ? Number(r) : Number.NaN
  return { reset: Number.isFinite(seconds) ? DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)).replace(/\.\d{3}Z$/, "Z") : null }
}
