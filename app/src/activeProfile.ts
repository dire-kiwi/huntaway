const KEY = "ia.activeProfile";

/** The profile picked last, whose projects the sidebar lists; kept in this browser. */
export function loadActiveProfile(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveActiveProfile(name: string) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // The sidebar still follows it for this session when storage is unavailable.
  }
}

/**
 * The profile the sidebar lists the projects of: the one picked last (`saved`), or the first
 * one if that's gone. `needs` says which profile the open page needs instead, given that one:
 * a profile's board needs that profile, and a project (or a task in one) the sidebar wouldn't
 * list under it needs the project's own.
 */
export function activeProfile(names: string[], saved: string | null, needs?: (current: string) => string | undefined): string | undefined {
  const current = saved !== null && names.includes(saved) ? saved : names[0];
  if (current === undefined) return undefined;
  const want = needs?.(current);
  return want !== undefined && names.includes(want) ? want : current;
}
