import { createClient, EXPO_PUSH_API, type PushDevice } from "@huntaway/client";
import { Boards, tokenKey, type Board } from "../src/boards";
import {
  ALLOW,
  answerPrompt,
  DEFAULT_ACTION,
  DENY,
  pushable,
  pushData,
  responseHandler,
  handledStore,
  PENDING_KEY,
  PushRegistrar,
  RETRY_FIRST,
  RETRY_MAX,
  saveBoardUrls,
  savedBoardUrl,
  subscriptionOn,
  taskRoute,
  URLS_KEY,
  type ResponseDeps,
} from "../src/push";
import { memoryStorage } from "../src/pairing";
import { fakeFetch, memoryStore } from "./helpers";

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

/** A board's push API as a paired phone sees it (only its own subscriptions), which can be down. */
function fakeBoard(id: string) {
  const b = {
    down: false,
    failDelete: false,
    /** What it answers a subscription with instead of taking it. */
    refuse: 0,
    /** The device tokens it takes (others are turned down as unpaired). */
    tokens: new Set([`device-${id}`]),
    subs: [] as PushDevice[],
    revoked: [] as string[],
  };
  const f = fakeFetch((method, path, body, headers) => {
    if (b.down) throw new Error("Network request failed");
    if (!b.tokens.has((headers.Authorization ?? "").replace("Bearer ", ""))) return { status: 401, body: { error: "unauthorized" } };
    if (method === "POST" && path === "/api/push/subscriptions") {
      if (b.refuse) return { status: b.refuse, body: { error: "a paired device can only subscribe the app" } };
      const { endpoint, kind, name } = body as { endpoint: string; kind: string; name: string };
      const old = b.subs.find((x) => x.endpoint === endpoint);
      if (old) return { status: 200, body: old };
      const sub = { id: `s${b.subs.length + 1}`, endpoint, kind, name, events: { attention: true, review: true, merge: false, done: false }, created_at: "", last_sent_at: null, last_error: null } as PushDevice;
      b.subs.push(sub);
      return { status: 200, body: sub };
    }
    if (method === "GET" && path === "/api/push") return { status: 200, body: { public_key: "k", subscriptions: b.subs } };
    const del = path.match(/^\/api\/push\/subscriptions\/(.+)$/);
    if (method === "DELETE" && del) {
      if (b.failDelete) return { status: 502, body: { error: "the board's busy" } };
      if (!b.subs.some((x) => x.id === del[1])) return { status: 404, body: { error: "no subscription" } };
      b.subs = b.subs.filter((x) => x.id !== del[1]);
      return { status: 200, body: { ok: true } };
    }
    const dev = path.match(/^\/api\/devices\/(.+)$/);
    if (method === "DELETE" && dev) {
      b.revoked.push(dev[1]);
      b.subs = [];
      return { status: 200, body: { ok: true } };
    }
  });
  return { ...b, state: b, calls: f.calls, fetch: f.fetch };
}

/** A registrar over boards kept in `store`, talking to `fakes`, with its retries collected rather than waited for. */
async function setup(list: Board[], fakes: Record<string, ReturnType<typeof fakeBoard>>, opts: { store?: ReturnType<typeof memoryStore>; token?: () => { token: string } | { retry: boolean } } = {}) {
  const store = opts.store ?? memoryStore();
  const boards = new Boards(store);
  await boards.load();
  for (const b of list) if (!boards.board(b.id)) await boards.add(b, `device-${b.id}`);
  const retries: { ms: number; fn: () => void }[] = [];
  const registrar = new PushRegistrar({
    boards,
    store,
    expoToken: async () => (opts.token ? opts.token() : { token: "ExponentPushToken[abc]" }),
    name: () => "Pixel",
    clientFor: (b, token) =>
      createClient({ baseUrl: b.url, getToken: () => token ?? boards.token(b.id), setToken: () => {}, storage: memoryStorage(), fetch: fakes[b.id].fetch }),
    later: (fn, ms) => {
      const drop = () => retries.includes(r) && void retries.splice(retries.indexOf(r), 1);
      const r = {
        ms,
        fn: () => {
          drop();
          fn();
        },
      };
      retries.push(r);
      return drop;
    },
  });
  return { store, boards, registrar, retries };
}

const subscribeCalls = (f: ReturnType<typeof fakeBoard>) => f.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/push/subscriptions"));

describe("subscribing", () => {
  test("on each board that can push, with the Expo token and without changing its events", async () => {
    const fakes = { work: fakeBoard("work"), home: fakeBoard("home"), old: fakeBoard("old"), off: fakeBoard("off") };
    const list = [board("work"), board("home"), board("old", { apiVersion: EXPO_PUSH_API - 1 }), board("off", { push: false })];
    expect(list.map(pushable)).toEqual([true, true, false, false]);
    const { registrar, boards } = await setup(list, fakes);
    await registrar.sync();
    expect(Object.keys(registrar.subscribed).sort()).toEqual(["home", "work"]);
    expect(subscribeCalls(fakes.work)).toEqual([
      expect.objectContaining({ body: { kind: "expo", endpoint: "ExponentPushToken[abc]", name: "Pixel" }, headers: expect.objectContaining({ Authorization: "Bearer device-work" }) }),
    ]);
    expect(fakes.old.calls).toEqual([]);
    expect(fakes.off.calls).toEqual([]);
    // Not again for the same token and pairing; again once the phone pairs again there, or its token changes.
    await registrar.sync();
    expect(subscribeCalls(fakes.work)).toHaveLength(1);
    fakes.work.state.tokens.add("device-work2");
    await boards.add(board("work", { deviceId: "dev-new" }), "device-work2");
    await registrar.sync();
    expect(subscribeCalls(fakes.work)).toHaveLength(2);
    await registrar.tokenChanged();
    expect(subscribeCalls(fakes.work)).toHaveLength(3);
    expect((await subscriptionOn(createClient({ baseUrl: "https://w", getToken: () => "device-work", setToken: () => {}, storage: memoryStorage(), fetch: fakes.work.fetch }), "ExponentPushToken[abc]"))?.id).toBe("s1");
  });

  test("a board that couldn't be reached is subscribed once it can be, without anything done in the app", async () => {
    const fakes = { work: fakeBoard("work") };
    fakes.work.state.down = true;
    const { registrar, retries } = await setup([board("work")], fakes);
    await registrar.sync();
    expect(registrar.subscribed.work.error).toMatch(/Network request failed/);
    // It tries again by itself, waiting longer each time, up to a limit.
    expect(retries.map((r) => r.ms)).toEqual([RETRY_FIRST]);
    retries[0].fn();
    await registrar.sync();
    expect(retries.map((r) => r.ms)).toEqual([RETRY_FIRST * 4]);
    for (let i = 0; i < 10; i++) await registrar.sync();
    expect(retries.map((r) => r.ms)).toEqual([RETRY_MAX]);
    // It's back (its websocket connects, which syncs).
    fakes.work.state.down = false;
    await registrar.sync();
    expect(registrar.subscribed.work.device?.endpoint).toBe("ExponentPushToken[abc]");
    expect(fakes.work.state.subs).toHaveLength(1);
    expect(retries).toEqual([]);
  });

  test("no token yet because Expo couldn't be reached is tried again; notifications not allowed isn't", async () => {
    const fakes = { work: fakeBoard("work") };
    let token: { token: string } | { retry: boolean } = { retry: true };
    const { registrar, retries } = await setup([board("work")], fakes, { token: () => token });
    await registrar.sync();
    expect(retries).toHaveLength(1);
    token = { token: "ExponentPushToken[abc]" };
    retries[0].fn();
    await registrar.sync();
    expect(fakes.work.state.subs).toHaveLength(1);
    const denied = await setup([board("home")], { home: fakeBoard("home") }, { token: () => ({ retry: false }) });
    await denied.registrar.sync();
    expect(denied.retries).toEqual([]);
  });
});

describe("what the board says of it", () => {
  test("a subscription the board turns down isn't retried, and says why", async () => {
    for (const status of [400, 401, 403]) {
      const fakes = { work: fakeBoard("work") };
      fakes.work.state.refuse = status;
      const { registrar, retries } = await setup([board("work")], fakes);
      await registrar.sync();
      expect(registrar.subscribed.work).toEqual({ error: expect.stringMatching(/only subscribe the app|Unauthorized/), final: true });
      expect(retries).toEqual([]);
      await registrar.sync();
      expect(subscribeCalls(fakes.work)).toHaveLength(1);
      // Tried again with a new token (or pairing, or push turned off and on).
      fakes.work.state.refuse = 0;
      await registrar.tokenChanged();
      expect(subscribeCalls(fakes.work)).toHaveLength(2);
      expect(registrar.subscribed.work.device).toBeDefined();
    }
  });

  test("a subscription gone from the board (removed there, or dropped as unregistered) is made again", async () => {
    const fakes = { work: fakeBoard("work") };
    const { registrar } = await setup([board("work")], fakes);
    await registrar.sync();
    expect(subscribeCalls(fakes.work)).toHaveLength(1);
    // Still there: nothing to do when it reconnects.
    await registrar.sync();
    expect(subscribeCalls(fakes.work)).toHaveLength(1);
    fakes.work.state.subs = [];
    await registrar.sync();
    expect(subscribeCalls(fakes.work)).toHaveLength(2);
    expect(fakes.work.state.subs.map((x) => x.endpoint)).toEqual(["ExponentPushToken[abc]"]);
    // Offline, it isn't taken for gone.
    fakes.work.state.down = true;
    await registrar.sync();
    fakes.work.state.down = false;
    expect(subscribeCalls(fakes.work)).toHaveLength(2);
  });
});

describe("turning push off, and removing a board", () => {
  test("off while the board can't be reached stays off, and is done on the board once it can be", async () => {
    const fakes = { work: fakeBoard("work") };
    const { registrar, boards, store, retries } = await setup([board("work")], fakes);
    await registrar.sync();
    expect(fakes.work.state.subs).toHaveLength(1);
    fakes.work.state.down = true;
    await registrar.setPush("work", false);
    expect(boards.board("work")?.push).toBe(false);
    expect(registrar.pendingOn("work")).toBe(true);
    expect(JSON.parse(store.data.get(PENDING_KEY)!)).toEqual([{ kind: "unsubscribe", board: "work" }]);
    expect(retries).toHaveLength(1);
    // Back, but its delete fails: still to do.
    fakes.work.state.down = false;
    fakes.work.state.failDelete = true;
    await registrar.sync();
    expect(registrar.pendingOn("work")).toBe(true);
    expect(fakes.work.state.subs).toHaveLength(1);
    fakes.work.state.failDelete = false;
    await registrar.sync();
    expect(registrar.pendingOn("work")).toBe(false);
    expect(fakes.work.state.subs).toEqual([]);
    // And it isn't subscribed again.
    await registrar.sync();
    expect(fakes.work.state.subs).toEqual([]);
  });

  test("what's still to do is done after a restart", async () => {
    const fakes = { work: fakeBoard("work") };
    const first = await setup([board("work")], fakes);
    await first.registrar.sync();
    fakes.work.state.down = true;
    await first.registrar.setPush("work", false);
    fakes.work.state.down = false;
    const again = await setup([], fakes, { store: first.store });
    await again.registrar.sync();
    expect(fakes.work.state.subs).toEqual([]);
    expect(again.registrar.pending).toEqual([]);
  });

  test("on again before the board was told drops the off, and keeps its subscription", async () => {
    const fakes = { work: fakeBoard("work") };
    const { registrar } = await setup([board("work")], fakes);
    await registrar.sync();
    fakes.work.state.down = true;
    await registrar.setPush("work", false);
    fakes.work.state.down = false;
    await registrar.setPush("work", true);
    expect(registrar.pending).toEqual([]);
    expect(fakes.work.state.subs).toHaveLength(1);
    expect(registrar.subscribed.work.device?.id).toBe("s1");
  });

  test("a board removed while it can't be reached is unpaired, with its old token, once it can be", async () => {
    const fakes = { work: fakeBoard("work") };
    const { registrar, boards, store } = await setup([board("work")], fakes);
    await registrar.sync();
    fakes.work.state.down = true;
    await registrar.removeBoard("work");
    expect(boards.board("work")).toBeUndefined();
    expect(store.data.get(tokenKey("work"))).toBeUndefined();
    expect(JSON.parse(store.data.get(PENDING_KEY)!)).toEqual([{ kind: "revoke", board: "work", url: "https://work.tailnet.ts.net", deviceId: "dev-work", token: "device-work" }]);
    fakes.work.state.down = false;
    await registrar.sync();
    expect(fakes.work.state.revoked).toEqual(["dev-work"]);
    expect(fakes.work.state.subs).toEqual([]);
    expect(store.data.get(PENDING_KEY)).toBe("[]");
  });

  test("a removed board that has unpaired the phone already has nothing left to do", async () => {
    const fakes = { work: fakeBoard("work") };
    const { registrar } = await setup([board("work")], fakes);
    fakes.work.state.tokens.clear();
    await registrar.removeBoard("work");
    expect(registrar.pending).toEqual([]);
    expect(fakes.work.state.revoked).toEqual([]);
  });

  test("pairing a board again keeps its push turned off", async () => {
    const boards = new Boards(memoryStore());
    await boards.load();
    await boards.add(board("work"), "t1");
    await boards.update("work", { push: false });
    await boards.add(board("work", { deviceId: "dev-2" }), "t2");
    expect(boards.board("work")?.push).toBe(false);
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

  test("a tap handed over again after a restart isn't handled again", async () => {
    const store = memoryStore();
    const t = deps({ work: "https://w" }, { status: 200, body: { result: "allowed", message: "Allowed." } });
    const r = { actionIdentifier: ALLOW, notification: notification(promptData, "n9") };
    expect((await responseHandler({ ...t.d, seen: handledStore(store) })(r))?.result).toBe("allowed");
    // The app started again, and getLastNotificationResponseAsync gives the same tap.
    expect(await responseHandler({ ...t.d, seen: handledStore(store) })(r)).toBeNull();
    const tap = { actionIdentifier: DEFAULT_ACTION, notification: notification(promptData, "n10") };
    await responseHandler({ ...t.d, seen: handledStore(store) })(tap);
    await responseHandler({ ...t.d, seen: handledStore(store) })(tap);
    expect(t.f.calls).toHaveLength(1);
    expect(t.opened).toHaveLength(1);
    // Only the last ones are kept.
    const few = handledStore(memoryStore(), 3);
    await Promise.all(["a", "b", "c", "d"].map((k) => few.add(k)));
    expect([await few.has("a"), await few.has("d")]).toEqual([false, true]);
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
