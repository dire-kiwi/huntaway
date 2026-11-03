import { createClient, EXPO_PUSH_API, type PushDevice } from "@huntaway/client";
import type { Board } from "../src/boards";
import {
  ALLOW,
  answerPrompt,
  DEFAULT_ACTION,
  DENY,
  pushable,
  pushData,
  responseHandler,
  saveBoardUrls,
  savedBoardUrl,
  subscribeAll,
  subscriptionOn,
  taskRoute,
  URLS_KEY,
  type ResponseDeps,
} from "../src/push";
import { memoryStorage } from "../src/pairing";
import { fakeFetch, memoryStore, type Route } from "./helpers";

const board = (id: string, more: Partial<Board> = {}): Board => ({
  id,
  url: `https://${id}.tailnet.ts.net`,
  name: id,
  deviceId: `dev-${id}`,
  apiVersion: EXPO_PUSH_API,
  profile: null,
  pairedAt: "",
  ...more,
});

/** A push as the server sends it (push.rs, expo_message), as expo-notifications hands it over. */
const promptData = {
  board: "work",
  host: "h1",
  url: "/t/t1",
  tag: "h1:t1:r1",
  task_id: "t1",
  event: "prompt",
  request_id: "r1",
  answer: { url: "/api/permissions/r1/push-answer", token: "one-time" },
};
const notification = (data: unknown, id = "n1") => ({ request: { identifier: id, content: { title: "WEB-3 Fix the login", body: "Approve Bash?", data } } });

describe("what a push carries", () => {
  test("is read from the content, or from Android's background payload", () => {
    expect(pushData(notification(promptData))).toEqual({
      board: "work",
      host: "h1",
      task_id: "t1",
      event: "prompt",
      request_id: "r1",
      answer: { url: "/api/permissions/r1/push-answer", token: "one-time" },
    });
    expect(pushData(notification({ dataString: JSON.stringify(promptData) }))?.request_id).toBe("r1");
    expect(pushData({ request: { identifier: "x", content: { data: {} }, trigger: { remoteMessage: { data: { body: JSON.stringify(promptData) } } } } })?.board).toBe("work");
    // Not a board's.
    expect(pushData(notification({ hello: 1 }))).toBeNull();
    expect(pushData(null)).toBeNull();
  });

  test("opens its task on its board", () => {
    expect(taskRoute(pushData(notification(promptData))!)).toEqual({ pathname: "/task/[board]/[host]/[id]", params: { board: "work", host: "h1", id: "t1" } });
    // A test push is about no task.
    expect(taskRoute({ board: "work" })).toBeNull();
  });
});

describe("subscribing", () => {
  function hub(id: string, fail = false) {
    const subs: PushDevice[] = [];
    const route: Route = (method, path, body) => {
      if (method === "POST" && path === "/api/push/subscriptions") {
        if (fail) return { status: 502, body: { error: "board unreachable" } };
        const b = body as { kind: string; endpoint: string; name: string };
        const sub = { id: `s-${id}`, endpoint: b.endpoint, kind: b.kind, name: b.name, events: { attention: true, review: true, merge: false, done: false }, created_at: "", last_sent_at: null, last_error: null } as PushDevice;
        subs.push(sub);
        return { status: 200, body: sub };
      }
      if (method === "GET" && path === "/api/push") return { status: 200, body: { public_key: "k", subscriptions: subs } };
    };
    const f = fakeFetch(route);
    const client = createClient({ baseUrl: `https://${id}`, getToken: () => `device-${id}`, setToken: () => {}, storage: memoryStorage(), fetch: f.fetch });
    return { client, calls: f.calls };
  }

  test("on each board that can push, with the Expo token and without changing its events", async () => {
    const work = hub("work");
    const home = hub("home");
    const old = hub("old");
    const off = hub("off");
    const clients: Record<string, ReturnType<typeof hub>> = { work, home, old, off };
    const list = [board("work"), board("home"), board("old", { apiVersion: EXPO_PUSH_API - 1 }), board("off", { push: false })];
    expect(list.map(pushable)).toEqual([true, true, false, false]);
    const done = new Set<string>();
    const got = await subscribeAll(list, "ExponentPushToken[abc]", "Pixel", (b) => clients[b.id].client, done);
    expect(Object.keys(got).sort()).toEqual(["home", "work"]);
    expect(work.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://work/api/push/subscriptions",
        body: { kind: "expo", endpoint: "ExponentPushToken[abc]", name: "Pixel" },
        headers: expect.objectContaining({ Authorization: "Bearer device-work" }),
      }),
    ]);
    expect(old.calls).toEqual([]);
    expect(off.calls).toEqual([]);
    // Not again for the same token and pairing; again once the phone pairs again there.
    await subscribeAll(list, "ExponentPushToken[abc]", "Pixel", (b) => clients[b.id].client, done);
    expect(work.calls).toHaveLength(1);
    await subscribeAll([board("work", { deviceId: "dev-new" })], "ExponentPushToken[abc]", "Pixel", (b) => clients[b.id].client, done);
    expect(work.calls).toHaveLength(2);
    // And finds its own subscription there.
    expect((await subscriptionOn(work.client, "ExponentPushToken[abc]"))?.id).toBe("s-work");
  });

  test("a board that fails says why, and is tried again", async () => {
    const down = hub("down", true);
    const done = new Set<string>();
    const got = await subscribeAll([board("down")], "ExponentPushToken[abc]", "Pixel", () => down.client, done);
    expect(got.down.error).toMatch(/unreachable/);
    expect(done.size).toBe(0);
  });
});

describe("Allow and Deny on the notification", () => {
  function answering(reply: { status: number; body: unknown } | "offline") {
    const f = fakeFetch((method, path) => {
      if (reply === "offline") throw new Error("Network request failed");
      if (method === "POST" && path === "/api/permissions/r1/push-answer") return reply;
    });
    return f;
  }

  test("answer with the push's token alone, at the board it came from", async () => {
    const f = answering({ status: 200, body: { result: "allowed", message: "Allowed." } });
    expect(await answerPrompt(f.fetch, "https://work.tailnet.ts.net/", pushData(notification(promptData))!, "allow")).toEqual({ result: "allowed", message: "Allowed." });
    expect(f.calls).toEqual([
      { method: "POST", url: "https://work.tailnet.ts.net/api/permissions/r1/push-answer", body: { token: "one-time", decision: "allow" }, headers: { "Content-Type": "application/json" } },
    ]);
  });

  test("say when it was answered already, expired, or couldn't be sent", async () => {
    const d = pushData(notification(promptData))!;
    const already = answering({ status: 409, body: { result: "answered", message: "It was already denied." } });
    expect(await answerPrompt(already.fetch, "https://w", d, "allow")).toEqual({ result: "answered", message: "It was already denied." });
    const expired = answering({ status: 409, body: { result: "expired", message: "It expired: the agent's run ended before it was answered." } });
    expect((await answerPrompt(expired.fetch, "https://w", d, "deny")).result).toBe("expired");
    expect((await answerPrompt(answering("offline").fetch, "https://w", d, "deny")).result).toBe("unreachable");
    expect((await answerPrompt(answering({ status: 500, body: "oops" }).fetch, "https://w", d, "deny")).message).toMatch(/500/);
  });

  test("only post to the board's own route for it", async () => {
    const f = answering({ status: 200, body: { result: "allowed", message: "Allowed." } });
    for (const url of ["https://evil.example/x", "//evil.example/api/permissions/r1/push-answer", "/api/tasks/t1", "/api/permissions/r1/push-answer?x=1"]) {
      const d = pushData(notification({ ...promptData, answer: { url, token: "t" } }))!;
      expect((await answerPrompt(f.fetch, "https://w", d, "allow")).result).toBe("invalid");
    }
    expect(f.calls).toEqual([]);
  });

  function deps(urls: Record<string, string>, reply: { status: number; body: unknown }) {
    const f = answering(reply);
    const shown: { title: string; body: string; data: unknown }[] = [];
    const dismissed: string[] = [];
    const opened: unknown[] = [];
    const d: ResponseDeps = {
      boardUrl: async (id) => urls[id] ?? null,
      fetch: f.fetch,
      open: (r) => opened.push(r),
      show: async (title, body, data) => void shown.push({ title, body, data }),
      dismiss: async (id) => void dismissed.push(id),
    };
    return { d, f, shown, dismissed, opened };
  }

  test("answer, then show what happened in place of the notification", async () => {
    const t = deps({ work: "https://work.tailnet.ts.net" }, { status: 200, body: { result: "denied", message: "Denied." } });
    const handle = responseHandler(t.d);
    expect(await handle({ actionIdentifier: DENY, notification: notification(promptData) })).toEqual({ result: "denied", message: "Denied." });
    expect(t.f.calls[0].body).toEqual({ token: "one-time", decision: "deny" });
    expect(t.dismissed).toEqual(["n1"]);
    // The result opens the task when tapped, and can't answer again.
    expect(t.shown).toEqual([{ title: "WEB-3 Fix the login", body: "Denied.", data: { board: "work", host: "h1", task_id: "t1", event: "prompt", request_id: "r1" } }]);
    expect(t.opened).toEqual([]);
  });

  test("a tap that comes by two ways (Android's listener and its background task) is answered once", async () => {
    const t = deps({ work: "https://w" }, { status: 200, body: { result: "allowed", message: "Allowed." } });
    const handle = responseHandler(t.d);
    const r = { actionIdentifier: ALLOW, notification: notification(promptData) };
    await Promise.all([handle(r), handle(r)]);
    expect(t.f.calls).toHaveLength(1);
    expect(t.shown).toHaveLength(1);
  });

  test("a plain tap opens the task; a board no longer paired isn't answered", async () => {
    const t = deps({}, { status: 200, body: { result: "allowed", message: "Allowed." } });
    const handle = responseHandler(t.d);
    await handle({ actionIdentifier: DEFAULT_ACTION, notification: notification(promptData, "n2") });
    expect(t.opened).toEqual([{ pathname: "/task/[board]/[host]/[id]", params: { board: "work", host: "h1", id: "t1" } }]);
    expect(await handle({ actionIdentifier: ALLOW, notification: notification(promptData, "n3") })).toEqual({ result: "invalid", message: expect.stringMatching(/isn't paired/) });
    expect(t.f.calls).toEqual([]);
    // Something that isn't a board's push is left alone.
    expect(await handle({ actionIdentifier: ALLOW, notification: notification({}, "n4") })).toBeNull();
  });

  test("the boards' addresses are kept for the lock screen, without their tokens", async () => {
    const store = memoryStore();
    await saveBoardUrls(store, [board("work"), board("home")]);
    expect(JSON.parse(store.data.get(URLS_KEY)!)).toEqual({ work: "https://work.tailnet.ts.net", home: "https://home.tailnet.ts.net" });
    expect(store.data.get(URLS_KEY)).not.toMatch(/token|dev-/);
    expect(await savedBoardUrl(store, "home")).toBe("https://home.tailnet.ts.net");
    expect(await savedBoardUrl(store, "gone")).toBeNull();
    expect(await savedBoardUrl(memoryStore({ [URLS_KEY]: "not json" }), "home")).toBeNull();
  });
});
