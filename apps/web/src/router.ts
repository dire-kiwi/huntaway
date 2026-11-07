import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "profile"; profile: string }
  /** The profile's assistant (API 109), full width. */
  | { name: "assistant"; profile: string }
  /**
   * The profile's documents (HA-281): its list, or document `slug` (its latest version, or version `version`) at page
   * `page`, the page's URL suffix (`plan/phase-1`, `plan` for `plan/index`, `` for `index`). `profile` is its name, or
   * a profile's id, as the links agents get have it (`/docs/<profile id>/d/<slug>/[-/v/<n>/][<page>]`, see doc_base in
   * apps/server/src/mcp/docs_mcp.ts).
   */
  | { name: "docs"; profile: string; slug?: string; version?: number; page?: string }
  | { name: "board"; projectId: string }
  | { name: "group"; hostId: string; group: string }
  /** `tab` is the section of the settings open, the first one when it's missing. */
  | { name: "projectSettings"; projectId: string; tab?: string }
  | { name: "task"; taskId: string }
  | { name: "subproject"; taskId: string }
  | { name: "settings" }
  | { name: "analytics" }
  | { name: "host"; hostId: string };

/** A path segment, decoded; one with a malformed escape (a truncated or mangled link) is taken as it is. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parse(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  switch (parts[0]) {
    case "profile":
      if (parts[1]) return { name: "profile", profile: decode(parts[1]) };
      break;
    case "assistant":
      if (parts[1]) return { name: "assistant", profile: decode(parts[1]) };
      break;
    case "docs": {
      if (!parts[1]) break;
      const profile = decode(parts[1]);
      if (parts[2] !== "d" || !parts[3]) return { name: "docs", profile };
      let rest = parts.slice(4);
      let version: number | undefined;
      if (rest[0] === "-" && rest[1] === "v" && /^[0-9]{1,15}$/.test(rest[2] ?? "")) {
        version = Number(rest[2]);
        rest = rest.slice(3);
      }
      return { name: "docs", profile, slug: decode(parts[3]), ...(version !== undefined && { version }), page: rest.map(decode).join("/") };
    }
    case "settings":
      return { name: "settings" };
    case "analytics":
      return { name: "analytics" };
    case "hosts":
      if (parts[1]) return { name: "host", hostId: parts[1] };
      break;
    case "t":
      if (parts[1] && parts[2] === "board") return { name: "subproject", taskId: parts[1] };
      if (parts[1]) return { name: "task", taskId: parts[1] };
      break;
    case "g":
      if (parts[1] && parts[2]) return { name: "group", hostId: decode(parts[1]), group: decode(parts[2]) };
      break;
    case "p":
      if (!parts[1]) break;
      if (parts[2] === "settings") return { name: "projectSettings", projectId: parts[1], ...(parts[3] && { tab: decode(parts[3]) }) };
      return { name: "board", projectId: parts[1] };
  }
  return { name: "home" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "home":
      return "/";
    case "profile":
      return `/profile/${encodeURIComponent(r.profile)}`;
    case "assistant":
      return `/assistant/${encodeURIComponent(r.profile)}`;
    case "docs":
      return docsHref(r);
    case "settings":
      return "/settings";
    case "analytics":
      return "/analytics";
    case "host":
      return `/hosts/${r.hostId}`;
    case "task":
      return `/t/${r.taskId}`;
    case "subproject":
      return `/t/${r.taskId}/board`;
    case "board":
      return `/p/${r.projectId}`;
    case "group":
      return `/g/${encodeURIComponent(r.hostId)}/${encodeURIComponent(r.group)}`;
    case "projectSettings":
      return `/p/${r.projectId}/settings${r.tab ? `/${encodeURIComponent(r.tab)}` : ""}`;
  }
}

function docsHref(r: Extract<Route, { name: "docs" }>): string {
  const list = `/docs/${encodeURIComponent(r.profile)}`;
  if (r.slug === undefined) return list;
  return `${docBase(r.profile, r.slug, r.version)}${(r.page ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** Where a document's pages are (its latest version's, or version `version`'s), ending in `/`: the base its relative links are rendered against. */
export const docBase = (profile: string, slug: string, version?: number) =>
  `/docs/${encodeURIComponent(profile)}/d/${encodeURIComponent(slug)}/${version !== undefined ? `-/v/${version}/` : ""}`;

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

const current = () => window.location.pathname + window.location.search;

export function navigate(r: Route | string, replace = false) {
  const url = typeof r === "string" ? r : href(r);
  if (url === current()) return;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  listeners.forEach((l) => l());
}

/** Calls `cb` when the page's URL changes (the route or the open task); returns a function that stops it. */
export function onNavigate(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useRoute(): Route {
  return parse(useSyncExternalStore(onNavigate, () => window.location.pathname));
}

/**
 * A task open beside the page in a side panel (`?task=<id>`), or expanded into a dialog over it (`&expanded`), and the
 * tasks made from the same prompt as it compared over the page (`&compare`).
 */
export interface Panel {
  taskId: string;
  expanded: boolean;
  compare?: boolean;
}

/** Pages a task can open beside. Elsewhere a task opens on its project's (or subproject's) board. */
export const hasPanel = (r: Route) => r.name === "board" || r.name === "group" || r.name === "profile" || r.name === "subproject";

function panelUrl(path: string, panel: Panel | null) {
  if (!panel) return path;
  return `${path}?task=${encodeURIComponent(panel.taskId)}${panel.expanded ? "&expanded" : ""}${panel.compare ? "&compare" : ""}`;
}

function parsePanel(search: string): Panel | null {
  const q = new URLSearchParams(search);
  const taskId = q.get("task");
  return taskId ? { taskId, expanded: q.has("expanded"), compare: q.has("compare") } : null;
}

export function usePanel(): Panel | null {
  const search = useSyncExternalStore(onNavigate, () => window.location.search);
  return parsePanel(search);
}

/** Whether task `taskId` is open in the side panel. Unlike usePanel, it only re-renders when that changes (one card's, not every card's). */
export function usePanelOpen(taskId: string): boolean {
  return useSyncExternalStore(onNavigate, () => parsePanel(window.location.search)?.taskId === taskId);
}

/**
 * Opens a task in the side panel of the current page, keeping it expanded if it was. Off the
 * boards, goes to `/t/<id>`, which moves on to the task's board once it's known.
 */
export function openTask(taskId: string, opts: { expanded?: boolean; replace?: boolean } = {}) {
  const path = window.location.pathname;
  if (!hasPanel(parse(path))) return navigate({ name: "task", taskId }, opts.replace);
  const expanded = opts.expanded ?? parsePanel(window.location.search)?.expanded ?? false;
  navigate(panelUrl(path, { taskId, expanded }), opts.replace);
}

/** Expands the open task into a dialog, or back into the side panel. */
export function setPanelExpanded(expanded: boolean) {
  const panel = parsePanel(window.location.search);
  if (panel) navigate(panelUrl(window.location.pathname, { ...panel, expanded }), true);
}

/** Compares the tasks made from the same prompt as `taskId` (see Compare.tsx), over the page with the task open beside it. */
export function openCompare(taskId: string) {
  const path = window.location.pathname;
  if (!hasPanel(parse(path))) return navigate({ name: "task", taskId });
  navigate(panelUrl(path, { taskId, expanded: parsePanel(window.location.search)?.expanded ?? false, compare: true }));
}

export function closeCompare() {
  const panel = parsePanel(window.location.search);
  if (panel) navigate(panelUrl(window.location.pathname, { ...panel, compare: false }));
}

export function closeTask(replace = false) {
  navigate(window.location.pathname, replace);
}

/** `/p/<project>?task=<id>`: a task open on its project's board. */
export const boardTaskUrl = (projectId: string, taskId: string) => panelUrl(href({ name: "board", projectId }), { taskId, expanded: false });

/** `/profile/<name>?task=<id>`: a task open on its profile's board. */
export const profileTaskUrl = (profile: string, taskId: string) => panelUrl(href({ name: "profile", profile }), { taskId, expanded: false });

/** `/g/<host>/<group>?task=<id>`: a task open on a group's board. */
export const groupTaskUrl = (hostId: string, group: string, taskId: string) => panelUrl(href({ name: "group", hostId, group }), { taskId, expanded: false });

/** `/t/<subproject>/board?task=<id>`: a task open on its subproject's board. */
export const subprojectTaskUrl = (subprojectId: string, taskId: string) =>
  panelUrl(href({ name: "subproject", taskId: subprojectId }), { taskId, expanded: false });
