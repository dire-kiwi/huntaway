// What the Projects tab reads from a board: its hosts, and their profiles merged by name (as the web board merges
// them), with each profile's projects on each host.
import type { Client, Profile, Project } from "@huntaway/client";
import type { Board } from "./boards";
import { boardHosts } from "./inbox";

export interface BoardProfiles {
  /** Profile names, in the order the hosts list them. */
  names: string[];
  /** For each name, the profile on each host that has it. */
  byName: Map<string, { hostId: string; profile: Profile }[]>;
  /** Host names, by id. */
  hostNames: Map<string, string>;
}

export async function loadProfiles(client: Client): Promise<BoardProfiles> {
  const hosts = boardHosts(await client.hosts());
  const lists = await Promise.all(hosts.map((h) => client.profiles(h.id).then((ps) => ps.map((profile) => ({ hostId: h.id, profile }))).catch(() => [])));
  const byName = new Map<string, { hostId: string; profile: Profile }[]>();
  for (const e of lists.flat()) byName.set(e.profile.name, [...(byName.get(e.profile.name) ?? []), e]);
  return { names: [...byName.keys()], byName, hostNames: new Map(hosts.map((h) => [h.id, h.name])) };
}

/** The profile a board shows: the one picked on it, or its first. */
export const pickedProfile = (board: Pick<Board, "profile">, profiles: BoardProfiles | undefined) =>
  profiles && board.profile && profiles.names.includes(board.profile) ? board.profile : (profiles?.names[0] ?? null);

export interface HostProject extends Project {
  hostId: string;
}

/** A profile's projects on every host it's on, by name. */
export async function loadProjects(client: Client, profiles: BoardProfiles, name: string): Promise<HostProject[]> {
  const on = profiles.byName.get(name) ?? [];
  const lists = await Promise.all(on.map(({ hostId, profile }) => client.projects(hostId, profile.id).then((ps) => ps.map((p) => ({ ...p, hostId })))));
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}
