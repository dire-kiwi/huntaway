import { Boards, tokenKey, type Board } from "../src/boards";
import { memoryStore } from "./helpers";

const b = (id: string, extra: Partial<Board> = {}): Board => ({ id, url: `https://${id}.ts.net`, name: id, deviceId: `dev-${id}`, apiVersion: 100, profile: null, pairedAt: "", ...extra });

describe("the board switcher", () => {
  test("adds boards with their own tokens, and selects the newest", async () => {
    const store = memoryStore();
    const boards = new Boards(store);
    await boards.load();
    expect(boards.get()).toEqual({ boards: [], selected: null, loaded: true });
    await boards.add(b("work"), "work-token");
    await boards.add(b("home"), "home-token");
    expect(boards.get().boards.map((x) => x.id)).toEqual(["work", "home"]);
    expect(boards.get().selected).toBe("home");
    expect(boards.token("work")).toBe("work-token");
    expect(boards.token("home")).toBe("home-token");
    // Tokens are kept apart from the list.
    expect(store.data.get(tokenKey("work"))).toBe("work-token");
    expect(store.data.get("boards")).not.toContain("token");
  });

  test("pairing a board again replaces its token and keeps its profile", async () => {
    const boards = new Boards(memoryStore());
    await boards.add(b("work"), "old");
    await boards.update("work", { profile: "Work" });
    await boards.add(b("home"), "home-token");
    await boards.add(b("work", { url: "https://new.ts.net" }), "new");
    expect(boards.get().boards).toHaveLength(2);
    expect(boards.board("work")).toMatchObject({ url: "https://new.ts.net", profile: "Work" });
    expect(boards.token("work")).toBe("new");
    expect(boards.get().selected).toBe("work");
  });

  test("selects, picks profiles, and remembers it all", async () => {
    const store = memoryStore();
    const boards = new Boards(store);
    await boards.add(b("work"), "w");
    await boards.add(b("home"), "h");
    await boards.select("work");
    await boards.update("home", { profile: "Personal" });
    await boards.select("nope");
    const again = new Boards(store);
    await again.load();
    expect(again.get().selected).toBe("work");
    expect(again.board("home")?.profile).toBe("Personal");
    expect(again.token("home")).toBe("h");
    expect(again.selectedBoard()?.id).toBe("work");
  });

  test("removing a board forgets its token and selects another", async () => {
    const store = memoryStore();
    const boards = new Boards(store);
    await boards.add(b("work"), "w");
    await boards.add(b("home"), "h");
    const seen: string[] = [];
    const off = boards.subscribe(() => seen.push(boards.get().selected ?? "none"));
    await boards.remove("home");
    expect(boards.get().boards.map((x) => x.id)).toEqual(["work"]);
    expect(boards.get().selected).toBe("work");
    expect(store.data.has(tokenKey("home"))).toBe(false);
    expect(boards.token("home")).toBe("");
    await boards.remove("work");
    expect(boards.get()).toMatchObject({ boards: [], selected: null });
    expect(store.data.has("boards.selected")).toBe(false);
    off();
    expect(seen).toEqual(["work", "none"]);
  });

  test("a board whose token is gone (a cleared keychain) is dropped on load", async () => {
    const store = memoryStore();
    const boards = new Boards(store);
    await boards.add(b("work"), "w");
    await boards.add(b("home"), "h");
    store.data.delete(tokenKey("home"));
    const again = new Boards(store);
    await again.load();
    expect(again.get().boards.map((x) => x.id)).toEqual(["work"]);
    expect(again.get().selected).toBe("work");
    expect(JSON.parse(store.data.get("boards")!).map((x: Board) => x.id)).toEqual(["work"]);
    // And a list that isn't JSON is no boards, not a crash.
    store.data.set("boards", "{nope");
    const broken = new Boards(store);
    await broken.load();
    expect(broken.get().boards).toEqual([]);
  });

  test("keychain keys are safe whatever the id", () => {
    expect(tokenKey("a/b c")).toBe("token.a_b_c");
  });
});
