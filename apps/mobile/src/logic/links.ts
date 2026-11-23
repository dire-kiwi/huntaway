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

const parseUrl = (url: string, base?: string): URL | null => {
  try {
    return new URL(url, base)
  } catch {
    return null
  }
}

/** Whether a URL is one the phone may hand to the browser: a web or mail link. */
export const openable = (url: string): boolean => /^(https?|mailto):/i.test(url)

/** Where a link of a frame's page leads (`url` as the page resolved it against its `frameBase`); null for one that leads nowhere. */
export function frameLink(url: string): Target | null {
  const u = parseUrl(url)
  if (u === null) return null
  if (u.origin === FRAME_ORIGIN) return targetOfPath(u.pathname, u.search.slice(1))
  return openable(u.href) ? { kind: "external", url: u.href } : null
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
  const doc = docIn(parseUrl(url, FRAME_ORIGIN)?.pathname ?? "")
  return doc && { ...doc, version: doc.version ?? (typeof out["version"] === "number" ? out["version"] : null) }
}

/** Whether a URL is the board's: of its address, or of a host's own (an agent's links have 127.0.0.1). */
const ofBoard = (u: URL, board: URL | null): boolean =>
  u.origin === board?.origin || u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]"

/**
 * Where a link in a message leads: a document of this board opens in the app, whatever address the agent knew the board
 * by; a link to the board's own address opens what it names; anything else the browser. null for one that isn't a link
 * the phone follows.
 */
export function messageLink(link: string, boardUrl: string): Target | null {
  const board = parseUrl(boardUrl)
  const u = parseUrl(link, board?.href ?? FRAME_ORIGIN)
  if (u === null) return null
  if (/^https?:$/.test(u.protocol) && (u.origin === FRAME_ORIGIN || ofBoard(u, board))) {
    const doc = docIn(u.pathname, u.search.slice(1))
    if (doc !== null) return { kind: "page", ...doc.page }
    if (u.origin === FRAME_ORIGIN || u.origin === board?.origin) return targetOfPath(u.pathname, u.search.slice(1))
  }
  return openable(u.href) ? { kind: "external", url: u.href } : null
}
