// What the app reads of a board's profiles and projects: its hosts, and their profiles merged by name (as the web
// board merges them), with each profile's projects on each host. Each result says which board it's from, so a
// screen never shows (or acts on) one board's projects under another.
import type { Client, Host, Profile, Project } from "@huntaway/client";
import type { Board } from "./boards";

/** The hosts of a board whose profiles and projects show: this one, and the linked ones that are connected and run agents. */
export const boardHosts = (hosts: Host[]) => hosts.filter((h) => h.connected && (h.local || h.agents !== false));

export interface BoardProfiles {
  boardId: string;
  /** Profile names, in the order the hosts list them. */
  names: string[];
  /** For each name, the profile on each host that has it. */
  byName: Map<string, { hostId: string; profile: Profile }[]>;
  /** The names of the hosts shown, by id. */
  hostNames: Map<string, string>;
  /** Every host the board lists, offline ones too (a profile's assistant host may be one). */
  allHosts: Host[];
}

export async function loadProfiles(client: Pick<Client, "hosts" | "profiles">, boardId: string): Promise<BoardProfiles> {
  const allHosts = await client.hosts();
  const hosts = boardHosts(allHosts);
  const lists = await Promise.all(
    hosts.map((h) => client.profiles(h.id).then((ps) => ps.map((profile) => ({ hostId: h.id, profile: { ...profile, host_id: h.id } }))).catch(() => [])),
  );
  const byName = new Map<string, { hostId: string; profile: Profile }[]>();
  for (const e of lists.flat()) byName.set(e.profile.name, [...(byName.get(e.profile.name) ?? []), e]);
  return { boardId, names: [...byName.keys()], byName, hostNames: new Map(hosts.map((h) => [h.id, h.name])), allHosts };
}

/** `profiles` if they're this board's (not the previous board's, still shown while this one's load). */
export const profilesOf = (board: Pick<Board, "id"> | undefined, profiles: BoardProfiles | undefined) =>
  board && profiles?.boardId === board.id ? profiles : undefined;

/**
 * The profile a board shows, everywhere in the app (the inbox, Projects, Boards): the one picked on it, or the first
 * in its merged list.
 */
export const pickedProfile = (board: Pick<Board, "profile">, profiles: Pick<BoardProfiles, "names"> | undefined) =>
  profiles && board.profile && profiles.names.includes(board.profile) ? board.profile : (profiles?.names[0] ?? null);

export interface HostProject extends Project {
  boardId: string;
  hostId: string;
}

/** A profile's projects on every host it's on, by name. */
export async function loadProjects(client: Pick<Client, "projects">, profiles: BoardProfiles, name: string): Promise<HostProject[]> {
  const on = profiles.byName.get(name) ?? [];
  const lists = await Promise.all(
    on.map(({ hostId, profile }) => client.projects(hostId, profile.id).then((ps) => ps.map((p) => ({ ...p, boardId: profiles.boardId, hostId })))),
  );
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}
