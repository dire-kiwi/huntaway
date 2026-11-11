// The desktop shell's decisions, as plain functions: which server version to start, which shell to load, when to relaunch,
// how the app was installed and what it can install of itself. No I/O here: the callers read `app/state.json` and look at
// the files, and pass what they found. Plain TypeScript with no effect import, because the frame (src/boot) uses it too,
// and the frame stays small and stable (its stamp is what says the app needs a new package).
//
// `app/state.json` is shared with the server's `Releases` service (docs/plan/inventory/05-hosts-update.md §3.7):
//
//   current   the version that last came up (the server sets it once it is listening)
//   previous  the one before it, kept for a rollback
//   staged    downloaded and checked, waiting for a click on Update: never started from here
//   trying    the one an Update is exec'ing into; the server clears it once that one is listening
//   bad       versions that did not start, which are passed over
//
// Both write it through a temp file and a rename, and keep each other's keys. The shell writes it only to mark versions
// bad, once a server it started has come up (startWithFallback in src/main/fallback.ts).

/** What `boot` offers a shell. A release's `electron/shell.json` names the lowest it needs; one needing more is not loaded. */
export const BOOT_API = 1

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

type Parsed = readonly [number, number, number, ReadonlyArray<string>]

/** `v` as [major, minor, patch, prerelease identifiers], or null when it is not semver. */
export const parseVersion = (v: unknown): Parsed | null => {
  const m = typeof v === "string" ? SEMVER.exec(v.trim()) : null
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split(".")]
}

/** Semver precedence of two versions (negative, 0 or positive), or NaN when either is not semver. 1.0.0-rc.1 < 1.0.0. */
export const compareVersions = (a: unknown, b: unknown): number => {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) return Number.NaN
  for (const i of [0, 1, 2] as const) if (x[i] !== y[i]) return x[i] - y[i]
  const [p, q] = [x[3], y[3]]
  // A release is above its prereleases.
  if (p.length === 0 || q.length === 0) return q.length - p.length
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    const [s, t] = [p[i] ?? "", q[i] ?? ""]
    if (s === t) continue
    const [n, m] = [/^\d+$/.test(s), /^\d+$/.test(t)]
    // Numeric identifiers compare as numbers, and below alphanumeric ones.
    if (n && m) return Number(s) - Number(t)
    if (n !== m) return n ? -1 : 1
    return s < t ? -1 : 1
  }
  return p.length - q.length
}

/** `app/state.json` as read: an object (unknown keys kept), `{}` when there is none or it is not one. */
export type AppState = Readonly<Record<string, unknown>>

/** A parsed JSON value as an object of the kind state.json, shell-state.json and desktop.json hold, else `{}`. */
export const asObject = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}

/** The strings in `state[key]` when it is an array. */
export const stringList = (state: AppState, key: string): ReadonlyArray<string> => {
  const value = state[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/** Add `version` to `bad` and, if it is the one being tried, clear `trying` (to null). Keeps the keys this does not know. */
export const markBad = (state: AppState, version: string): AppState => {
  const bad = stringList(state, "bad")
  return { ...state, bad: bad.includes(version) ? bad : [...bad, version], ...(state["trying"] === version ? { trying: null } : {}) }
}

/** The server's executable in a version's folder: `huntaway`, or `huntaway.exe`. */
export const serverExe = (platform: string): string => (platform === "win32" ? "huntaway.exe" : "huntaway")

/** The files a version needs, relative to its folder: its server, the shim its agents run under, and the UI it serves. */
export const serverFiles = (exe: string): ReadonlyArray<string> => [exe, exe.replace(/^huntaway/, "ia-shim"), "ui/index.html"]

/** The versions state.json says to try, in order: `trying`, `current`, `previous`. `staged` is never started from here. */
const candidates = (state: AppState): ReadonlyArray<unknown> => [state["trying"], state["current"], state["previous"]]

/**
 * The installed version for a release build to start: `trying`, then `current`, then `previous`, the first that is at
 * least as new as the app (`minVersion`, so a newer package wins over older downloads), is not bad (in `state.bad` or
 * `skip`) and has all its files (`installed`). Null for the bundled server. A version that is not semver is never
 * started (and so can't lead out of `app/`).
 */
export const chooseServer = (options: {
  readonly state: AppState
  readonly minVersion: string
  readonly skip?: ReadonlyArray<string>
  readonly installed: (version: string) => boolean
}): string | null => {
  const bad = new Set([...stringList(options.state, "bad"), ...(options.skip ?? [])])
  for (const v of candidates(options.state)) {
    if (typeof v !== "string" || bad.has(v) || !(compareVersions(v, options.minVersion) >= 0)) continue
    if (options.installed(v)) return v
  }
  return null
}

/**
 * The release whose shell to load, or null for the package's own. It is the shell of the version the server will start
 * (as `chooseServer` picks it, with no `skip`), never an older version's: if that version's shell is marked bad in
 * `shell-state.json` (`shellBad`) or can't run here (`usable`: its `electron/main.cjs` and a `shell.json` that suits this
 * Electron and boot), the package's shell runs.
 */
export const chooseShell = (options: {
  readonly state: AppState
  readonly shellBad: ReadonlyArray<string>
  readonly appVersion: string
  readonly installed: (version: string) => boolean
  readonly usable: (version: string) => boolean
}): string | null => {
  const version = chooseServer({ state: options.state, minVersion: options.appVersion, installed: options.installed })
  if (version === null || options.shellBad.includes(version)) return null
  return options.usable(version) ? version : null
}

/** Whether a release's `electron/shell.json` suits this app: the same Electron major version, and a boot API it offers. */
export const shellSuits = (meta: unknown, electronVersion: string): boolean => {
  const shell = asObject(meta)
  const electron = shell["electron"]
  const boot = shell["boot"]
  if (typeof electron !== "string" || electron.split(".")[0] !== electronVersion.split(".")[0]) return false
  return typeof boot === "number" && boot <= BOOT_API
}

/** What the frame (src/boot) gives the shell it loads, as `globalThis.huntawayBoot`. Unchanged from the old boot.cjs. */
export interface BootApi {
  readonly api: number
  /** The release whose shell is running, or null for the package's own. */
  readonly running: { readonly version: string } | null
  /** Which shell the frame would load now (the answer the next start acts on). */
  readonly choose: () => { readonly version: string } | null
}

/**
 * Why the app should relaunch, or null. With a frame that loads releases' shells (`boot`): when the shell it would load
 * now (`chosen`) differs from the running one. That comes first, because an Update or a Roll back can delete the running
 * shell's folder, which then can't be hashed. A shell loaded from a release never changes in place, so its stamp is not
 * compared; otherwise (a checkout, or the package's own shell) the stamp of the running shell's files now (`stampNow`,
 * null when they can't be read, which is no change) against the one at start.
 */
export const shellChange = (options: {
  readonly boot: { readonly running: string | null; readonly chosen: string | null } | null
  readonly stampNow: string | null
  readonly startStamp: string
}): string | null => {
  const { boot } = options
  if (boot !== null && boot.chosen !== boot.running) return "an update brought a different desktop shell"
  if (boot !== null && boot.running !== null) return null
  return options.stampNow !== null && options.stampNow !== options.startStamp ? "the desktop app changed on disk" : null
}

/** What the app can install of its own package for an install kind (`installKind`): "appimage", "pacman", or null. */
export type UpdateKind = "appimage" | "pacman"

export const updateKind = (install: string | null): UpdateKind | null => {
  if (install === null) return null
  if (install.startsWith("appimage:")) return "appimage"
  return install === "pacman" ? "pacman" : null
}

/**
 * How this app was installed, for the server's shell updates (`HUNTAWAY_DESKTOP_INSTALL`): `appimage:<file>`, `pacman`
 * (the package's files in /opt, owned by pacman: `pacmanOwns` asks, only then), `mac:<.app>`, or `other`.
 */
export const installKind = (options: {
  readonly platform: string
  readonly appimage: string | null
  readonly resourcesPath: string
  readonly pacmanOwns: () => boolean
}): string => {
  if (options.appimage !== null && options.appimage !== "") return `appimage:${options.appimage}`
  if (options.platform === "darwin") {
    const bundle = options.resourcesPath.replace(/\/+$/, "").split("/").slice(0, -2).join("/")
    if (bundle.endsWith(".app")) return `mac:${bundle}`
  }
  if (options.platform === "linux" && options.resourcesPath.startsWith("/opt/") && options.pacmanOwns()) return "pacman"
  return "other"
}

/** `<os>-<arch>` as a release's asset names have it (`linux-x64`, `mac-arm64`). */
export const assetPlatform = (platform: string, arch: string): string => `${platform === "darwin" ? "mac" : platform}-${arch}`

/**
 * The package for an install kind in release `version`, as electron-builder names it: the pacman package with the
 * platform's arch (`linux-x64`), the AppImage with AppImage's own (`linux-x86_64`).
 */
export const packageName = (kind: UpdateKind, version: string, platform: string): string => {
  if (kind === "pacman") return `huntaway-${version}-${platform}.pacman`
  const [os = "", arch = ""] = platform.split("-")
  return `huntaway-${version}-${os}-${arch === "x64" ? "x86_64" : arch}.AppImage`
}

/** The repository whose releases a release build follows, unless `HUNTAWAY_RELEASE_UPDATES` says otherwise. */
export const RELEASE_REPO = "dire-kiwi/huntaway"

/**
 * The environment that turns release updates on for a server a release build starts, and tells it about the app.
 * `HUNTAWAY_RELEASE_UPDATES` in the shell's own environment wins (a blank one turns them off). It is the environment
 * rather than flags so that an older bundled server, which has no such flags, ignores it.
 */
export const releaseEnv = (options: {
  readonly releaseUpdates: string | null
  readonly version: string
  readonly shell: string
  readonly install: string
  readonly bundled: string
}): Readonly<Record<string, string>> => ({
  HUNTAWAY_RELEASE_UPDATES: options.releaseUpdates ?? RELEASE_REPO,
  HUNTAWAY_DESKTOP_VERSION: options.version,
  HUNTAWAY_DESKTOP_SHELL: options.shell,
  HUNTAWAY_DESKTOP_INSTALL: options.install,
  HUNTAWAY_BUNDLED_SERVER: options.bundled,
})
