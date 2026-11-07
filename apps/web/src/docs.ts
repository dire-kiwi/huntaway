// Docs (HA-281): each profile's documents, which its agents publish through the run's `docs` MCP server (HA-280, API
// 124), on the board at `/docs/<profile>` (see the `docs` route in router.ts). They're kept by each host for its own
// profiles, so a profile merged across hosts by name has the documents of each of them that has Docs.
import { hasDocs, type Host, type Profile } from "./api";
import { href, parse } from "./router";

/** A host's profile whose documents the Docs page shows. */
export interface DocsHome {
  hostId: string;
  profileId: string;
}

/**
 * The profile a docs route names (`segment`: its name, or a profile's id, as agents' links have it) and where its
 * documents are: that profile, or each profile of that name, on the connected hosts that have Docs, this board's host
 * first.
 */
export function docsHomes(profiles: Profile[], hosts: Host[], segment: string): { name: string; homes: DocsHome[] } {
  const byId = profiles.filter((p) => p.id === segment);
  const named = byId.length ? byId : profiles.filter((p) => p.name === segment);
  const homes = named
    .map((p) => ({ p, host: hosts.find((h) => h.id === p.host_id) }))
    .filter(({ host }) => !!host?.connected && hasDocs(host))
    .sort((a, b) => Number(b.host!.local) - Number(a.host!.local))
    .map(({ p }) => ({ hostId: p.host_id, profileId: p.id }));
  return { name: named[0]?.name ?? segment, homes };
}

/** The profile's name a docs route's `segment` stands for. */
export const docsProfileName = (profiles: Profile[], segment: string) => profiles.find((p) => p.id === segment)?.name ?? segment;

/** A page path's URL under its version's base (docs-render's urlSuffix): `plan/index` → `plan`, `index` → ``. */
export const pageSuffix = (path: string) => (path === "index" ? "" : path.replace(/\/index$/, ""));

/**
 * The board's own path for the version a `publish_document` call's result names (its `version_url`, else its `url`), or
 * null if it names none. Its URLs start with the host's address, which is its internal one (127.0.0.1) unless it has a
 * public URL, and so not one another device or a hub's user can open: the path is taken from them, for the board this
 * page is served from. A public URL may have a path of its own before the board's (`https://example.com/board/docs/…`).
 */
export function publishedDocPath(content: string): { path: string; slug: string; version: number | null } | null {
  let out: { url?: unknown; version_url?: unknown; slug?: unknown; version?: unknown };
  try {
    out = JSON.parse(content);
  } catch {
    return null;
  }
  const url = typeof out?.version_url === "string" ? out.version_url : out?.url;
  if (typeof url !== "string") return null;
  let pathname: string;
  try {
    pathname = new URL(url, "http://board").pathname;
  } catch {
    return null;
  }
  // The board's path is the first from a `/docs/` on that's a document's.
  for (let i = pathname.indexOf("/docs/"); i >= 0; i = pathname.indexOf("/docs/", i + 1)) {
    let route;
    try {
      route = parse(pathname.slice(i));
    } catch {
      continue;
    }
    if (route.name === "docs" && route.slug !== undefined) {
      return { path: href(route), slug: route.slug, version: route.version ?? (typeof out.version === "number" ? out.version : null) };
    }
  }
  return null;
}
