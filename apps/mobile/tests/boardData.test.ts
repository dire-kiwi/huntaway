import { loadProfiles, loadProjects, pickedProfile, profilesOf } from "../src/boardData";

describe("a board's profiles and projects", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    hosts: async () => [{ id: "h1", local: true, connected: true }],
    profiles: async () => [{ id: "p1", name: "Work" }],
    projects: async () => [{ id: "x", name: "X", key: "X" }],
  };

  test("are tagged with their board, so another board's are never shown for it", async () => {
    const profiles = await loadProfiles(client, "A");
    expect(profilesOf({ id: "A" }, profiles)).toBe(profiles);
    expect(profilesOf({ id: "B" }, profiles)).toBeUndefined();
    expect(pickedProfile({ profile: null }, profilesOf({ id: "B" }, profiles))).toBeNull();
    const projects = await loadProjects(client, profiles, "Work");
    expect(projects.map((p) => [p.boardId, p.hostId, p.id])).toEqual([["A", "h1", "x"]]);
  });
});

// HA-262: the phone showed a linked host's profiles even when the host no longer serves a client this old, which the web
// board leaves off (packages/client's boardHosts, shared by both).
test("a board's hosts are those the web board shows", async () => {
  const host = (id: string, more = {}) => ({ id, name: id, local: false, connected: true, mode: "ssh", api_version: 122, api_compat: 1, ...more });
  const hosts = [
    host("hub", { local: true, agents: false }),
    host("desk"),
    host("old", { api_version: 3 }),
    host("newer", { api_compat: 999 }),
    host("offline", { connected: false }),
    host("viewer", { agents: false }),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = { hosts: async () => hosts, profiles: async (h: string) => [{ id: `p-${h}`, name: "Work" }] };
  const profiles = await loadProfiles(client, "A");
  expect(profiles.byName.get("Work")?.map((e) => e.hostId)).toEqual(["hub", "desk", "old"]);
  expect(profiles.allHosts).toBe(hosts);
});
