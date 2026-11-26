import { parseJson } from "./json"

// Where a link leads, on the phone (HE-99). A plugin's page (a document: `/docs/<profile id>/d/<slug>/`) and a task
// open in the app; a page of the board's that the app hasn't (settings, a project's board) and any other site open in
// the browser. As the web board's router.ts and task/thread/docLinks.ts, for an app that has no address of its own.

/** One of a plugin's pages, as the app opens it. */
export interface PageRef {
  readonly plugin: string
  /** Under `/<plugin>/`, as the link had it: a path ending in `/` keeps it, so the page's relative links resolve. */
  readonly path: string
  /** Its query string, without the `?`. */
  readonly search: string
}

export type Target =
  | ({ readonly kind: "page" } & PageRef)
  | { readonly kind: "task"; readonly id: string }
  /** A page of the board's own that the app hasn't: `path` on the board's web address. */
  | { readonly kind: "web"; readonly path: string }
  | { readonly kind: "external"; readonly url: string }

/** What a plugin's id is (`@huntaway/plugin`'s rule). */
const PLUGIN_ID = /^[a-z][a-z0-9_]{0,31}$/

/** The first path segments that are the board's own pages, not a plugin's (apps/web/src/router.ts). */
const BOARD_PAGES = new Set(["profile", "assistant", "settings", "analytics", "guide", "hosts", "t", "g", "p", "api", "plugins", "assets"])

/** A path segment, decoded; one with a malformed escape (a mangled link) is taken as it is. */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** A page's path as `plugins.page` takes it: its segments, decoded, with no slash at either end. */
export const pagePath = (path: string): string => path.split("/").filter(Boolean).map(decode).join("/")

/** A page's address on the board (`/docs/<profile id>/d/<slug>/?details=1`). */
export const pageHref = (page: PageRef): string => `/${page.plugin}/${page.path}${page.search === "" ? "" : `?${page.search}`}`

/** Where the board's own path `pathname` (with `search`, its query string without the `?`) leads. */
export function targetOfPath(pathname: string, search = ""): Target {
  const [first = "", second] = pathname.split("/").filter(Boolean)
  if (first === "t" && second !== undefined) return { kind: "task", id: second }
  if (!BOARD_PAGES.has(first) && PLUGIN_ID.test(first)) {
    const path = pathname.replace(/^\/+/, "").slice(first.length).replace(/^\/+/, "")
    return { kind: "page", plugin: first, path, search }
  }
  return { kind: "web", path: `${pathname}${search === "" ? "" : `?${search}`}` }
}

/**
 * The address a frame's page has, for its links: the board's paths under an origin that is nobody's, since the app has
 * none. A link of the page's resolves against it (`frameBase`), and one that stays under it is the board's own.
 */
export const FRAME_ORIGIN = "http://board.invalid"

/** The address of a plugin's page in its frame. */
export const frameBase = (page: PageRef): string => `${FRAME_ORIGIN}${pageHref(page)}`

/**
 * An address in its parts, parsed by hand as logic/link.ts does: React Native's own `URL` leaves most of its getters
 * unimplemented. `origin` is `scheme://host[:port]` in lower case; `path` starts with `/` (or is empty).
 */
interface Parts {
  readonly origin: string
  /** The host, without a port. */
  readonly host: string
  readonly path: string
  /** Its query string, without the `?`. */
  readonly search: string
}

const WEB = /^(https?):\/\/([^/?#\s@]+)((?:\/[^?#\s]*)?)(?:\?([^#\s]*))?(?:#\S*)?$/i
const LOCAL = /^(\/[^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/

/** A web address's parts, or null for anything else (another scheme, a name and password before the host, spaces). */
const webParts = (url: string): Parts | null => {
  const m = WEB.exec(url.trim())
  if (!m) return null
  const [, scheme = "", authority = "", path = "", search = ""] = m
  const host = authority.toLowerCase()
  return { origin: `${scheme.toLowerCase()}://${host}`, host: host.replace(/:\d+$/, ""), path, search }
}

/** A board path's parts (`/docs/x?y#z`), or null for anything that doesn't start with one `/`. */
const pathParts = (path: string): Pick<Parts, "path" | "search"> | null => {
  const m = path.startsWith("//") ? null : LOCAL.exec(path.trim())
  return m ? { path: m[1] ?? "", search: m[2] ?? "" } : null
}

/** A query string (without its `?`) as names and values, decoded; a name given twice keeps its last value. */
export const queryOf = (search: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    search
      .split("&")
      .filter((pair) => pair !== "")
      .map((pair) => {
        const at = pair.indexOf("=")
        const [name, value] = at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)]
        return [decode(name.replaceAll("+", " ")), decode(value.replaceAll("+", " "))]
      }),
  )

/** Where a board path a page asked to go to leads (`/docs/<profile id>/d/<slug>/?details=1`); null for no board path. */
export const targetOfBoardPath = (path: string): Target | null => {
  const parts = pathParts(path)
  return parts && targetOfPath(parts.path, parts.search)
}

/** Whether a URL is one the phone may hand to the browser: a web or mail link. */
export const openable = (url: string): boolean => /^(https?|mailto):/i.test(url)

/** Where a link of a frame's page leads (`url` as the page resolved it against its `frameBase`); null for one that leads nowhere. */
export function frameLink(url: string): Target | null {
  const given = url.trim()
  const u = webParts(given)
  if (u?.origin === FRAME_ORIGIN) return targetOfPath(u.path === "" ? "/" : u.path, u.search)
  return openable(given) && (u !== null || /^mailto:\S+$/i.test(given)) ? { kind: "external", url: given } : null
}

/** A document's path on the board, from its `/docs/` on, with its slug and version (none: its latest). */
export interface DocRef {
  readonly page: PageRef
  readonly slug: string
  readonly version: number | null
}

/** The document `pathname` names, from its first `/docs/<profile>/d/<slug>` on, or null if it names none. */
function docIn(pathname: string, search = ""): DocRef | null {
  for (let i = pathname.indexOf("/docs/"); i >= 0; i = pathname.indexOf("/docs/", i + 1)) {
    const path = pathname.slice(i + "/docs/".length)
    const [profile, d, slug, ...rest] = path.split("/").filter(Boolean)
    if (profile === undefined || d !== "d" || slug === undefined) continue
    const version = rest[0] === "-" && rest[1] === "v" && /^[0-9]{1,15}$/.test(rest[2] ?? "") ? Number(rest[2]) : null
    return { page: { plugin: "docs", path, search }, slug: decode(slug), version }
  }
  return null
}

/**
 * The document a `publish_document` call's result names (its `version_url`, else its `url`), or null if it names none.
 * Its URLs start with the host's own address (127.0.0.1 unless it has a public URL), which a phone can't open: only
 * the path is taken, for the board the app is connected to.
 */
export function publishedDoc(content: string): DocRef | null {
  const parsed = parseJson(content)
  const out: Readonly<Record<string, unknown>> = typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {}
  const url = typeof out["version_url"] === "string" ? out["version_url"] : out["url"]
  if (typeof url !== "string") return null
  const doc = docIn(webParts(url)?.path ?? pathParts(url)?.path ?? "")
  return doc && { ...doc, version: doc.version ?? (typeof out["version"] === "number" ? out["version"] : null) }
}

/** A host's own names for itself: an agent's links to the board have them, since that is where the agent runs. */
const OWN_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Where a link in a message leads: a document of this board opens in the app, whatever address the agent knew the board
 * by; a link to the board's own address (`boardUrl`, as logic/link.ts gives it), or a path alone, opens what it names;
 * anything else the browser. null for one that isn't a link the phone follows.
 */
export function messageLink(link: string, boardUrl: string): Target | null {
  const given = link.trim()
  const local = pathParts(given)
  if (local !== null) return targetOfPath(local.path, local.search)
  const u = webParts(given)
  if (u === null) return /^mailto:\S+$/i.test(given) ? { kind: "external", url: given } : null
  const ours = u.origin === boardUrl.toLowerCase()
  if (ours || OWN_HOSTS.has(u.host)) {
    const doc = docIn(u.path, u.search)
    if (doc !== null) return { kind: "page", ...doc.page }
    if (ours) return targetOfPath(u.path === "" ? "/" : u.path, u.search)
  }
  return { kind: "external", url: given }
}
