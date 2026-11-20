import { Predicate } from "effect"

// The windows' rules about addresses, as plain functions (docs/plan/inventory/10-web-client.md §9.1, Navigation and the
// browser pane).

/** The error page's Retry goes here, and is stopped on its way (a web address, so that it is navigated to like one). */
export const RETRY_URL = "https://retry.huntaway.invalid/"
/** Its "Start without a backup", the same way. */
export const SKIP_BACKUP_URL = "https://start-without-a-backup.huntaway.invalid/"

const protocolOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).protocol : null)

/** Whether `url` is one for a browser (http, https or mailto), rather than a file or another app's scheme. */
export const isWebUrl = (url: string): boolean => ["http:", "https:", "mailto:"].includes(protocolOf(url) ?? "")

/** A page the browser pane may show: http: and https: only. */
export const isBrowsable = (url: string): boolean => ["http:", "https:"].includes(protocolOf(url) ?? "")

/** `url`'s origin, or null when it is not a URL. */
export const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null)

/** `url`'s path, query and hash without the token, if it is a page of the board at `boardOrigin` (not its API); else null. */
export const boardUrlPath = (url: string, boardOrigin: string | null): string | null => {
  if (boardOrigin === null || !URL.canParse(url)) return null
  const u = new URL(url)
  if (u.origin !== boardOrigin || u.pathname.startsWith("/api/")) return null
  u.searchParams.delete("token")
  return u.pathname + u.search + u.hash
}

/**
 * The windows a relaunch saved, from `relaunch-windows.json`'s contents (`{windows, heading}`, or a list of paths as an
 * app before HE-44 wrote it): board paths, else one window on the home page.
 */
export const windowsToReopen = (saved: unknown): ReadonlyArray<string> => {
  const paths = Predicate.hasProperty(saved, "windows") ? saved.windows : saved
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string" && p.startsWith("/")) : []
  return list.length > 0 ? list : ["/"]
}

/** What the progress page says after the relaunch ("Starting Huntaway 0.0.5"), from the same file; null for the usual. */
export const relaunchHeading = (saved: unknown): string | null =>
  Predicate.hasProperty(saved, "heading") && typeof saved.heading === "string" && saved.heading.trim() !== "" ? saved.heading.slice(0, 200) : null

/** The number for the dock or taskbar badge, from whatever the page sent. */
export const badgeCount = (n: unknown): number => Math.max(0, Math.floor(Number(n)) || 0)

/** What the browser pane's pages may have without asking: copying to the clipboard and going full screen. */
export const BROWSER_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write", "fullscreen"])

/**
 * Whether the board's server runs on this machine (desktop.json has no `serverUrl`): only then is a pane on this
 * machine the task's browser. A remote server's tasks' localhost is that machine's, and its agents mustn't reach this
 * one's network, so its board streams the browser instead.
 */
export const paneIsLocal = (file: { readonly serverUrl: string | null }): boolean => file.serverUrl === null

/**
 * HE-67: the proxy the browser pane's pages go through, as the board gives it (its host's `socks_proxy`, which the
 * server stores as `socks5://host:port`): that, null for none, or undefined for anything else, which is refused.
 */
export const paneProxy = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" && /^socks5:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/iu.test(v) ? v : undefined
