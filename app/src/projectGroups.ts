import type { Project, Task } from "./api";
import { byName } from "./projectOrder.ts";

/** A row of a host's projects on the sidebar: a project on its own, or a group of them. */
export type SidebarEntry =
  | { kind: "project"; key: string; project: Project }
  | { kind: "group"; key: string; name: string; hostId: string; projects: Project[] };

/** Groups belong to a host: its projects with the same group name are in the same group. */
export const groupKey = (hostId: string, name: string) => `${hostId}:${name}`;

/** The projects of a group, in sidebar order. */
export const groupProjects = (projects: Project[], hostId: string, name: string) =>
  projects.filter((p) => p.host_id === hostId && p.group_name === name);

/** A host's group names, in sidebar order. */
export const groupNames = (projects: Project[], hostId: string) => [
  ...new Set(projects.filter((p) => p.host_id === hostId && p.group_name).map((p) => p.group_name!)),
];

/** Whether a task is one of a host's group's group tasks. */
const inGroup = (t: Task, hostId: string, name?: string) =>
  t.host_id === hostId && t.kind === "task" && !t.project_id && !!t.group_name && (name === undefined || t.group_name === name);

/**
 * A group's group tasks, of every profile loaded: the board shows them all, as it shows the
 * group's projects of every profile in view, even if their own profile has no project left in
 * the group.
 */
export const groupTasks = (tasks: Task[], hostId: string, name: string) => tasks.filter((t) => inGroup(t, hostId, name));

/**
 * Groups on a host that only have group tasks left, their projects having been ungrouped or
 * deleted, by name. They keep a board so their tasks can still be opened.
 */
export function orphanGroupNames(tasks: Task[], projects: Project[], hostId: string) {
  const live = new Set(groupNames(projects, hostId));
  const names = tasks.filter((t) => inGroup(t, hostId) && !live.has(t.group_name!)).map((t) => t.group_name!);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** A host's (sorted) projects as sidebar rows, in alphabetical order: each group sits where its name does, its projects inside it. */
export function sidebarEntries(projects: Project[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  const groups = new Map<string, Extract<SidebarEntry, { kind: "group" }>>();
  for (const p of projects) {
    if (!p.group_name) {
      entries.push({ kind: "project", key: `p:${p.id}`, project: p });
      continue;
    }
    const key = groupKey(p.host_id, p.group_name);
    const group = groups.get(key);
    if (group) group.projects.push(p);
    else {
      const entry = { kind: "group" as const, key: `g:${key}`, name: p.group_name, hostId: p.host_id, projects: [p] };
      groups.set(key, entry);
      entries.push(entry);
    }
  }
  const name = (e: SidebarEntry) => (e.kind === "project" ? e.project.name : e.name);
  return entries.sort((a, b) => byName(name(a), name(b)));
}

/** A set of strings kept in this browser under `key`. */
function loadKeys(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveKeys(key: string, keys: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...keys]));
  } catch {
    // The sidebar still follows it for this session when storage is unavailable.
  }
}

const COLLAPSED_KEY = "ia.collapsedGroups";

/** Groups collapsed on the sidebar, by groupKey; kept in this browser. */
export const loadCollapsedGroups = () => loadKeys(COLLAPSED_KEY);
export const saveCollapsedGroups = (keys: Set<string>) => saveKeys(COLLAPSED_KEY, keys);

const HIDDEN_KEY = "ia.hiddenProjects";

/** How a project is named in the hidden set: by host, as ids are only unique on their host. */
export const hiddenKey = (p: Pick<Project, "host_id" | "id">) => `${p.host_id}:${p.id}`;

/** Projects hidden from the sidebar, by hiddenKey; kept in this browser, for every profile view. */
export const loadHiddenProjects = () => loadKeys(HIDDEN_KEY);
export const saveHiddenProjects = (keys: Set<string>) => saveKeys(HIDDEN_KEY, keys);

const PINNED_KEY = "ia.pinnedProjects";

/** Projects pinned to the sidebar of every profile, by hiddenKey; kept in this browser. */
export const loadPinnedProjects = () => loadKeys(PINNED_KEY);
export const savePinnedProjects = (keys: Set<string>) => saveKeys(PINNED_KEY, keys);

const FAVORITES_KEY = "ia.favoriteProjects";

/** Favorite projects, listed in a section of their own above the others, by hiddenKey; kept in this browser. */
export const loadFavoriteProjects = () => loadKeys(FAVORITES_KEY);
export const saveFavoriteProjects = (keys: Set<string>) => saveKeys(FAVORITES_KEY, keys);

/**
 * The projects the sidebar lists while `profile` is active: its own and the pinned ones, in
 * order. `profileOf` names a project's profile (profiles are merged across hosts by name).
 */
export const profileProjects = (projects: Project[], profile: string | undefined, profileOf: (p: Project) => string | undefined, pinned: Set<string>) =>
  projects.filter((p) => profileOf(p) === profile || pinned.has(hiddenKey(p)));

/**
 * The sidebar rows that aren't hidden (or favorites, which have a section of their own): a
 * group shows its other projects, and goes once there are none.
 */
export function visibleEntries(entries: SidebarEntry[], hidden: Set<string>, favorites = new Set<string>()): SidebarEntry[] {
  const listed = (p: Project) => !hidden.has(hiddenKey(p)) && !favorites.has(hiddenKey(p));
  return entries.flatMap((e): SidebarEntry[] => {
    if (e.kind === "project") return listed(e.project) ? [e] : [];
    const projects = e.projects.filter(listed);
    return projects.length ? [{ ...e, projects }] : [];
  });
}

/**
 * Whether a task a group task's agent created is in one of the group's projects. Its agent can
 * also create tasks elsewhere (anything the user asks for along the way), which aren't the
 * group's work.
 */
export const inGroupTaskGroup = (t: Task, groupTask: Task, projects: Project[]) =>
  !!t.project_id && projects.some((p) => p.id === t.project_id && p.host_id === groupTask.host_id && p.group_name === groupTask.group_name);
