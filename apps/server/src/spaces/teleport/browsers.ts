import { Option, Schema } from "effect"
import type { BrowserKind } from "@huntaway/contracts"
import type { TeleportApp } from "./bundle.ts"

// The browsers teleport can read on the host (HE-49), and how their profiles are laid out, plainly. Chromium-family
// browsers all keep the same profile shape (a `Cookies` SQLite and a `Local Storage/leveldb`) under their own config
// folder; Firefox keeps `cookies.sqlite` and a `storage` tree. A browser's profiles are listed from its `Local State`
// (Chromium) or `profiles.ini` (Firefox). No I/O here: it takes the files' contents.

/** A browser the host may have, by how its profile is read and where it keeps it. */
export interface BrowserCatalog {
  readonly key: string
  readonly kind: BrowserKind
  readonly label: string
  /** Its user-data dir (Chromium) or profiles root (Firefox) under the config folder (`$XDG_CONFIG_HOME`, `~/.config`). */
  readonly config: string
  /** Other places it may keep it, under the home, tried in order after the config folder's (snap, flatpak, legacy). */
  readonly elsewhere: ReadonlyArray<string>
  /** The spacesd teleport provider the bundle goes to. */
  readonly app: TeleportApp
  /**
   * The `application` its libsecret Safe Storage secret is kept under (Chromium's product name: `v11` cookies are
   * encrypted with it); null for Firefox. Chrome's and Chromium's were checked on a host; Brave's, Edge's and Vivaldi's
   * are their product names.
   */
  readonly keyring: string | null
}

/** The browsers teleport knows, in the order the dialog offers them. */
export const CATALOG: ReadonlyArray<BrowserCatalog> = [
  { key: "google-chrome", kind: "chromium", label: "Google Chrome", config: "google-chrome", elsewhere: [], app: "chrome", keyring: "chrome" },
  {
    key: "chromium",
    kind: "chromium",
    label: "Chromium",
    config: "chromium",
    elsewhere: ["snap/chromium/common/chromium", ".var/app/org.chromium.Chromium/config/chromium"],
    app: "chrome",
    keyring: "chromium",
  },
  { key: "brave", kind: "chromium", label: "Brave", config: "BraveSoftware/Brave-Browser", elsewhere: [], app: "chrome", keyring: "brave" },
  { key: "microsoft-edge", kind: "chromium", label: "Microsoft Edge", config: "microsoft-edge", elsewhere: [], app: "chrome", keyring: "microsoft-edge" },
  { key: "vivaldi", kind: "chromium", label: "Vivaldi", config: "vivaldi", elsewhere: [], app: "chrome", keyring: "vivaldi" },
  {
    key: "firefox",
    kind: "firefox",
    label: "Firefox",
    // Firefox 147 and later keep new profiles under the config folder; older ones, and snap and flatpak builds, elsewhere.
    config: "mozilla/firefox",
    elsewhere: [
      ".mozilla/firefox",
      "snap/firefox/common/.mozilla/firefox",
      ".var/app/org.mozilla.firefox/config/mozilla/firefox",
      ".var/app/org.mozilla.firefox/.mozilla/firefox",
    ],
    app: "firefox",
    keyring: null,
  },
]

/** Where a browser may keep its profiles, in the order they're tried: its config folder's place first. */
export const rootsOf = (b: BrowserCatalog, home: string, configHome: string): ReadonlyArray<string> => [
  `${configHome}/${b.config}`,
  ...b.elsewhere.map((d) => `${home}/${d}`),
]

export const catalogFor = (key: string): BrowserCatalog | null => CATALOG.find((b) => b.key === key) ?? null

const LocalState = Schema.Struct({
  profile: Schema.optional(
    Schema.Struct({
      info_cache: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) }))),
    }),
  ),
})
const decodeLocalState = Schema.decodeUnknownOption(Schema.fromJsonString(LocalState))

/** A Chromium directory's profiles, from its `Local State` JSON; `[{id: "Default", label: "Person 1"}]`. Falls back to `Default`. */
export const chromiumProfiles = (localState: string | null): ReadonlyArray<{ readonly id: string; readonly label: string }> => {
  const cache = localState === null ? undefined : Option.getOrUndefined(decodeLocalState(localState))?.profile?.info_cache
  if (cache === undefined || Object.keys(cache).length === 0) return [{ id: "Default", label: "Default" }]
  return Object.entries(cache)
    .map(([id, info]) => ({ id, label: info.name !== undefined && info.name.trim() !== "" ? info.name : id }))
    .toSorted((a, b) => (a.id === "Default" ? -1 : b.id === "Default" ? 1 : a.id.localeCompare(b.id)))
}

/**
 * Firefox profiles from `profiles.ini`: `[{id: "<relative path>", label: "<name>"}]`. A relative path is kept relative
 * (joined to the firefox dir by the reader); an absolute one is kept as it is.
 */
export const firefoxProfiles = (ini: string | null): ReadonlyArray<{ readonly id: string; readonly label: string }> => {
  if (ini === null) return []
  const out: Array<{ id: string; label: string }> = []
  let current: { name?: string; path?: string; isRelative?: boolean } | null = null
  const flush = () => {
    if (current?.path !== undefined) out.push({ id: current.path, label: current.name !== undefined && current.name !== "" ? current.name : current.path })
    current = null
  }
  for (const raw of ini.split(/\r?\n/u)) {
    const line = raw.trim()
    if (/^\[Profile/iu.test(line)) {
      flush()
      current = {}
    } else if (current !== null) {
      const eq = line.indexOf("=")
      if (eq < 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (k === "name") current.name = v
      else if (k === "path") current.path = v
      else if (k === "isrelative") current.isRelative = v === "1"
    }
  }
  flush()
  return out
}
