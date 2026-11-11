// Docs (HA-281): each profile's documents, which its agents publish through the run's `docs` MCP server, on the board at
// `/docs/<profile>` (see the `docs` route in router.ts). They're kept by each host for its own profiles, so a profile
// merged across hosts by name has the documents of each of them (6.3: every host has Docs).
import type { Host } from "@huntaway/contracts"
import type { HostProfile as Profile } from "@huntaway/client"
import { href, parse, type Route } from "../../router"
import { rpc } from "../../state/rpc"
import { parseJson, toJson } from "../ui/json"
import { ProfileId } from "@huntaway/contracts"

/** A rendered page's `<img>` that is one of its document's images: the server's marker for it, with the image's sha256. */
export const DOC_IMAGE_SRC = /\ssrc="\/api\/profiles\/[^/"]+\/doc_images\/([0-9a-f]{64})"/g

/** A host's profile whose documents the Docs page shows. */
export interface DocsHome {
  hostId: string
  profileId: string
}

/**
 * The profile a docs route names (`segment`: its name, or a profile's id, as agents' links have it) and where its
 * documents are: that profile, or each profile of that name, on the connected hosts that have Docs, this board's host
 * first.
 */
export function docsHomes(profiles: ReadonlyArray<Profile>, hosts: ReadonlyArray<Host>, segment: string): { name: string; homes: DocsHome[] } {
  const byId = profiles.filter((p) => p.id === segment)
  const named = byId.length ? byId : profiles.filter((p) => p.name === segment)
  const homes = named
    .flatMap((p) => {
      const host = hosts.find((h) => h.id === p.host_id)
      return host?.connected === true ? [{ p, host }] : []
    })
    .toSorted((a, b) => Number(b.host.local) - Number(a.host.local))
    .map(({ p }) => ({ hostId: p.host_id, profileId: p.id }))
  return { name: named[0]?.name ?? segment, homes }
}

/** The profile's name a docs route's `segment` stands for. */
export const docsProfileName = (profiles: ReadonlyArray<Profile>, segment: string) => profiles.find((p) => p.id === segment)?.name ?? segment

/** A page path's URL under its version's base (docs-render's urlSuffix): `plan/index` → `plan`, `index` → ``. */
export const pageSuffix = (path: string) => (path === "index" ? "" : path.replace(/\/index$/, ""))

/**
 * The board's own path for the version a `publish_document` call's result names (its `version_url`, else its `url`), or
 * null if it names none. Its URLs start with the host's address, which is its internal one (127.0.0.1) unless it has a
 * public URL, and so not one another device or a hub's user can open: the path is taken from them, for the board this
 * page is served from. A public URL may have a path of its own before the board's (`https://example.com/board/docs/…`).
 */
export function publishedDocPath(content: string): { path: string; slug: string; version: number | null } | null {
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
  const route = docRouteIn(pathname)
  return route && { path: href(route), slug: route.slug, version: route.version ?? (typeof out["version"] === "number" ? out["version"] : null) }
}

type DocRoute = Extract<Route, { name: "docs" }> & { slug: string }

/** A docs route, if it names a document. */
export const docRoute = (route: Route): DocRoute | null => (route.name === "docs" && route.slug !== undefined ? { ...route, slug: route.slug } : null)

/** The document's route in a path: the first from a `/docs/` on that's a document's. */
function docRouteIn(pathname: string): DocRoute | null {
  for (let i = pathname.indexOf("/docs/"); i >= 0; i = pathname.indexOf("/docs/", i + 1)) {
    const route = docRoute(parse(pathname.slice(i)))
    if (route !== null) return route
  }
  return null
}

/** Whether a URL is this board's: relative, of this page's origin, or of the host's own address (an agent's links have 127.0.0.1). */
const isBoardOrigin = (u: URL) => u.origin === window.location.origin || u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]"

/**
 * The route of the document a link in a message points at (HA-321: such a link opens in the board, whatever address
 * the agent knew the board by), or null for any other link. A link to the hosted docs site or to another site isn't one.
 */
export function boardDocLink(link: string | undefined): { route: DocRoute; path: string } | null {
  if (!link) return null
  let url: URL
  try {
    url = new URL(link, window.location.origin)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !isBoardOrigin(url) || !url.pathname.startsWith("/docs/")) return null
  const route = docRoute(parse(url.pathname))
  if (route === null) return null
  return { route, path: href(route) + url.search + url.hash }
}

/** A folder of the Docs page's tree (HA-290): its folders first, then its documents, each sorted by name. */
export interface DocFolder<T> {
  /** Its last segment ("" for the top level). */
  name: string
  /** Its whole path ("" for the top level). */
  path: string
  folders: DocFolder<T>[]
  docs: T[]
  /** How many documents are in it and in its folders. */
  count: number
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || a.localeCompare(b)

/**
 * Documents as a tree of their folders (a document's `folder` is a '/'-separated path, "" or missing for the top level,
 * as hosts before HA-290 give them). Each document is one entry, whatever pages it has. A folder is there while a
 * document is in it.
 */
export function docTree<T extends { folder?: string; title: string; slug: string }>(docs: ReadonlyArray<T>): DocFolder<T> {
  const root: DocFolder<T> = { name: "", path: "", folders: [], docs: [], count: 0 }
  for (const d of docs) {
    let at = root
    at.count++
    for (const name of (d.folder ?? "").split("/").filter(Boolean)) {
      const path = at.path ? `${at.path}/${name}` : name
      let next = at.folders.find((f) => f.name === name)
      if (!next) at.folders.push((next = { name, path, folders: [], docs: [], count: 0 }))
      next.count++
      at = next
    }
    at.docs.push(d)
  }
  const sort = (f: DocFolder<T>) => {
    f.folders.sort((a, b) => byName(a.name, b.name))
    f.docs.sort((a, b) => byName(a.title, b.title) || a.slug.localeCompare(b.slug))
    f.folders.forEach(sort)
  }
  sort(root)
  return root
}

/** Every folder of a tree, the folders inside them included, in the tree's order: the paths a move suggests. */
export function folderPaths<T>(tree: DocFolder<T>): string[] {
  return tree.folders.flatMap((f) => [f.path, ...folderPaths(f)])
}

/** A label of the Docs page's Labels view (HA-324): the labels inside it first, then the documents with it, each sorted by name. */
export interface DocLabel<T> {
  /** Its last segment, spelt as its first document spells it ("" for the top). */
  name: string
  /** Its whole path ("" for the top). */
  path: string
  labels: DocLabel<T>[]
  /** The documents with this label itself. */
  docs: T[]
  /** How many documents have it or a label inside it, each once. */
  count: number
}

/**
 * Documents as a tree of their labels ('/'-separated paths, which match whatever their case): a document is under each
 * of its labels, and those without one are `unlabelled` (all of them, from hosts before HA-324).
 */
export function labelTree<T extends { labels?: ReadonlyArray<string>; title: string; slug: string }>(
  docs: ReadonlyArray<T>,
): { root: DocLabel<T>; unlabelled: T[] } {
  const root: DocLabel<T> = { name: "", path: "", labels: [], docs: [], count: 0 }
  const unlabelled: T[] = []
  const counted = new Map<DocLabel<T>, Set<T>>()
  const count = (l: DocLabel<T>, d: T) => {
    const seen = counted.get(l) ?? new Set()
    counted.set(l, seen.add(d))
    l.count = seen.size
  }
  for (const d of docs) {
    const labels = (d.labels ?? [])
      .map((l) =>
        l
          .split("/")
          .map((seg) => seg.trim())
          .filter(Boolean),
      )
      .filter((segs) => segs.length)
    if (!labels.length) unlabelled.push(d)
    for (const segs of labels) {
      let at = root
      count(at, d)
      for (const name of segs) {
        let next = at.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())
        if (!next) at.labels.push((next = { name, path: at.path ? `${at.path}/${name}` : name, labels: [], docs: [], count: 0 }))
        count(next, d)
        at = next
      }
      if (!at.docs.includes(d)) at.docs.push(d)
    }
  }
  const byDoc = (a: T, b: T) => byName(a.title, b.title) || a.slug.localeCompare(b.slug)
  const sort = (l: DocLabel<T>) => {
    l.labels.sort((a, b) => byName(a.name, b.name))
    l.docs.sort(byDoc)
    l.labels.forEach(sort)
  }
  sort(root)
  unlabelled.sort(byDoc)
  return { root, unlabelled }
}

/** Every label of a tree, the labels inside them included, in the tree's order: the labels the editor suggests. */
export function labelPaths<T>(tree: DocLabel<T>): string[] {
  return tree.labels.flatMap((l) => [l.path, ...labelPaths(l)])
}

/** How the Docs page shows documents: by folder or by label (HA-324), the user's choice, kept in this browser. */
export type DocsView = "folders" | "labels"
const VIEW_KEY = "ia.docs.view"

export function docsView(): DocsView {
  try {
    return localStorage.getItem(VIEW_KEY) === "labels" ? "labels" : "folders"
  } catch {
    return "folders"
  }
}

export function saveDocsView(view: DocsView) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // It's the page's own until it's left, when storage is unavailable.
  }
}

/** Where a host's profile's closed folders (or labels) on the Docs page are kept in this browser. */
const closedKey = (home: DocsHome, kind: DocsView) => `ia.docs.${kind === "labels" ? "closedLabels" : "closedFolders"}:${home.hostId}:${home.profileId}`

/** The folders (or labels) of a host's profile that were closed on the Docs page (all open, the first time). */
export function closedFolders(home: DocsHome, kind: DocsView = "folders"): Set<string> {
  try {
    const value = parseJson(localStorage.getItem(closedKey(home, kind)) ?? "[]")
    return new Set(Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [])
  } catch {
    return new Set()
  }
}

export function saveClosedFolders(home: DocsHome, closed: Set<string>, kind: DocsView = "folders") {
  try {
    if (closed.size) localStorage.setItem(closedKey(home, kind), toJson([...closed]))
    else localStorage.removeItem(closedKey(home, kind))
  } catch {
    // They stay as they are until the page is left, when storage is unavailable.
  }
}

/** A folder renamed from `from` to `to`, for folder `path` (in it, or one inside it): its new path, or null if it isn't in it. */
export function renamedFolder(path: string, from: string, to: string): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) return null
  return `${to}${path.slice(from.length)}`.replace(/^\/+/, "")
}

/**
 * Documents' images (HA-327) as data: URLs, by host, profile and hash, most recently used last: an image never changes,
 * so each is fetched once while it's kept. A failed fetch isn't kept, so it's tried again with the page.
 */
const images = new Map<string, Promise<string | null>>()
const KEEP_IMAGES = 60

function docImage(hostId: string, profileId: string, sha: string): Promise<string | null> {
  const key = `${hostId}/${profileId}/${sha}`
  let got = images.get(key)
  if (got) images.delete(key)
  else
    got = rpc(hostId, "docs.image", { profile_id: ProfileId.make(profileId), sha256: sha }).then(
      (im) => `data:${im.mime === "image/avif" ? im.mime : "image/avif"};base64,${im.data}`,
      () => (images.delete(key), null),
    )
  images.set(key, got)
  for (const old of [...images.keys()].slice(0, Math.max(0, images.size - KEEP_IMAGES))) images.delete(old)
  return got
}

/**
 * A rendered page's HTML with its images (their `src`, the host's route for each) as data: URLs, which the page's frame
 * can show: it's sandboxed, with no origin of its own, so it can't fetch them with the board's token, nor read the
 * board's blob: URLs. One that can't be fetched loses its `src`, and shows its alt text.
 */
export function withDocImages(html: string, hostId: string, profileId: string): Promise<string> {
  const shas = [...new Set([...html.matchAll(DOC_IMAGE_SRC)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])))]
  if (!shas.length) return Promise.resolve(html)
  return Promise.all(shas.map((sha) => docImage(hostId, profileId, sha).then((url) => [sha, url] as const))).then((pairs) => {
    const urls = new Map(pairs)
    return html.replace(DOC_IMAGE_SRC, (_, sha: string) => {
      const url = urls.get(sha)
      return url ? ` src="${url}"` : ""
    })
  })
}
