import type { Project } from "./api";

const STORAGE_KEY = "ia.projectOrder";
const projectKey = (p: Project) => `${p.host_id}:${p.id}`;

/**
 * Where orders were kept when the board showed one profile (or All profiles) at a time, one per
 * view: the All profiles view's order carries over, else that of the profile picked last.
 */
const oldKeys = () => [`${STORAGE_KEY}:${JSON.stringify("\u0000all")}`, `${STORAGE_KEY}:${JSON.stringify(localStorage.getItem("ia.profileName"))}`];

/** The sidebar's order of projects, kept in this browser. */
export function loadProjectOrder(): string[] {
  try {
    const saved = [STORAGE_KEY, ...oldKeys()].map((k) => localStorage.getItem(k)).find((v) => v !== null);
    const value: unknown = JSON.parse(saved ?? "[]");
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? [...new Set<string>(value)] : [];
  } catch {
    return [];
  }
}

export function saveProjectOrder(order: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Reordering still works for this session when storage is unavailable.
  }
}

/** Unranked projects follow the saved order alphabetically, as the list did before reordering. */
export function sortProjects(projects: Project[], order: string[]): Project[] {
  const ranks = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const rank = (ranks.get(projectKey(a)) ?? order.length) - (ranks.get(projectKey(b)) ?? order.length);
    return rank || a.name.localeCompare(b.name) || projectKey(a).localeCompare(projectKey(b));
  });
}

/**
 * Moves projects `ids` (keeping their order) next to projects `targetIds`: before the first of
 * them or after the last, so a group of projects moves as one. Keeps unloaded hosts' positions
 * so reordering an online host doesn't reset an offline one.
 */
export function moveProjects(
  projects: Project[],
  order: string[],
  ids: string[],
  targetIds: string[],
  position: "before" | "after",
): string[] {
  const pick = (list: string[]) => projects.filter((p) => list.includes(p.id));
  if (pick(ids).length !== new Set(ids).size || pick(targetIds).length !== new Set(targetIds).size || !ids.length || !targetIds.length) return order;
  const host = pick(ids)[0].host_id;
  if ([...pick(ids), ...pick(targetIds)].some((p) => p.host_id !== host) || ids.some((id) => targetIds.includes(id))) return order;

  const next = groupsTogether(projects, order);
  const sources = sortProjects(pick(ids), next);
  const targets = sortProjects(pick(targetIds), next);
  const moving = sources.map(projectKey);
  const rest = next.filter((key) => !moving.includes(key));
  const anchor = projectKey(position === "before" ? targets[0] : targets[targets.length - 1]);
  rest.splice(rest.indexOf(anchor) + (position === "after" ? 1 : 0), 0, ...moving);
  return rest;
}

/**
 * The order with every project in it, and each group's projects one after another where the
 * sidebar shows them (at the group's first project), so moving a project within its group, or
 * a project past the group, leaves the group where it is.
 */
function groupsTogether(projects: Project[], order: string[]): string[] {
  const next = [...order];
  const known = new Set(next);
  for (const p of projects) {
    const key = projectKey(p);
    if (!known.has(key)) {
      next.push(key);
      known.add(key);
    }
  }
  const sorted = sortProjects(projects, next);
  const shown: Project[] = [];
  const placed = new Set<Project>();
  for (const p of sorted) {
    if (placed.has(p)) continue;
    const members = p.group_name ? sorted.filter((x) => x.host_id === p.host_id && x.group_name === p.group_name) : [p];
    for (const m of members) {
      shown.push(m);
      placed.add(m);
    }
  }
  // Loaded projects take their slots in the order shown; other hosts' keep theirs.
  const loaded = new Set(sorted.map(projectKey));
  let i = 0;
  return next.map((key) => (loaded.has(key) ? projectKey(shown[i++]) : key));
}

export const moveProject = (projects: Project[], order: string[], id: string, targetId: string, position: "before" | "after") =>
  moveProjects(projects, order, [id], [targetId], position);
