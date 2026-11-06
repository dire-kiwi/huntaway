import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// The package's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { ApiError, assistantHome, createClient, moveTask } = await import("@huntaway/client");

/** A board at `baseUrl` whose requests are recorded, answering `answer(url, init)` (200 with `{}` by default). */
function board(baseUrl, { token = "", answer, wsBase } = {}) {
  const requests = [];
  const values = new Map();
  let saved = token;
  const client = createClient({
    baseUrl,
    getToken: () => saved,
    setToken: (t) => (saved = t),
    storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    wsBase,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      const { status = 200, body = {} } = answer?.(url, init) ?? {};
      return { ok: status < 300, status, statusText: `status ${status}`, json: async () => body };
    },
  });
  return { client, requests, values, token: () => saved };
}

test("each client calls its own board with its own token", async () => {
  const work = board("https://work.example", { token: "w" });
  const home = board("http://home.example:7878", { token: "h" });
  await work.client.task("local", "t 1");
  await home.client.hosts();
  assert.deepEqual(
    work.requests.map((r) => [r.method, r.url, r.headers.Authorization]),
    [["GET", "https://work.example/api/h/local/tasks/t%201", "Bearer w"]],
  );
  assert.deepEqual(
    home.requests.map((r) => [r.method, r.url, r.headers.Authorization]),
    [["GET", "http://home.example:7878/api/hosts", "Bearer h"]],
  );
  home.client.setToken("h2");
  assert.equal(home.token(), "h2");
  assert.equal(work.client.getToken(), "w");
});

test("a body is sent as JSON, and an error answer is an ApiError with the server's message", async () => {
  const b = board("", { answer: (url) => (url.endsWith("/tasks/t") ? { status: 409, body: { error: "busy" } } : undefined) });
  await b.client.renameHost("x", "new");
  assert.equal(b.requests[0].url, "/api/hosts/x");
  assert.equal(b.requests[0].headers["Content-Type"], "application/json");
  assert.equal(b.requests[0].body, JSON.stringify({ name: "new" }));
  await assert.rejects(b.client.updateTask("local", "t", { title: "x" }), (e) => e instanceof ApiError && e.status === 409 && e.message === "busy");
});

test("a 401 tells that client's handler, with the token the request was made with", async () => {
  const a = board("https://a.example", { token: "old", answer: () => ({ status: 401 }) });
  const b = board("https://b.example", { token: "fine" });
  const seen = [];
  a.client.setUnauthorizedHandler((t) => seen.push(["a", t]));
  b.client.setUnauthorizedHandler((t) => seen.push(["b", t]));
  await assert.rejects(a.client.hosts(), (e) => e.status === 401);
  await b.client.hosts();
  assert.deepEqual(seen, [["a", "old"]]);
});

test("websocket addresses follow the board's address unless the app gives its own", () => {
  assert.equal(board("https://a.example", { token: "t k" }).client.wsUrl(), "wss://a.example/api/ws?token=t%20k");
  assert.equal(board("http://b.example:7878").client.terminalWsUrl("h", "t", 80, 24), "ws://b.example:7878/api/h/h/tasks/t/terminal/ws?cols=80&rows=24&token=");
  assert.equal(board("", { token: "x", wsBase: () => "ws://page" }).client.wsUrl("/ws?since=3"), "ws://page/api/ws?since=3&token=x");
});

test("the open token is asked of each client's board, and remembered in its own storage", async () => {
  const open = board("https://preview.example", { answer: () => ({ body: { token: "p" } }) });
  const closed = board("https://mine.example", { token: "m", answer: () => ({ status: 404 }) });
  assert.equal(await open.client.fetchOpenToken(), true);
  assert.equal(await closed.client.fetchOpenToken(), false);
  assert.equal(open.requests[0].url, "https://preview.example/api/open-token");
  assert.equal(open.token(), "p");
  assert.equal(open.client.isOpenBoard(), true);
  assert.equal(closed.client.isOpenBoard(), false);
  assert.equal(closed.client.shouldFetchOpenToken(), false);
  assert.equal(open.values.get("ia.openBoard"), "1");
  assert.equal(closed.values.get("ia.openBoard"), "0");
  // Asked again with the same token, it's no change.
  assert.equal(await open.client.fetchOpenToken(), false);
});

test("a move is remembered in the storage of the client that made it", async () => {
  const a = board("https://a.example");
  const b = board("https://b.example");
  await a.client.updateTask("local", "t", { status: "done" });
  assert.equal(a.client.movedHere("local", "t", "done"), true);
  assert.equal(a.client.movedHere("local", "t", "review"), false);
  assert.equal(b.client.movedHere("local", "t", "done"), false);
});

test("storage that throws (a browser that blocks it) is no token and nothing remembered", async () => {
  const blocked = () => {
    throw new Error("blocked");
  };
  const client = createClient({
    baseUrl: "",
    getToken: blocked,
    setToken: blocked,
    storage: { getItem: blocked, setItem: blocked },
    fetch: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ token: "p" }) }),
  });
  assert.equal(client.getToken(), "");
  assert.equal(client.shouldFetchOpenToken(), true);
  await client.fetchOpenToken();
  await client.updateTask("local", "t", { status: "done" });
  assert.equal(client.movedHere("local", "t", "done"), false);
});

// HA-119: the assistant works in a folder of its own, but isn't a task that makes only documents.
test("a profile's assistant isn't a documents-only task", async () => {
  const { documentsOnly, isAssistant, ASSISTANT_API, hasAssistant, MEMORY_API, hasMemory } = await import("@huntaway/client");
  const assistant = { kind: "task", task_type: "assistant", labels: [], work_dir: "assistants/a1" };
  assert.equal(isAssistant(assistant), true);
  assert.equal(documentsOnly(assistant), false);
  // As a document task from before labels, with its folder in the data dir, is.
  assert.equal(documentsOnly({ kind: "task", task_type: null, labels: ["plan"], work_dir: "documents/t1" }), true);
  assert.equal(hasAssistant({ local: false, api_version: ASSISTANT_API - 1 }), false);
  assert.equal(hasAssistant({ local: false, api_version: ASSISTANT_API }), true);
  // Its Memory tab, from API 111.
  assert.equal(hasMemory({ local: false, api_version: ASSISTANT_API }), false);
  assert.equal(hasMemory({ local: false, api_version: MEMORY_API }), true);
});

test("the assistant's calls go to its profile on its host", async () => {
  const { client, requests } = board("http://board");
  await client.assistant("h1", "p 1");
  await client.sendToAssistant("h1", "p 1", "Hi");
  await client.groupTasks("h1", "p1", true);
  assert.deepEqual(
    requests.map((r) => [r.method ?? "GET", r.url]),
    [
      ["GET", "http://board/api/h/h1/profiles/p%201/assistant"],
      ["POST", "http://board/api/h/h1/profiles/p%201/assistant"],
      ["GET", "http://board/api/h/h1/profiles/p1/group-tasks?include_assistant=true"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].body), { text: "Hi" });
});

// HA-120: a profile's assistant can run on a linked host of its own, which the board goes to in whatever state it's in.
test("a profile's assistant is on its assistant host, or else the board's own host", () => {
  const host = (id, more = {}) => ({ id, name: id, local: id === "hub", connected: true, mode: id === "hub" ? "local" : "ssh", api_version: 112, ...more });
  const profile = (host_id, id, more = {}) => ({ host_id, id, name: "personal", ...more });
  const hosts = [host("hub"), host("home"), host("laptop")];
  // No setting: the board's own host's profile, else the first connected host with assistants that has one.
  assert.deepEqual(assistantHome([profile("laptop", "pl"), profile("hub", "ph")], hosts, "personal"), { hostId: "hub", profileId: "ph" });
  assert.deepEqual(assistantHome([profile("laptop", "pl")], hosts, "personal"), { hostId: "laptop", profileId: "pl" });
  assert.equal(assistantHome([profile("laptop", "pl")], [host("hub"), host("laptop", { api_version: 108 })], "personal"), undefined);
  // The board's own profile picks the host, and its profile of that name there.
  const placed = [profile("hub", "ph", { assistant_host: "home" }), profile("home", "pr"), profile("laptop", "pl")];
  assert.deepEqual(assistantHome(placed, hosts, "personal"), { hostId: "home", profileId: "pr" });
  // Rather than falling back to another host, it says why it can't be opened there.
  assert.deepEqual(assistantHome(placed, [host("hub"), host("home", { connected: false }), host("laptop")], "personal"), { hostId: "home", unavailable: "offline" });
  assert.deepEqual(assistantHome(placed, [host("hub"), host("laptop")], "personal"), { hostId: "home", unavailable: "offline" });
  assert.deepEqual(assistantHome(placed, [host("hub"), host("home", { api_version: 100 })], "personal"), { hostId: "home", unavailable: "old" });
  // One with assistants but from before assistant hosts can't be one.
  assert.deepEqual(assistantHome(placed, [host("hub"), host("home", { api_version: 111 })], "personal"), { hostId: "home", unavailable: "old" });
  assert.deepEqual(assistantHome([placed[0]], hosts, "personal"), { hostId: "home", unavailable: "no_profile" });
  // Another host's setting doesn't count, nor does one naming the board's own host.
  assert.deepEqual(assistantHome([profile("hub", "ph"), profile("laptop", "pl", { assistant_host: "home" })], hosts, "personal"), { hostId: "hub", profileId: "ph" });
  assert.deepEqual(assistantHome([profile("hub", "ph", { assistant_host: "hub" })], hosts, "personal"), { hostId: "hub", profileId: "ph" });
});

// HA-262: moving a card to In progress on the phone didn't start its agent. Every move goes through moveTask, which
// sends the empty message that starts a fresh task's agent, as dragging its card on the board does.
test("a fresh task moved into In progress starts its agent, where one can run", async () => {
  const desk = { id: "h", local: true, connected: true };
  const moves = async (task, status, host = desk) => {
    const { client, requests } = board("http://board");
    await moveTask(client, { id: "t1", host_id: "h", status: "todo", session_id: null, running: false, ...task }, status, host, { position: 2 });
    return requests.map((r) => [r.method, r.url, JSON.parse(r.body)]);
  };
  assert.deepEqual(await moves({}, "in_progress"), [
    ["PATCH", "http://board/api/h/h/tasks/t1", { position: 2, status: "in_progress" }],
    ["POST", "http://board/api/h/h/tasks/t1/messages", { text: "" }],
  ]);
  const patch = [["PATCH", "http://board/api/h/h/tasks/t1", { position: 2, status: "in_progress" }]];
  // Not a fresh task, already in progress, or on a host that can't run agents: just the move.
  assert.deepEqual(await moves({ session_id: "s" }, "in_progress"), patch);
  assert.deepEqual(await moves({ running: true }, "in_progress"), patch);
  assert.deepEqual(await moves({ status: "in_progress" }, "in_progress"), patch);
  assert.deepEqual(await moves({}, "in_progress", { id: "h", local: true, connected: false }), patch);
  assert.deepEqual(await moves({}, "in_progress", { id: "h", local: true, connected: true, agents: false }), patch);
  assert.deepEqual(await moves({}, "in_review"), [["PATCH", "http://board/api/h/h/tasks/t1", { position: 2, status: "in_review" }]]);
});
