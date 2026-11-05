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
