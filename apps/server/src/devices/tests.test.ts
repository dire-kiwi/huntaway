// Port of server/src/devices/tests.rs (HA-136, from the HA-117 branch at bb59d8a), with its push and Assistant tab tests
// (HA-137, HA-138, ported by HA-209; the push ones are in integrations/push/expo_tests.test.ts).
import { afterAll, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import * as testing from "../testing.ts";
import * as db from "../db.ts";
import * as api from "../api.ts";
import { readBody, send } from "../http.ts";
import type { AppState } from "../state.ts";
import { new_id, now } from "../util.ts";
import { upgrade } from "../serve.ts";
import { API_VERSION } from "../hosts/proto.ts";
import { MAX_CODES, hash, list, refused, refused_on_host, type DeviceAuth } from "../devices.ts";

const BOARD = "board-token";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const f of cleanups.splice(0)) f();
});

function state(): AppState {
  const s = testing.state_as({ host_id: "h", host_name: "desktop", token: BOARD, hub_token: "", internal_url: "" });
  api.router(s);
  return s;
}

/** Status and JSON body of a request to `s`'s API with `token` as its bearer token (none for ""). */
async function call(s: AppState, method: string, path: string, token: string, body: any = null, device?: DeviceAuth): Promise<[number, any]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = api.makeReq(method, path, headers, body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  if (device) req.device = device;
  const a = await api.dispatch(s, req);
  try {
    return [a.status, JSON.parse(a.body.toString())];
  } catch {
    return [a.status, null];
  }
}

/** Pairs a device named `name`, returning its token and id. */
async function pair_device(s: AppState, name: string): Promise<[string, string]> {
  const [status, code] = await call(s, "POST", "/api/devices/pairing", BOARD, {});
  assert.equal(status, 200, JSON.stringify(code));
  const [st, paired] = await call(s, "POST", "/api/devices/pair", "", { code: code.code, name });
  assert.equal(st, 200, JSON.stringify(paired));
  return [paired.token, paired.device.id];
}

test("a_code_pairs_one_device_whose_token_the_api_takes", async () => {
  const s = state();
  // No pairing without the board's token, and a made-up code pairs nothing.
  assert.equal((await call(s, "POST", "/api/devices/pairing", "", {}))[0], 401);
  assert.equal((await call(s, "POST", "/api/devices/pair", "", { code: "nope", name: "x" }))[0], 403);

  const [, code] = await call(s, "POST", "/api/devices/pairing", BOARD, {});
  assert.equal(code.ttl_secs, 300);
  const [status, paired] = await call(s, "POST", "/api/devices/pair", "", { code: code.code, name: "  Ivan's\nphone " });
  assert.equal(status, 200);
  assert.deepEqual([paired.device.name, paired.host_id, paired.api_version], ["Ivan'sphone", "h", API_VERSION]);
  const token: string = paired.token;
  assert.notEqual(token, BOARD);
  // Once only.
  assert.equal((await call(s, "POST", "/api/devices/pair", "", { code: code.code, name: "again" }))[0], 403);
  // Only its hash is kept.
  const stored = db.value<string>(s.db(), "SELECT token_hash FROM device_tokens")!;
  assert.equal(stored, hash(token));
  assert.ok(!stored.includes(token));

  // REST, through the hub to this host, and as ?token=.
  assert.deepEqual(await call(s, "GET", "/api/profiles", token), [200, []]);
  assert.deepEqual(await call(s, "GET", "/api/h/h/profiles", token), [200, []]);
  assert.equal((await call(s, "GET", `/api/hosts?token=${token}`, ""))[0], 200);
  assert.equal((await call(s, "GET", "/api/profiles", "wrong"))[0], 401);
  const used = db.value<string | null>(s.db(), "SELECT last_used_at FROM device_tokens");
  assert.ok(used);

  // It lists the devices, knowing itself.
  const [, l] = await call(s, "GET", "/api/devices", token);
  assert.deepEqual([l.devices.length, l.current], [1, paired.device.id]);
  assert.equal((await call(s, "GET", "/api/devices", BOARD))[1].current, null);
});

test("codes_expire", async () => {
  const s = state();
  const [, c] = await call(s, "POST", "/api/devices/pairing", BOARD, {});
  const code: string = c.code;
  assert.ok(s.devices.codes.has(code));
  s.devices.codes.set(code, performance.now() - 1000);
  assert.equal((await call(s, "POST", "/api/devices/pair", "", { code, name: "late" }))[0], 403);
  assert.equal(list(s.db()).length, 0);
  // There's a cap on codes waiting at once.
  for (let i = 0; i < MAX_CODES + 5; i++) await call(s, "POST", "/api/devices/pairing", BOARD, {});
  assert.equal(s.devices.codes.size, MAX_CODES);
});

test("devices_are_managed_from_the_board_and_can_only_unpair_themselves", async () => {
  const s = state();
  const [phone, phone_id] = await pair_device(s, "phone");
  const [tablet, tablet_id] = await pair_device(s, "tablet");

  // A device can't pair more, rename or revoke others.
  assert.equal((await call(s, "POST", "/api/devices/pairing", phone, {}))[0], 403);
  assert.equal((await call(s, "PATCH", `/api/devices/${tablet_id}`, phone, { name: "mine" }))[0], 403);
  assert.equal((await call(s, "DELETE", `/api/devices/${tablet_id}`, phone))[0], 403);
  assert.equal((await call(s, "GET", "/api/profiles", tablet))[0], 200);

  // The board renames and revokes.
  const [status, renamed] = await call(s, "PATCH", `/api/devices/${tablet_id}`, BOARD, { name: "iPad" });
  assert.deepEqual([status, renamed.name], [200, "iPad"]);
  assert.equal((await call(s, "DELETE", `/api/devices/${tablet_id}`, BOARD))[0], 200);
  assert.equal((await call(s, "GET", "/api/profiles", tablet))[0], 401);
  assert.equal((await call(s, "DELETE", `/api/devices/${tablet_id}`, BOARD))[0], 404);

  // A device unpairs itself.
  assert.equal((await call(s, "DELETE", `/api/devices/${phone_id}`, phone))[0], 200);
  assert.equal((await call(s, "GET", "/api/profiles", phone))[0], 401);
  assert.deepEqual(list(s.db()), []);
});

/** Serves `s`'s API on a free port, as serve.ts does (requests through `api.dispatch`, websockets through `upgrade`). */
async function serve(s: AppState): Promise<string> {
  const srv = createServer(async (req, res) => {
    const r = api.makeReq(req.method ?? "GET", req.url ?? "/", req.headers, await readBody(req, 2 << 20));
    r.incoming = req;
    send(res, await api.dispatch(s, r));
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  srv.on("upgrade", (req, socket, head) => void upgrade(s, wss, req, socket, head).catch(() => socket.destroy()));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    srv.closeAllConnections();
    srv.close();
  });
  return `127.0.0.1:${(srv.address() as any).port}`;
}

/** Opens a websocket, resolving with it and its first message, or rejecting with the HTTP status it was refused with. */
function connect(url: string): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("message", (m) => resolve({ ws, first: m.toString() }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

/** Resolves once `ws` is closed, or rejects after `ms`. */
function closed(ws: WebSocket, ms = 5000): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the revoked device's websocket stays open")), ms);
    ws.once("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

test("revoking_a_device_closes_its_websockets", async () => {
  const s = state();
  const addr = await serve(s);
  const [phone, phone_id] = await pair_device(s, "phone");
  const [tablet] = await pair_device(s, "tablet");

  const open = async (path: string, token: string) => {
    const { ws, first } = await connect(`ws://${addr}/api${path}?token=${token}`);
    // Each says hello first.
    assert.ok(first.includes("hello"), first);
    return ws;
  };
  await assert.rejects(connect(`ws://${addr}/api/ws?token=nope`), /refused: 401/);

  // The board's events (the hub's), and the tablet's, which stays open.
  const ui = await open("/ws", phone);
  const other = await open("/ws", tablet);
  assert.equal((await call(s, "DELETE", `/api/devices/${phone_id}`, BOARD))[0], 200);
  await closed(ui);
  // Nor can it open another.
  await assert.rejects(connect(`ws://${addr}/api/ws?token=${phone}`), /refused: 401/);
  // The other device's is still there.
  const next = new Promise<string>((resolve) => other.once("message", (m) => resolve(m.toString())));
  s.hub_events.send({ type: "ping-test" });
  assert.ok((await next).includes("ping-test"));
  other.close();
});

/** A device's websockets for what it may not open are refused before the upgrade, and revoked ones close later too. */
test("a_devices_websockets_are_checked_on_their_path", async () => {
  const s = state();
  const addr = await serve(s);
  const [phone] = await pair_device(s, "phone");
  const p = db.insert_profile(s.db(), "work", [], null);
  const t = db.insert_task(s.db(), { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
  for (const path of [`/h/h/tasks/${t.id}/terminal/ws`, `/tasks/${t.id}/terminal/ws`, "/host/ws", "/h/h/ws", "/h/other/ws", `/h/h/tasks/${t.id}%2Fterminal%2Fws`]) {
    await assert.rejects(connect(`ws://${addr}/api${path}?token=${phone}`), /refused: 403/, path);
  }
  // The board's token still opens them.
  const { ws } = await connect(`ws://${addr}/api/host/ws?token=${BOARD}`);
  ws.close();
});

test("the_inbox_lists_one_profiles_prompts", async () => {
  const s = state();
  const [phone] = await pair_device(s, "phone");
  const work = db.insert_profile(s.db(), "work", [], null);
  const home = db.insert_profile(s.db(), "home", [], null);
  for (const p of [work, home]) {
    const t = db.insert_task(s.db(), { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
    db.run(
      s.db(),
      "INSERT INTO permission_requests (id, task_id, message_id, tool_name, input, status, created_at) VALUES (?1, ?2, 0, 'Bash', '{}', 'pending', ?3)",
      `perm-${p.name}`,
      t.id,
      now(),
    );
  }
  const ids_of = (v: any[]) => v.map((p) => p.id);
  const [, all] = await call(s, "GET", "/api/h/h/permissions", phone);
  assert.deepEqual(ids_of(all), ["perm-work", "perm-home"]);
  const [, mine] = await call(s, "GET", `/api/h/h/permissions?profile_id=${work.id}`, phone);
  assert.deepEqual(ids_of(mine), ["perm-work"]);
  const [, theirs] = await call(s, "GET", `/api/permissions?profile_id=${home.id}`, phone);
  assert.deepEqual(ids_of(theirs), ["perm-home"]);
});

/** A task, and a Claude login with a credentials file, for a device to try to reach. */
function task_and_login(s: AppState, dir: string): [string, string] {
  const p = db.insert_profile(s.db(), "work", [], null);
  const t = db.insert_task(s.db(), { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
  writeFileSync(join(dir, ".credentials.json"), "SECRET-LOGIN");
  const id = new_id();
  db.run(s.db(), "INSERT INTO claude_configs (id, name, config_dir, created_at) VALUES (?1, 'login', ?2, ?3)", id, dir, now());
  return [t.id, id];
}

test("a_device_cant_get_the_boards_tokens_or_a_shell", async () => {
  const s = state();
  const dir = testing.temp_dir();
  const [task, login] = task_and_login(s, dir);
  const [phone, phone_id] = await pair_device(s, "phone");
  // The board's own token still gets them.
  const [status, join_] = await call(s, "GET", "/api/hosts/join", BOARD);
  assert.deepEqual([status, join_.host_token], [200, BOARD]);
  const [st, archive] = await call(s, "GET", `/api/h/h/claude-configs/${login}/archive`, BOARD);
  assert.equal(st, 200, JSON.stringify(archive));
  assert.equal((await call(s, "GET", `/api/h/h/tasks/${task}/terminal`, BOARD))[0], 200);

  const get = (p: string): [string, string] => ["GET", p.replaceAll("{task}", task).replaceAll("{login}", login)];
  const cases: Array<[string, string]> = [
    get("/api/hosts/join"),
    get("/api/h/h/hosts/join"),
    get("/api/tasks/{task}/terminal"),
    get("/api/tasks/{task}/terminal/ws?cols=80"),
    get("/api/h/h/tasks/{task}/terminal/ws"),
    get("/api/claude-configs/{login}/archive"),
    get("/api/h/other-host/claude-configs/{login}/archive"),
    get("/api/profiles/p1/claude-config"),
    // Encoded, through the hub's proxy, which forwards the decoded path with the board's token.
    get("/api/h/h/tasks/{task}%2Fterminal"),
    get("/api/h/h/tasks/{task}%2fterminal"),
    get("/api/h/h/tasks/{task}/%74erminal"),
    get("/api/h/h/tasks/{task}%2Fterminal%2Fws"),
    get("/api/h/h/claude-configs/{login}%2Farchive"),
    get("/api/h/h/%63laude-configs/{login}/archive"),
    get("/api/h/h/claude-configs/{login}/%2561rchive"),
    get("/api/h/h/hosts%2Fjoin"),
    // Empty and dot segments.
    get("/api/h/h/tasks//terminal"),
    get("/api/h/h/tasks/{task}/./terminal"),
    get("/api/h/h/profiles/../tasks/{task}/terminal"),
    get("/api/h/h/tasks/{task}/"),
    // An encoded '?' or '#', which the forwarded URL would cut the path at.
    get("/api/h/h/tasks/{task}%3F/messages"),
    get("/api/h/h/tasks/{task}%23/messages"),
    // Moving a Claude login to another host, linking one, and the rest of what the app doesn't use.
    ["POST", "/api/hosts/copy-claude-config"],
    ["POST", "/api/h/h/hosts/copy-claude-config"],
    ["POST", "/api/hosts"],
    ["POST", "/api/hosts/ssh"],
    get("/api/settings"),
    get("/api/h/h/settings"),
    ["POST", "/api/h/h/admin/restart"],
    get("/api/host/ws"),
    ["DELETE", `/api/h/h/tasks/${task}`],
  ];
  for (const [method, path] of cases) {
    const body = { from_host: "h", to_host: "other", config: "login", url: "http://127.0.0.1:1", token: "x" };
    const [status, out] = await call(s, method, path, phone, method === "POST" ? body : null);
    assert.equal(status, 403, `${method} ${path}: ${JSON.stringify(out)}`);
    assert.ok(!JSON.stringify(out).includes(BOARD) && !JSON.stringify(out).includes('archive":'), path);
  }
  // As ?token= too.
  assert.equal((await call(s, "GET", `/api/hosts/join?token=${phone}`, ""))[0], 403);
  // What the app uses works.
  for (const p of ["/api/hosts", "/api/devices", "/api/profiles", "/api/h/h/profiles", "/api/h/h/permissions", "/api/h/h/tasks/{task}", "/api/h/h/tasks/{task}/messages"]) {
    const path = p.replace("{task}", task);
    assert.equal((await call(s, "GET", path, phone))[0], 200, path);
  }
  // Revoked, it has nothing left that works.
  assert.equal((await call(s, "DELETE", `/api/devices/${phone_id}`, BOARD))[0], 200);
  assert.equal((await call(s, "GET", "/api/hosts/join", phone))[0], 401);
  assert.equal((await call(s, "POST", "/api/devices/pairing", phone, {}))[0], 401);
});

/**
 * The app's Assistant tab (HA-138, ported by HA-209): a device reaches the profile's assistant on the board, through the
 * hub's proxy to the host it's on (`?local=1`, as the app asks for it), and its thread; not the assistant's memory.
 */
test("a_device_reaches_the_profiles_assistant", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "work", [], null);
  const [phone] = await pair_device(s, "phone");
  const [status, a] = await call(s, "GET", `/api/profiles/${p.id}/assistant`, phone);
  assert.deepEqual([status, a.task_type, a.host_id], [200, "assistant", "h"], JSON.stringify(a));
  const [st, again] = await call(s, "GET", `/api/h/h/profiles/${p.id}/assistant?local=1`, phone);
  assert.deepEqual([st, again.id], [200, a.id], JSON.stringify(again));
  assert.equal((await call(s, "GET", `/api/h/h/tasks/${a.id}/messages`, phone))[0], 200);
  assert.equal(refused("POST", `/api/h/h/profiles/${p.id}/assistant`), null);
  for (const rest of ["memory", "memory/file?path=USER.md", "memory/history", "memory/diff"]) {
    const path = `/api/h/h/profiles/${p.id}/assistant/${rest}`;
    assert.equal((await call(s, "GET", path, phone))[0], 403, path);
  }
  for (const rest of ["memory/file", "memory/restore", "memory/import"]) {
    const path = `/api/profiles/${p.id}/assistant/${rest}`;
    assert.equal((await call(s, "POST", path, phone, {}))[0], 403, path);
  }
});

/**
 * The second check: the handlers of what a device must never reach refuse a request that carries one, as a request
 * through the hub's proxy to this host does, whatever the path check let through.
 */
test("credential_handlers_refuse_a_device_themselves", async () => {
  const s = state();
  const dir = testing.temp_dir();
  const [task, login] = task_and_login(s, dir);
  const cases: Array<[string, string]> = [
    ["GET", "/api/hosts/join"],
    ["POST", "/api/hosts"],
    ["POST", "/api/hosts/ssh"],
    ["POST", "/api/hosts/copy-claude-config"],
    ["GET", `/api/claude-configs/${login}/archive`],
    ["POST", `/api/claude-configs/${login}/archive`],
    ["GET", "/api/profiles/p1/claude-config"],
    ["POST", "/api/profiles/p1/claude-config"],
    ["GET", `/api/tasks/${task}/terminal`],
    ["DELETE", `/api/tasks/${task}/terminal`],
    ["POST", `/api/tasks/${task}/terminal/keepalive?tool=x`],
  ];
  for (const [method, path] of cases) {
    const body = { from_host: "h", to_host: "other", config: "login", url: "http://127.0.0.1:1", token: "x", target: "x", archive: "" };
    const [status] = await call(s, method, path, BOARD, body, { id: "d", revoked: s.devices.revoked });
    assert.equal(status, 403, `${method} ${path}`);
  }
  // And the terminal's websocket, before its upgrade.
  const r = api.makeReq("GET", `/api/tasks/${task}/terminal/ws`, {}, Buffer.alloc(0));
  r.params = { id: task };
  r.device = { id: "d", revoked: s.devices.revoked };
  assert.throws(() => api.terminal_ws_check(s, r), (e: any) => e.status === 403);
});

/** Another profile's routes, a revoked token and an unlisted route, through the proxy to a linked host too (HA-208). */
test("a_device_reaches_only_the_listed_routes_of_every_profile_and_host", async () => {
  const s = state();
  const [phone, phone_id] = await pair_device(s, "phone");
  const work = db.insert_profile(s.db(), "work", [], null);
  const home = db.insert_profile(s.db(), "home", [], null);
  // Paired with the board rather than a profile, a device sees every profile's tasks, as the board's token does.
  for (const p of [work, home]) assert.equal((await call(s, "GET", `/api/h/h/profiles/${p.id}/tasks`, phone))[0], 200);
  // Not their settings, analytics or Claude logins, which aren't listed.
  for (const p of [work, home]) {
    for (const rest of ["analytics", "claude-config", "automations", "approval-rules", "assistant/memory"]) {
      assert.equal((await call(s, "GET", `/api/h/h/profiles/${p.id}/${rest}`, phone))[0], 403, rest);
      assert.equal((await call(s, "GET", `/api/profiles/${p.id}/${rest}`, phone))[0], 403, rest);
    }
    assert.equal((await call(s, "PATCH", `/api/profiles/${p.id}`, phone, { name: "x" }))[0], 403);
    assert.equal((await call(s, "DELETE", `/api/profiles/${p.id}`, phone))[0], 403);
  }
  assert.equal((await call(s, "POST", "/api/profiles", phone, { name: "mine" }))[0], 403);
  // A linked host's routes are checked before the proxy forwards them (with the link's token, which the host can't
  // tell from the board's), so an unlisted one never reaches it: here an offline host would answer 503.
  assert.equal((await call(s, "GET", "/api/h/elsewhere/settings", phone))[0], 403);
  assert.equal((await call(s, "GET", "/api/h/elsewhere/profiles", phone))[0], 503);
  // Revoked, nothing: not the listed routes, nor through the proxy.
  assert.equal((await call(s, "DELETE", `/api/devices/${phone_id}`, BOARD))[0], 200);
  for (const path of ["/api/profiles", "/api/h/h/profiles", "/api/h/elsewhere/profiles", "/api/devices", "/api/ws"]) {
    assert.equal((await call(s, "GET", path, phone))[0], 401, path);
  }
});

test("what_a_device_may_do", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "/api/ws"],
    ["GET", "/api/hosts"],
    ["DELETE", "/api/devices/d1"],
    ["GET", "/api/h/x/profiles"],
    ["GET", "/api/profiles/p/tasks"],
    ["POST", "/api/h/x/projects/p/tasks"],
    ["PATCH", "/api/h/x/tasks/a"],
    ["GET", "/api/h/x/tasks/a/messages"],
    ["POST", "/api/h/x/tasks/a/questions/7"],
    ["POST", "/api/h/x/permissions/p"],
    ["GET", "/api/h/x/attachments/a/photo%20one.jpg"],
    ["GET", "/api/h/my%20host/profiles"],
    // HA-138: the Assistant tab.
    ["GET", "/api/profiles/p/assistant"],
    ["POST", "/api/h/x/profiles/p/assistant"],
    // HA-137: the app's push, its own subscriptions.
    ["GET", "/api/push"],
    ["POST", "/api/push/subscriptions"],
    ["PATCH", "/api/push/subscriptions/s1"],
    ["DELETE", "/api/push/subscriptions/s1"],
    ["POST", "/api/push/subscriptions/s1/test"],
    ["POST", "/api/permissions/p/push-answer"],
    // HA-222: a thread on items (no messages since it moved onto them), its window and pages.
    ["GET", "/api/h/x/tasks/a/thread"],
    ["GET", "/api/h/x/tasks/a/thread/items"],
  ];
  for (const [m, p] of allowed) assert.equal(refused(m, p), null, `${m} ${p}`);
  const not: Array<[string, string]> = [
    ["GET", "/api/hosts/join"],
    ["GET", "/api/h/x/hosts/join"],
    ["GET", "/api/h/x/ws"],
    ["GET", "/api/h/x/push"],
    ["POST", "/api/h/x/push/subscriptions"],
    ["GET", "/api/push/subscriptions"],
    ["GET", "/api/h/x/devices"],
    ["DELETE", "/api/h/x/devices/d1"],
    ["PATCH", "/api/devices/d1"],
    ["POST", "/api/devices/pairing"],
    ["POST", "/api/hosts/copy-claude-config"],
    ["DELETE", "/api/tasks/a"],
    ["GET", "/api/tasks/a/terminal"],
    ["GET", "/api/h/x/tasks/a%2Fterminal"],
    ["GET", "/api/h/x/tasks/a/%74erminal"],
    ["GET", "/api/h/x/tasks/a%252Fmessages"],
    ["GET", "/api/h/x/tasks/a%5Cmessages"],
    ["GET", "/api/h/x/tasks//messages"],
    ["GET", "/api/h/x/tasks/./messages"],
    ["GET", "/api/h/x/tasks/../tasks/a"],
    ["GET", "/api/h/x/h/y/profiles"],
    ["GET", "/api/h/x/attachments/a/%FF"],
    // A '?' or '#' that the proxy's forwarded URL would cut the path at.
    ["GET", "/api/h/x/tasks/a%3F/messages"],
    ["GET", "/api/h/x/tasks/a%3f/messages"],
    ["GET", "/api/h/x/tasks/a%23/messages"],
    ["POST", "/api/h/x/permissions/p%3Fx"],
    ["GET", "/api/profiles/"],
    ["GET", "/api/h/x/profiles/p/assistant/memory"],
    ["POST", "/api/profiles/p/assistant/memory/import"],
    ["GET", "/api"],
    ["GET", "/profiles"],
    // The thread's commands are the board's routes it has already, and its events come on the hub's socket.
    ["POST", "/api/h/x/tasks/a/thread/commands"],
    ["GET", "/api/h/x/tasks/a/thread/events"],
  ];
  for (const [m, p] of not) assert.notEqual(refused(m, p), null, `${m} ${p}`);
  // The proxy's own check, on the path it forwards.
  assert.equal(refused_on_host("GET", "tasks/a/messages"), null);
  assert.notEqual(refused_on_host("GET", "tasks/a/terminal"), null);
  assert.notEqual(refused_on_host("GET", "hosts/join"), null);
  assert.notEqual(refused_on_host("GET", "tasks/a?/messages"), null);
  assert.notEqual(refused_on_host("GET", "tasks/a#/messages"), null);
});
