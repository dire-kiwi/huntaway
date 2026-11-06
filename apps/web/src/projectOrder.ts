import type { Project } from "./api";

/** Compares names as the sidebar orders them: alphabetically, ignoring case, with numbers in numeric order. */
export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Projects in alphabetical order (then by host and id, so the order is stable), without changing `projects`. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => byName(a.name, b.name) || a.name.localeCompare(b.name) || `${a.host_id}:${a.id}`.localeCompare(`${b.host_id}:${b.id}`));
}
