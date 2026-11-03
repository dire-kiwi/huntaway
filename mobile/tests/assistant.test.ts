import { createClient, type Host, type Profile } from "@huntaway/client";
import { hasAssistantTab, homeOf, openAssistant, showsAssistant, unavailableNote } from "../src/assistant";
import type { BoardProfiles } from "../src/boardData";
import { loadProfiles } from "../src/boardData";
import { memoryStorage } from "../src/pairing";
import { fakeFetch } from "./helpers";

const host = (id: string, extra: Partial<Host> = {}): Host => ({ id, name: id, local: false, connected: true, mode: "outbound", api_version: 102, ...extra });
const profile = (id: string, host_id: string, extra: Partial<Profile> = {}) => ({ id, host_id, name: "Ivan", claude_config_dir: "", default_model: null, ...extra }) as Profile;

function profilesOn(hosts: Host[], list: Profile[]): BoardProfiles {
  const byName = new Map<string, { hostId: string; profile: Profile }[]>();
  for (const p of list) byName.set(p.name, [...(byName.get(p.name) ?? []), { hostId: p.host_id, profile: p }]);
  return { boardId: "b", names: [...byName.keys()], byName, hostNames: new Map(), allHosts: hosts };
}

describe("the Assistant tab", () => {
  test("shows on boards from API 102, which let a paired phone reach the assistant", () => {
    
    expect(hasAssistantTab({ apiVersion: 101 })).toBe(false);
    expect(hasAssistantTab({ apiVersion: 102 })).toBe(true);
    expect(hasAssistantTab(undefined)).toBe(false);
    expect(showsAssistant({ apiVersion: 102 }, { unauthorized: true, tooOld: false })).toBe(false);
    expect(showsAssistant({ apiVersion: 102 }, { unauthorized: false, tooOld: false })).toBe(true);
  });

  test("finds the assistant on the board's own host", () => {
    const profiles = profilesOn([host("desk", { local: true })], [profile("p1", "desk")]);
    expect(homeOf(profiles, "Ivan")).toEqual({ hostId: "desk", profileId: "p1" });
    expect(homeOf(profiles, "Someone else")).toBeUndefined();
  });

  test("follows the profile to its assistant host, and says when that's offline", () => {
    const hosts = [host("desk", { local: true }), host("vps", { connected: false })];
    const profiles = profilesOn(hosts, [profile("p1", "desk", { assistant_host: "vps" })]);
    const home = homeOf(profiles, "Ivan");
    expect(home).toEqual({ hostId: "vps", unavailable: "offline" });
    expect(unavailableNote("Ivan", "vps", home!.unavailable!)).toMatch(/runs on vps, which is offline/);
    // Back: its own profile there.
    const back = profilesOn([hosts[0], host("vps")], [profile("p1", "desk", { assistant_host: "vps" }), profile("p9", "vps")]);
    expect(homeOf(back, "Ivan")).toEqual({ hostId: "vps", profileId: "p9" });
  });

  test("opens it on that host through the board, as a paired phone may (?local=1)", async () => {
    const { fetch, calls } = fakeFetch((method, path) =>
      method === "GET" && path === "/api/h/vps/profiles/p9/assistant?local=1" ? { status: 200, body: { id: "a1", task_type: "assistant", host_id: "vps" } } : undefined,
    );
    const client = createClient({ baseUrl: "https://board.ts.net", getToken: () => "device-token", setToken: () => {}, storage: memoryStorage(), fetch });
    const task = await openAssistant(client, { hostId: "vps", profileId: "p9" });
    expect(task).toMatchObject({ id: "a1", host_id: "vps" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://board.ts.net/api/h/vps/profiles/p9/assistant?local=1"]]);
    await expect(openAssistant(client, { hostId: "vps", unavailable: "offline" })).rejects.toThrow();
  });

  test("the board's profiles keep every host, offline ones too, and know their host", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      hosts: async () => [host("desk", { local: true }), host("vps", { connected: false })],
      profiles: async () => [{ id: "p1", name: "Ivan", assistant_host: "vps" }],
    };
    const profiles = await loadProfiles(client, "b");
    expect(profiles.allHosts.map((h) => h.id)).toEqual(["desk", "vps"]);
    expect(profiles.byName.get("Ivan")?.[0].profile.host_id).toBe("desk");
    expect(homeOf(profiles, "Ivan")).toEqual({ hostId: "vps", unavailable: "offline" });
  });
});
