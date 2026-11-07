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
 * The board's own path for the document a `publish_document` call's result names, or null if it names none. Its URLs
 * start with the host's address, which is its internal one (127.0.0.1) unless it has a public URL, and so not one
 * another device or a hub's user can open: the path is taken from them, for the board this page is served from.
 */
export function publishedDocPath(content: string): { path: string; slug: string; version: number | null } | null {
  let out: { url?: unknown; slug?: unknown; version?: unknown };
  try {
    out = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof out?.url !== "string") return null;
  let route;
  try {
    route = parse(new URL(out.url, "http://board").pathname);
  } catch {
    return null;
  }
  if (route.name !== "docs" || route.slug === undefined) return null;
  return { path: href(route), slug: route.slug, version: typeof out.version === "number" ? out.version : null };
}
