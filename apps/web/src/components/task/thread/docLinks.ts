// Links to the board's documents in a thread (HA-281, HA-321). The documents are the docs plugin's (HE-42): its pages
// are at `/docs/<profile id>/d/<slug>/[-/v/<n>/][<page>]`, the paths the built-in documents had, so the links agents
// were given keep working, and the board opens them as the plugin's page (the `plugin` route).
import { parseJson } from "../../ui/json"

/** A document's path on the board, from its `/docs/` on, with its slug and version (none: its latest). */
export interface DocPath {
  readonly path: string
  readonly slug: string
  readonly version: number | null
}

/** The document `pathname` names, from its first `/docs/<profile>/d/<slug>` on, or null if it names none. */
function docPathIn(pathname: string): DocPath | null {
  for (let i = pathname.indexOf("/docs/"); i >= 0; i = pathname.indexOf("/docs/", i + 1)) {
    const path = pathname.slice(i)
    const [, profile, d, slug, ...rest] = path.split("/").filter(Boolean)
    if (profile === undefined || d !== "d" || slug === undefined || slug === "") continue
    const version = rest[0] === "-" && rest[1] === "v" && /^[0-9]{1,15}$/.test(rest[2] ?? "") ? Number(rest[2]) : null
    let decoded = slug
    try {
      decoded = decodeURIComponent(slug)
    } catch {
      // A malformed escape (a mangled link) is taken as it is.
    }
    return { path, slug: decoded, version }
  }
  return null
}

/**
 * The board's own path for the version a `publish_document` call's result names (its `version_url`, else its `url`), or
 * null if it names none. Its URLs start with the host's address, which is its internal one (127.0.0.1) unless it has a
 * public URL, and so not one another device or a hub's user can open: the path is taken from them, for the board this
 * page is served from. A public URL may have a path of its own before the board's (`https://example.com/board/docs/…`).
 */
export function publishedDocPath(content: string): DocPath | null {
  const parsed = parseJson(content)
  const out: Readonly<Record<string, unknown>> = typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {}
  const url = typeof out["version_url"] === "string" ? out["version_url"] : out["url"]
  if (typeof url !== "string") return null
  let pathname: string
  try {
    pathname = new URL(url, "http://board").pathname
  } catch {
    return null
  }
  const doc = docPathIn(pathname)
  return doc && { ...doc, version: doc.version ?? (typeof out["version"] === "number" ? out["version"] : null) }
}

/** Whether a URL is this board's: relative, of this page's origin, or of the host's own address (an agent's links have 127.0.0.1). */
const isBoardOrigin = (u: URL) => u.origin === window.location.origin || u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]"

/**
 * The document a link in a message points at (HA-321: such a link opens in the board, whatever address the agent knew
 * the board by), with its query and fragment, or null for any other link. A link to a hosted docs site or to another
 * site isn't one.
 */
export function boardDocLink(link: string | undefined): DocPath | null {
  if (!link) return null
  let url: URL
  try {
    url = new URL(link, window.location.origin)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !isBoardOrigin(url) || !url.pathname.startsWith("/docs/")) return null
  const doc = docPathIn(url.pathname)
  return doc && { ...doc, path: doc.path + url.search + url.hash }
}
