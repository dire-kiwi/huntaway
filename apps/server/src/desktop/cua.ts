import { Option, Predicate, Schema } from "effect"
import { truncate } from "../git/paths.ts"

// Computer use's plain parts (huntaway's desktop.ts, desktop/driver.ts and mcp/desktop_mcp.ts; docs/plan/inventory/
// 05-hosts-update.md 2.8): the pinned Cua Driver release, the graphical session the driver needs, and what the agent is
// given of the driver's results. No I/O here.

/** One of Cua's release archives: where it is, and what it must be. */
export interface CuaRelease {
  readonly version: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * The Cua Driver release the host's page installs. Cua marks every driver release a prerelease. To bump, copy each
 * archive's size and SHA-256 from the release's assets (`gh api repos/trycua/cua/releases/tags/cua-driver-rs-v<version>`).
 */
export const CUA_VERSION = "0.41.3"

const ARCHIVES: Readonly<Record<string, { readonly name: string; readonly bytes: number; readonly sha256: string }>> = {
  "linux-x64": {
    name: `cua-driver-rs-${CUA_VERSION}-linux-x86_64-binary.tar.gz`,
    bytes: 38_375_345,
    sha256: "a00a7bc4a648adbcbc93bfbf5a058daf71ce8838ee172e33b197aaf649ecee14",
  },
  "linux-arm64": {
    name: `cua-driver-rs-${CUA_VERSION}-linux-arm64-binary.tar.gz`,
    bytes: 37_825_705,
    sha256: "9fe4b3a28eb0e1df9b48b26ba56c1c454966824bdd6e0f077d59d283d7c76cc4",
  },
  "darwin-universal": {
    name: `cua-driver-rs-${CUA_VERSION}-darwin-universal-binary.tar.gz`,
    bytes: 54_042_598,
    sha256: "af23b26a6e2e1cd0917536244ca0050b1447f2d344c958cdb79bfb3342282268",
  },
}

/** The pinned release for a platform, or null where Cua has none (or Huntaway doesn't run). */
export const pinnedRelease = (platform: string, arch: string): CuaRelease | null => {
  const key = platform === "darwin" ? "darwin-universal" : platform === "linux" && (arch === "x64" || arch === "arm64") ? `linux-${arch}` : null
  const a = key === null ? undefined : ARCHIVES[key]
  if (a === undefined) return null
  return { version: CUA_VERSION, url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}/${a.name}`, ...a }
}

/** An installed version's folder name: digits and dots. */
export const isVersion = (name: string): boolean => /^\d+(\.\d+)*$/u.test(name)

/** Versions newest first. */
export const newestFirst = (versions: ReadonlyArray<string>): ReadonlyArray<string> =>
  versions.toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))

/** A path in an archive that must not be unpacked: absolute, or with `..` in it. */
export const unsafeArchivePath = (listing: string): string | undefined => listing.split("\n").find((p) => p.startsWith("/") || p.split("/").includes(".."))

/** The environment of the user's graphical session, which a server started as a service may not have. */
export const SESSION_VARS = [
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_DESKTOP",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "SWAYSOCK",
  "NIRI_SOCKET",
] as const

export type Env = Readonly<Record<string, string | undefined>>

/**
 * `env` with what's missing of the graphical session filled in from `systemctl --user show-environment`'s output
 * (compositors import theirs into it), else a Wayland socket found in `XDG_RUNTIME_DIR` (`sockets`: that folder's
 * names). Only on Linux and only when neither display is set. Wayland needs `CUA_DRIVER_RS_ENABLE_WAYLAND`, as T3 Code
 * sets it.
 */
export const sessionEnv = (env: Env, linux: boolean, systemd: string, sockets: ReadonlyArray<string>): Env => {
  const out: Record<string, string | undefined> = { ...env }
  const has = (k: string) => out[k] !== undefined && out[k] !== ""
  if (linux && !has("WAYLAND_DISPLAY") && !has("DISPLAY")) {
    for (const line of systemd.split("\n")) {
      const eq = line.indexOf("=")
      const k = line.slice(0, eq)
      if (eq > 0 && SESSION_VARS.some((v) => v === k) && !has(k)) out[k] = line.slice(eq + 1)
    }
    if (!has("WAYLAND_DISPLAY") && !has("DISPLAY")) {
      const sock = sockets.find((f) => /^wayland-\d+$/u.test(f))
      if (sock !== undefined) out["WAYLAND_DISPLAY"] = sock
    }
  }
  if (has("WAYLAND_DISPLAY") && !has("CUA_DRIVER_RS_ENABLE_WAYLAND")) out["CUA_DRIVER_RS_ENABLE_WAYLAND"] = "1"
  return out
}

/** What kind of desktop the driver sees: "wayland", "x11", "macos", or null for none. */
export const sessionKind = (env: Env, platform: string): string | null =>
  platform === "darwin" ? "macos" : (env["WAYLAND_DISPLAY"] ?? "") !== "" ? "wayland" : (env["DISPLAY"] ?? "") !== "" ? "x11" : null

/** Screen lockers, which a locked screen on Linux is running even when logind isn't told. */
export const LOCKERS = ["hyprlock", "swaylock", "gtklock", "waylock", "i3lock", "xsecurelock", "slock"] as const

/** A tool's MCP result as the driver gives it: content (text, images), structured fields, and whether it failed. */
export const CuaResult = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
})
export type CuaResult = typeof CuaResult.Type

/** What a desktop tool answers the agent: MCP content, an error when it is one. */
export const DesktopContent = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
export type DesktopContent = typeof DesktopContent.Type

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const isText = Schema.is(TextPart)
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.optional(Schema.String) })
const isImage = Schema.is(ImagePart)
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A text answer, an error when `isError`. */
export const text = (t: string, isError = false): DesktopContent =>
  isError ? { content: [{ type: "text", text: t }], isError } : { content: [{ type: "text", text: t }] }

/** The texts of some content, joined by lines. */
export const textsOf = (content: ReadonlyArray<unknown>): string =>
  content
    .filter(isText)
    .map((c) => c.text)
    .join("\n")

/** The first image of a result, if any. */
export const imageOf = (r: CuaResult): { readonly data: string; readonly mime: string } | null => {
  const img = (r.content ?? []).find(isImage)
  return img === undefined ? null : { data: img.data, mime: img.mimeType ?? "image/png" }
}

/** A number field of a result's structured content, if it is one. */
export const structuredNumber = (r: CuaResult, key: string): number | null => {
  const sc = r.structuredContent
  const v = isRecord(sc) ? sc[key] : undefined
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** An integer, or null. */
export const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null)

/** The most of a result's structured fields given to the agent as JSON. */
const STRUCTURED_MAX = 30_000

const jsonText = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

/**
 * A driver's result as the agent gets it: its text and images, and its structured fields (`structuredContent`) as one
 * more line of JSON, without those whose text is in the text already. Not as `structuredContent`: Claude Code gives the
 * model a result's structured content in place of its text when it has some, which would hide the tree rows and hints
 * Cua writes as text.
 */
export const forAgent = (r: CuaResult): DesktopContent => {
  const content: Array<unknown> = [...(r.content ?? [])]
  const sc = r.structuredContent
  if (isRecord(sc)) {
    const said = textsOf(content)
    const rest = Object.fromEntries(Object.entries(sc).filter(([, v]) => !(typeof v === "string" && v.length > 40 && said.includes(v))))
    const json = Object.keys(rest).length > 0 ? Option.getOrNull(jsonText(rest)) : null
    if (json !== null) content.push({ type: "text", text: truncate(json, STRUCTURED_MAX) })
  }
  return r.isError === true ? { content, isError: true } : { content }
}

/** The text of a result, without its images, for the journal. */
export const resultText = (r: DesktopContent): string => truncate(textsOf(r.content), 20_000)

/** `text` as JSON (a quoted string), as the old summaries wrote it. */
const quoted = (s: string): string => Option.getOrElse(jsonText(s), () => `"${s}"`)

/** A value as text: a string as it is, anything else as JSON (as the old `String(v)` gave for the plain ones). */
const plain = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? `${v}` : Option.getOrElse(jsonText(v), () => "")

/** A step of an `act`, as an agent gives it. */
export interface Step {
  readonly tool: string
  readonly args?: Readonly<Record<string, unknown>> | undefined
}

/** A line for the board saying what an `act` does. */
export const actSummary = (steps: ReadonlyArray<Step>): string => {
  const say = (st: Step) => {
    const t = st.tool
    const args = st.args ?? {}
    const textArg = args["text"]
    const value = args["value"]
    const key = args["key"]
    const keys = args["keys"]
    if ((t === "type_text" || t === "type") && typeof textArg === "string") return `type ${quoted(truncate(textArg, 40))}`
    if (t === "set_value" && value !== undefined) return `set ${quoted(truncate(plain(value), 40))}`
    if ((t === "press_key" || t === "press") && key !== undefined && key !== null && key !== "") return `press ${plain(key)}`
    if (t === "hotkey" && Array.isArray(keys)) return `press ${keys.map(plain).join("+")}`
    return t.replace(/_/gu, " ")
  }
  const listed = steps.slice(0, 4).map(say).join(", ")
  return steps.length > 4 ? `${listed}, … (${steps.length} steps)` : listed === "" ? "no steps" : listed
}

/** `quoted`, for the clipboard's summary. */
export const quote = (s: string, max: number): string => quoted(truncate(s, max))
