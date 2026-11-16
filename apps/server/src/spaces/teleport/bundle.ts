// The bundle a teleport sends (HE-49), in the format spacesd's receiver reads (Cua's `cua-teleport-bundle`,
// `BUNDLE_VERSION` 1), written here from its description rather than its code: a tar archive whose first entry is
// `manifest.json` (`{provider_id, app_display_name, scope, entries: [{rel_path, mode, byte_len, sha256}]}`, one entry for
// each file after it), then those files. Sign-ins go in its reserved entries, which the receiver installs into the Space's
// browser itself rather than writing them as files:
//
// - `cookies.json`: the cookies, already decrypted, as Chrome's rows (`host_key`, `name`, `value` in base64, `path`,
//   `expires_utc` in microseconds since 1601, `is_secure`, `is_httponly`, `samesite`…). The receiver encrypts them again
//   with the Space's own key, for Chromium and Firefox alike.
// - `localstorage.json`: `[{origin, key, value}]`.
// - `tabs.json` (Chromium's; Firefox's is `firefox/tabs.json`): the URLs to open, none here.
//
// No I/O here: the entries' SHA-256s are given.

import { Base64 } from "effect/encoding"

/** Where the bundle goes in the Space: its Chromium (spacesd's `chrome` provider) or its Firefox. */
export type TeleportApp = "chrome" | "firefox"

/** One cookie as the bundle carries it (Chrome's row). */
export interface CookieRow {
  readonly host_key: string
  readonly name: string
  readonly value: Uint8Array
  readonly path: string
  /** Microseconds since 1601-01-01; 0 for a session cookie. */
  readonly expires_utc: number
  readonly is_secure: boolean
  readonly is_httponly: boolean
  /** -1 unspecified, 0 none, 1 lax, 2 strict. */
  readonly samesite: number
  readonly creation_utc?: number | undefined
  readonly last_access_utc?: number | undefined
}

/** One localStorage value. */
export interface StorageItem {
  readonly origin: string
  readonly key: string
  readonly value: string
}

/** A bundle file as bytes (what the tar holds). */
export interface BundleFile {
  readonly path: string
  readonly mode: number
  readonly bytes: Uint8Array
}

/** A bundle entry before its JSON is encoded: its path, mode, and the value to serialize. The caller encodes (through Effect). */
export interface BundleEntry {
  readonly path: string
  readonly mode: number
  readonly value: unknown
}

/** The entries of a sign-in bundle for `app`, before its manifest: `tabs.json` (none), `cookies.json`, `localstorage.json`. */
export const signInEntries = (app: TeleportApp, cookies: ReadonlyArray<CookieRow>, storage: ReadonlyArray<StorageItem>): ReadonlyArray<BundleEntry> => [
  { path: app === "chrome" ? "tabs.json" : "firefox/tabs.json", mode: 0o644, value: [] },
  {
    path: "cookies.json",
    mode: 0o600,
    value: cookies.map((c) => ({
      host_key: c.host_key,
      name: c.name,
      value: Base64.encode(c.value),
      path: c.path,
      expires_utc: c.expires_utc,
      is_secure: c.is_secure,
      is_httponly: c.is_httponly,
      samesite: c.samesite,
      ...(c.creation_utc === undefined ? {} : { creation_utc: c.creation_utc }),
      ...(c.last_access_utc === undefined ? {} : { last_access_utc: c.last_access_utc }),
    })),
  },
  { path: "localstorage.json", mode: 0o600, value: storage },
]

/** The `manifest.json` value for the (already-encoded) files `parts`, whose SHA-256s (lowercase hex) are `sums`, in order. */
export const manifestValue = (app: TeleportApp, parts: ReadonlyArray<BundleFile>, sums: ReadonlyArray<string>): unknown => ({
  provider_id: app,
  app_display_name: app === "chrome" ? "Chromium" : "Firefox",
  scope: "full_profile",
  entries: parts.map((f, i) => ({ rel_path: f.path, mode: f.mode, byte_len: f.bytes.length, sha256: sums[i] ?? "" })),
})

// ---- tar (POSIX ustar) ----

const BLOCK = 512

const octal = (n: number, width: number): string => `${n.toString(8).padStart(width - 1, "0")}\0`

const header = (f: BundleFile): Uint8Array => {
  const h = new Uint8Array(BLOCK)
  const put = (at: number, s: string) => h.set(new TextEncoder().encode(s), at)
  put(0, f.path)
  put(100, octal(f.mode, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(f.bytes.length, 12))
  put(136, octal(0, 12))
  h.fill(0x20, 148, 156)
  put(156, "0")
  put(257, "ustar\u000000")
  const sum = h.reduce((a, b) => a + b, 0)
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `)
  return h
}

/** The files as a tar archive, in order (`manifest.json` first), ending with its two empty blocks. */
export const tar = (files: ReadonlyArray<BundleFile>): Uint8Array => {
  const size = files.reduce((n, f) => n + BLOCK + Math.ceil(f.bytes.length / BLOCK) * BLOCK, 2 * BLOCK)
  const out = new Uint8Array(size)
  let at = 0
  // Every path is one of `signInFiles`' and `manifestFile`'s, well under ustar's 100 bytes.
  for (const f of files) {
    out.set(header(f), at)
    out.set(f.bytes, at + BLOCK)
    at += BLOCK + Math.ceil(f.bytes.length / BLOCK) * BLOCK
  }
  return out
}
