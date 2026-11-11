// The board's routes: parse a path into a `Route` and back (inventory 10, section 7). Pure: `state/route.ts` keeps the
// page's URL as an atom over the History API and uses these.

export type Route =
  | { name: "home" }
  | { name: "profile"; profile: string }
  /** The profile's assistant, full width. */
  | { name: "assistant"; profile: string }
  /**
   * The profile's documents: its list, or document `slug` (its latest version, or version `version`) at page `page`,
   * the page's URL suffix (`plan/phase-1`, `plan` for `plan/index`, `` for `index`). `profile` is its name, or a
   * profile's id, as the links agents get have it (`/docs/<profile id>/d/<slug>/[-/v/<n>/][<page>]`).
   */
  | { name: "docs"; profile: string; slug?: string; version?: number; page?: string }
  | { name: "board"; projectId: string }
  | { name: "group"; hostId: string; group: string }
  /** `tab` is the section of the settings open, the first one when it's missing. */
  | { name: "projectSettings"; projectId: string; tab?: string }
  | { name: "task"; taskId: string }
  /** `tab` is the section of the settings open, the first one when it's missing. */
  | { name: "settings"; tab?: string }
  /** Analytics, of profile `profile` (a name, profiles being merged across hosts by name) or, when it's missing, of every profile. */
  | { name: "analytics"; profile?: string }
  /** A page of the guide (docs/guide/<page>.md), its first one when `page` is missing. */
  | { name: "guide"; page?: string }
  | { name: "host"; hostId: string }

/** A path segment, decoded; one with a malformed escape (a truncated or mangled link) is taken as it is. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parse(path: string): Route {
  const parts = path.split("/").filter(Boolean)
  const [first, second, third, fourth] = parts
  switch (first) {
    case "profile":
      if (second) return { name: "profile", profile: decode(second) }
      break
    case "assistant":
      if (second) return { name: "assistant", profile: decode(second) }
      break
    case "docs": {
      if (!second) break
      const profile = decode(second)
      if (third !== "d" || !fourth) return { name: "docs", profile }
      let rest = parts.slice(4)
      let version: number | undefined
      if (rest[0] === "-" && rest[1] === "v" && /^[0-9]{1,15}$/.test(rest[2] ?? "")) {
        version = Number(rest[2])
        rest = rest.slice(3)
      }
      return { name: "docs", profile, slug: decode(fourth), ...(version !== undefined && { version }), page: rest.map(decode).join("/") }
    }
    case "settings":
      return second ? { name: "settings", tab: decode(second) } : { name: "settings" }
    case "analytics":
      return second ? { name: "analytics", profile: decode(second) } : { name: "analytics" }
    case "guide":
      return second ? { name: "guide", page: decode(second) } : { name: "guide" }
    case "hosts":
      if (second) return { name: "host", hostId: second }
      break
    case "t":
      // `/t/<id>/board` was a subproject's board; subprojects are ordinary tasks now (docs/plan/README.md).
      if (second) return { name: "task", taskId: second }
      break
    case "g":
      if (second && third) return { name: "group", hostId: decode(second), group: decode(third) }
      break
    case "p":
      if (!second) break
      if (third === "settings") return { name: "projectSettings", projectId: second, ...(fourth && { tab: decode(fourth) }) }
      return { name: "board", projectId: second }
    case undefined:
    default:
      break
  }
  return { name: "home" }
}

export function href(r: Route): string {
  switch (r.name) {
    case "home":
      return "/"
    case "profile":
      return `/profile/${encodeURIComponent(r.profile)}`
    case "assistant":
      return `/assistant/${encodeURIComponent(r.profile)}`
    case "docs":
      return docsHref(r)
    case "settings":
      return r.tab ? `/settings/${encodeURIComponent(r.tab)}` : "/settings"
    case "analytics":
      return r.profile ? `/analytics/${encodeURIComponent(r.profile)}` : "/analytics"
    case "guide":
      return r.page ? `/guide/${encodeURIComponent(r.page)}` : "/guide"
    case "host":
      return `/hosts/${r.hostId}`
    case "task":
      return `/t/${r.taskId}`
    case "board":
      return `/p/${r.projectId}`
    case "group":
      return `/g/${encodeURIComponent(r.hostId)}/${encodeURIComponent(r.group)}`
    case "projectSettings":
    default:
      return `/p/${r.projectId}/settings${r.tab ? `/${encodeURIComponent(r.tab)}` : ""}`
  }
}

function docsHref(r: Extract<Route, { name: "docs" }>): string {
  const list = `/docs/${encodeURIComponent(r.profile)}`
  if (r.slug === undefined) return list
  return `${docBase(r.profile, r.slug, r.version)}${(r.page ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`
}

/** Where a document's pages are (its latest version's, or version `version`'s), ending in `/`: the base its relative links are rendered against. */
export const docBase = (profile: string, slug: string, version?: number): string =>
  `/docs/${encodeURIComponent(profile)}/d/${encodeURIComponent(slug)}/${version !== undefined ? `-/v/${version}/` : ""}`

/** Whether two paths are pages of the same document (moving between them keeps where the user came from). */
export function sameDoc(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)]
  return x.name === "docs" && y.name === "docs" && x.slug !== undefined && x.profile === y.profile && x.slug === y.slug
}

/**
 * A task open beside the page in a side panel (`?task=<id>`), or expanded into a dialog over it (`&expanded`), and the
 * tasks made from the same prompt as it compared over the page (`&compare`).
 */
export interface Panel {
  readonly taskId: string
  readonly expanded: boolean
  readonly compare?: boolean
}

/** Pages a task can open beside. Elsewhere a task opens on its project's board. */
export const hasPanel = (r: Route): boolean => r.name === "board" || r.name === "group" || r.name === "profile"

export function panelUrl(path: string, panel: Panel | null): string {
  if (!panel) return path
  return `${path}?task=${encodeURIComponent(panel.taskId)}${panel.expanded ? "&expanded" : ""}${panel.compare === true ? "&compare" : ""}`
}

export function parsePanel(search: string): Panel | null {
  const q = new URLSearchParams(search)
  const taskId = q.get("task")
  return taskId ? { taskId, expanded: q.has("expanded"), compare: q.has("compare") } : null
}

/** The task open in a dialog over the page (`modal=<id>`), beside the side panel's task if there is one. */
export const parseModal = (search: string): string | null => new URLSearchParams(search).get("modal")

/** `pathAndSearch` without its task dialog (see parseModal). */
export const withoutModal = (pathAndSearch: string): string => pathAndSearch.replace(/([?&])modal=[^&]*&?/, "$1").replace(/[?&]$/, "")

/** `/p/<project>?task=<id>`: a task open on its project's board. */
export const boardTaskUrl = (projectId: string, taskId: string): string => panelUrl(href({ name: "board", projectId }), { taskId, expanded: false })

/** `/profile/<name>?task=<id>`: a task open on its profile's board. */
export const profileTaskUrl = (profile: string, taskId: string): string => panelUrl(href({ name: "profile", profile }), { taskId, expanded: false })

/** `/g/<host>/<group>?task=<id>`: a task open on a group's board. */
export const groupTaskUrl = (hostId: string, group: string, taskId: string): string =>
  panelUrl(href({ name: "group", hostId, group }), { taskId, expanded: false })
