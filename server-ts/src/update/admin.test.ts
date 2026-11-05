// Port of the tests in server/src/update/admin.rs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sleep } from "../util.ts";
import * as testing from "../testing.ts";
import * as db from "../db.ts";
import * as backup from "../backup.ts";
import type { AppState } from "../state.ts";
import { builds_shim, bundle, check_deployed, pick_bundle_commit, status } from "./admin.ts";
import * as api from "../api.ts";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

const servers: Array<() => void> = [];
after(() => servers.forEach((f) => f()));

function sh(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, msg: string): string {
  sh(dir, ["commit", "-q", "--allow-empty", "-m", msg]);
  return sh(dir, ["rev-parse", "HEAD"]);
}

/** A server whose `/api/health` says it runs `commit` (or none). */
async function deployment(c: string | null): Promise<string> {
  const srv = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, commit: c })));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

/** An origin with one commit, cloned as the source checkout: [origin, checkout, commit]. */
function checkout(): [string, string, string] {
  const root = testing.temp_dir();
  const origin = join(root, "origin");
  mkdirSync(origin, { recursive: true });
  sh(origin, ["init", "-q", "-b", "master"]);
  const first = commit(origin, "first");
  sh(root, ["clone", "-q", origin, "src"]);
  return [origin, join(root, "src"), first];
}

/** A host following `url` from the checkout `src`, running its HEAD. */
function host_at(src: string, url: string): AppState {
  const head = sh(src, ["rev-parse", "HEAD"]);
  return testing.state_with({ boot_id: "", started_at: "", source_dir: src, running_commit: head, update_from: url, release: null, args: [] });
}

/**
 * HA-97: a deployed hub that updated itself to a release kept reporting its bundle's IA_COMMIT, so hosts that follow it,
 * and the checkouts it updates, went by the old commit.
 */
/**
 * HA-185: Update to <commit> on a linked checkout host sent a bundle of the hub's whole branch, which for this repository
 * is several MB, and the host (Rust, or TS before it took more) refused any request body over 2 MB, so no update got
 * through. The hub now sends only the commits after the one the host runs, which the host can fetch, and a host takes a
 * bigger bundle from an older hub.
 */
test("a_hub_bundles_only_the_commits_a_host_lacks", async () => {
  const [, src] = checkout();
  writeFileSync(join(src, "big.bin"), randomBytes(3 << 20));
  sh(src, ["add", "big.bin"]);
  const host_runs = commit(src, "big");
  // The host: a clone at that commit, on the same branch.
  const host = join(testing.temp_dir(), "host");
  sh(src, ["clone", "-q", src, host]);
  commit(src, "second");
  const head = commit(src, "third");
  const state = host_at(src, "");
  const size = (b: any) => Buffer.from(b.bundle, "base64").length;

  const thin = await bundle(state, host_runs);
  assert.deepEqual([thin.branch, thin.commit], ["master", head]);
  assert.ok(size(thin) < 64 << 10, `a bundle of two empty commits is ${size(thin)} bytes`);
  // The host has what it needs to fetch it, and fast-forwards to the hub's commit.
  const file = join(host, "..", "in.bundle");
  writeFileSync(file, Buffer.from(thin.bundle, "base64"));
  sh(host, ["fetch", "-q", file, "refs/heads/master:refs/remotes/hub/master"]);
  sh(host, ["merge", "-q", "--ff-only", head]);
  assert.equal(sh(host, ["rev-parse", "HEAD"]), head);

  // The whole branch without a commit to start from, or one the branch is at, or one it doesn't have or that isn't on it.
  const beside = sh(src, ["commit-tree", "-m", "beside", `${host_runs}^{tree}`]);
  for (const since of [null, head, "0123456789abcdef0123456789abcdef01234567", beside, "not a commit"]) {
    assert.ok(size(await bundle(state, since)) > 3 << 20, `since ${since}`);
  }
  // A host takes a bundle that big.
  assert.ok(api.router(state).find("/admin/update")!.route.limit >= 64 << 20);
});

test("a_release_reports_the_commit_it_was_built_from", () => {
  const deployed = () => "bundle";
  assert.equal(pick_bundle_commit("built", deployed(), false), "built");
  assert.equal(pick_bundle_commit("built", deployed(), true), "built");
  // A build that doesn't know its commit: the deployment's bundle goes by IA_COMMIT, a release in app/ by none.
  assert.equal(pick_bundle_commit(null, deployed(), false), "bundle");
  assert.equal(pick_bundle_commit(" ", " bundle\n", false), "bundle");
  assert.equal(pick_bundle_commit(null, deployed(), true), null);
  assert.equal(pick_bundle_commit(null, "", false), null);
});

test("offers_the_commits_a_deployment_runs_ahead_of_this_host", async () => {
  const [origin, src] = checkout();
  commit(origin, "second");
  const ahead = commit(origin, "third");
  const url = await deployment(ahead);
  const state = host_at(src, url);
  await check_deployed(state, url);
  assert.deepEqual([state.deployed!.commit, state.deployed!.error], [ahead, null]);
  // Fetched from origin, so the status lists what it adds.
  const v = await status(state);
  assert.deepEqual(v.deployed_commits.map((c: string) => c.slice(c.indexOf(" ") + 1)), ["third", "second"]);
  assert.equal(v.update_from, url);
});

test("offers_nothing_for_a_deployment_behind_or_beside_this_host", async () => {
  const [origin, src, first] = checkout();
  // This host is ahead of what's deployed.
  commit(src, "local");
  let url = await deployment(first);
  let state = host_at(src, url);
  await check_deployed(state, url);
  let v = await status(state);
  assert.equal(v.deployed.commit, first);
  assert.deepEqual(v.deployed_commits, []);
  // Diverged: the deployment runs a commit beside this host's.
  const beside = commit(origin, "elsewhere");
  url = await deployment(beside);
  state = host_at(src, url);
  await check_deployed(state, url);
  v = await status(state);
  assert.deepEqual([v.deployed.commit, v.deployed.error], [beside, null]);
  assert.deepEqual(v.deployed_commits, []);
});

test("keeps_the_last_commit_when_a_check_fails", async () => {
  const [origin, src] = checkout();
  const ahead = commit(origin, "second");
  const url = await deployment(ahead);
  const state = host_at(src, url);
  await check_deployed(state, url);
  // One that doesn't say (from before API 65), or a commit origin doesn't have.
  for (const [c, why] of [[null, "doesn't say which commit"], ["0".repeat(40), "isn't on this checkout's origin"]] as Array<[string | null, string]>) {
    const other = await deployment(c);
    await check_deployed(state, other);
    const d = state.deployed!;
    assert.equal(d.commit, ahead);
    assert.ok(d.error?.includes(why), JSON.stringify(d));
  }
  assert.equal((await status(state)).deployed_commits.length, 1);
});

// ---------- restarting through bin/huntaway (the TypeScript server's own: the Rust server execs itself) ----------

const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url));

/** A free port on 127.0.0.1. */
async function free_port(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  await new Promise((r) => srv.close(r));
  return port;
}

/** `bin/huntaway serve` on `data_dir` (a new one by default), with no agents, and the `IA_READY` lines it prints, as they come. */
function serve_bin(args: string[], env: Record<string, string> = {}, data_dir = testing.temp_dir()) {
  const child = spawn(BIN, ["serve", "--host", "127.0.0.1", "--data-dir", data_dir, ...args], {
    env: { ...process.env, IA_CLAUDE_BIN: "/bin/false", IA_CODEX_BIN: "/bin/false", TMPDIR: data_dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(() => child.kill("SIGKILL"));
  const ready: any[] = [];
  let wake = () => {};
  createInterface({ input: child.stdout! }).on("line", (l) => {
    if (l.startsWith("IA_READY ")) ready.push(JSON.parse(l.slice(9)));
    wake();
  });
  let log = "";
  child.stderr!.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return {
    child,
    data_dir,
    exited,
    log: () => log,
    /** The `n`th IA_READY line (from 1). */
    async ready(n: number) {
      const deadline = Date.now() + 30_000;
      while (ready.length < n) {
        if (Date.now() > deadline) throw new Error(`no IA_READY ${n}; log:\n${log}`);
        await Promise.race([new Promise<void>((r) => (wake = r)), sleep(200)]);
      }
      return ready[n - 1];
    },
  };
}

test("a_restart_keeps_the_process_id_and_port", async () => {
  const port = await free_port();
  const s = serve_bin(["--port", String(port)]);
  assert.equal((await s.ready(1)).port, port);
  const token = readFileSync(join(s.data_dir, "auth_token"), "utf8").trim();
  const req = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }).then((r) => r.json() as any);
  const before = await req("/admin/server");
  const node = children(s.child.pid!);
  assert.deepEqual(await req("/admin/restart", { method: "POST", body: JSON.stringify({ rebuild: false }) }), { ok: true });
  assert.equal((await s.ready(2)).port, port, "the same arguments, so the same port");
  const after = await req("/admin/server");
  assert.notEqual(after.boot_id, before.boot_id);
  // The same process (bin/huntaway's), with a new node under it.
  assert.equal(s.child.exitCode, null);
  assert.notDeepEqual(children(s.child.pid!), node);
  assert.match(s.log(), /re-executing .*bin\/huntaway/);
  // And TERM to it still stops the server.
  s.child.kill("SIGTERM");
  assert.equal(await s.exited, 0);
  assert.deepEqual(children(s.child.pid!), []);
});

/**
 * HA-185: a body over a route's limit reset the connection, so a client heard "ECONNRESET" (a hub updating a host
 * reported it unreachable) rather than the 413 the Rust server answered.
 */
test("a_body_over_the_limit_is_answered_413_rather_than_reset", async () => {
  const port = await free_port();
  const s = serve_bin(["--port", String(port)]);
  await s.ready(1);
  const token = readFileSync(join(s.data_dir, "auth_token"), "utf8").trim();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const big = JSON.stringify({ text: "x".repeat(5 << 20) });
  const r = await fetch(`http://127.0.0.1:${port}/api/profiles`, { method: "POST", headers, body: big });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "length limit exceeded" });
  assert.equal(r.headers.get("connection"), "close");
  // HA-233: a client that writes the whole body before it reads (a slow writer, or fetch on a busy runner) got EPIPE
  // rather than the 413, as the server answered when the limit was passed and closed the connection under its writes.
  const slow = await write_then_read(port, "/api/profiles", token, Buffer.from(big));
  assert.equal(slow.write_error, null);
  assert.match(slow.answer, /^HTTP\/1\.1 413 /);
  assert.match(slow.answer, /\r\nconnection: close\r\n/i);
  assert.match(slow.answer, /\{"error":"length limit exceeded"\}$/);
  // And the server answers the next one.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});

/**
 * POST `body` over a socket that writes all of it, in pieces with pauses between, before reading anything back, and
 * then reads to the end: the error a write got (EPIPE, say), if one did, and the answer.
 */
async function write_then_read(port: number, path: string, token: string, body: Buffer) {
  const sock = connect(port, "127.0.0.1");
  await new Promise<void>((r, j) => sock.once("connect", r).once("error", j));
  sock.pause();
  const got: Buffer[] = [];
  sock.on("data", (c: Buffer) => got.push(c));
  const closed = new Promise<void>((r) => sock.once("close", () => r()));
  let write_error: string | null = null;
  sock.on("error", (e: any) => (write_error ??= e.code ?? String(e)));
  const write = (b: Buffer | string) => new Promise<void>((r) => sock.write(b, (e) => (e && (write_error ??= (e as any).code ?? String(e)), r())));
  await write(`POST ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`);
  for (let i = 0; i < body.length && write_error === null; i += 256 << 10) {
    await write(body.subarray(i, i + (256 << 10)));
    await sleep(20);
  }
  sock.resume();
  await closed;
  return { write_error, answer: Buffer.concat(got).toString("utf8") };
}

// ---------- a bug doesn't take the board down (HA-182) ----------

/** `bin/huntaway serve` on a free port with `IA_DEBUG_FAULTS` (see crash.ts), and how to call its API. */
async function faulty_server(env: Record<string, string> = {}) {
  const port = await free_port();
  const s = serve_bin(["--port", String(port)], { IA_DEBUG_FAULTS: "1", IA_CRASH_BACKOFF: "0", ...env });
  await s.ready(1);
  const token = readFileSync(join(s.data_dir, "auth_token"), "utf8").trim();
  const req = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json() as any);
  return { ...s, port, req };
}

/** Wait until `f()` is true, for up to 15 seconds. */
async function until(what: string, f: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!f()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("a_rejection_or_a_throw_in_the_background_is_logged_and_the_server_carries_on", async () => {
  const s = await faulty_server();
  const node = children(s.child.pid!);
  // A route's handler that leaves a promise to reject with nothing to handle it, a timer that throws once, and one
  // that throws every second.
  for (const kind of ["reject", "throw", "loop"]) assert.deepEqual(await s.req("/debug/fault", { kind }), { ok: true });
  await until("the errors in the log", () => /unhandled rejection.*a rejection nobody handles/.test(s.log()) && /uncaught exception.*a timer that throws/.test(s.log()));
  await until("the loop's second throw", () => s.log().includes("a background loop that throws"));
  await sleep(2500);
  // Still the same server, serving.
  assert.equal((await s.req("/health")).ok, true);
  assert.equal(s.child.exitCode, null);
  assert.deepEqual(children(s.child.pid!), node, "not started again");
  // With the stack, to find the bug by.
  assert.match(s.log(), /a timer that throws\n\s+at /);
  // The loop's error, thrown every second, is logged once a minute rather than every time.
  assert.equal(s.log().split("a background loop that throws").length - 1, 1, s.log());
  assert.deepEqual(await s.req("/debug/fault", { kind: "nope" }).then((r) => typeof r.error), "string");
});

test("the_fault_route_is_only_there_with_ia_debug_faults", async () => {
  const s = await faulty_server({ IA_DEBUG_FAULTS: "" });
  assert.match((await s.req("/debug/fault", { kind: "exit" })).error, /no such API route/);
  await sleep(200);
  assert.equal(s.child.exitCode, null);
});

/** The environment variables node was started with (`/proc/<pid>/environ`, which deleting them from `process.env` doesn't change). */
function environ(pid: number): Record<string, string> {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
}

/** HA-184 review: the desktop app's "Start without a backup" is for one start, not for a crash's, a restart's or an Update's. */
test("start_without_a_backup_is_only_for_the_first_server_bin_huntaway_starts", async () => {
  const s = await faulty_server({ IA_SKIP_DB_BACKUP_ONCE: "1" });
  const first = children(s.child.pid!);
  assert.equal(first.length, 1);
  assert.equal(environ(first[0]).IA_SKIP_DB_BACKUP_ONCE, "1");
  // Started again after a crash.
  assert.deepEqual(await s.req("/debug/fault", { kind: "exit" }), { ok: true });
  await s.ready(2);
  const second = children(s.child.pid!);
  assert.notDeepEqual(second, first);
  assert.equal(environ(second[0]).IA_SKIP_DB_BACKUP_ONCE, undefined);
  // A restart (as an Update's, which execs what the server names).
  assert.deepEqual(await s.req("/admin/restart", { rebuild: false }), { ok: true });
  await s.ready(3);
  const third = children(s.child.pid!);
  assert.notDeepEqual(third, second);
  assert.equal(environ(third[0]).IA_SKIP_DB_BACKUP_ONCE, undefined);
  s.child.kill("SIGTERM");
  assert.equal(await s.exited, 0);
});

/**
 * HA-213: with IA_NEW_DB_FILE, a server on a data dir an older build used copies its database into huntaway-2.db and
 * leaves the old file as it was; Copy again copies it again on a restart, and the restart doesn't pass --recopy-db or
 * IA_RECOPY_DB on (an older build would exit on the flag). Without IA_NEW_DB_FILE, nothing changes.
 */
test("the_new_database_file_is_copied_once_and_again_on_request", async () => {
  const dir = testing.temp_dir();
  const old = join(dir, "huntaway.db");
  const c = db.open(old);
  db.set_setting(c, "default_model", "from the older build");
  c.close();
  const old_bytes = () => readFileSync(old).toString("base64");

  // Off: the server uses huntaway.db, as it did.
  let port = await free_port();
  let s = serve_bin(["--port", String(port)], { IA_NEW_DB_FILE: "" }, dir);
  await s.ready(1);
  const token = readFileSync(join(dir, "auth_token"), "utf8").trim();
  const req = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json() as any);
  assert.equal((await req("/admin/server")).database, undefined);
  assert.ok(!existsSync(join(dir, "huntaway-2.db")));
  s.child.kill("SIGTERM");
  assert.equal(await s.exited, 0);
  const before = old_bytes();
  // The Rust server ran here last, which every later start backs the database up from (see backup.ts).
  const rust_ran = () => writeFileSync(join(dir, "server_version"), "0.3.0\n");
  const backups = () => backup.list(backup.backup_dir(dir)).map((b) => b.from);
  // The start above backed up huntaway.db, as no version had been recorded.
  assert.deepEqual(backups(), ["before"]);
  rust_ran();

  // On, with the flag and variable that ask for a copy again (which there's nothing to copy again for yet).
  port = await free_port();
  s = serve_bin(["--port", String(port), "--recopy-db"], { IA_NEW_DB_FILE: "1", IA_RECOPY_DB: "1" }, dir);
  await s.ready(1);
  const first = children(s.child.pid!);
  assert.equal(environ(first[0]).IA_RECOPY_DB, "1");
  let st = await req("/admin/server");
  assert.deepEqual([st.database.file, st.database.copied_from.source, st.database.older_changed], ["huntaway-2.db", "huntaway.db", null]);
  assert.equal((await req("/settings")).default_model, "from the older build");
  // The server has the copy open, and the older file is as it was, so there was nothing to back up.
  assert.equal(old_bytes(), before);
  assert.deepEqual(backups(), ["before"]);

  // An older build runs on the data dir for a while (here, beside this one).
  const o = new DatabaseSync(old);
  o.prepare("UPDATE settings SET value='changed by the older build' WHERE key='default_model'").run();
  o.close();
  st = await req("/admin/server");
  assert.equal(st.database.older_changed, "huntaway.db");
  // And the Rust server ran on it again since: the next start backs up huntaway-2.db, before it's replaced.
  rust_ran();
  assert.deepEqual(await req("/admin/database/recopy", {}), { ok: true });
  await s.ready(2);
  const second = children(s.child.pid!);
  assert.notDeepEqual(second, first);
  // The restart has neither the flag nor its variable, and still the new file.
  const env = environ(second[0]);
  assert.deepEqual([env.IA_RECOPY_DB ?? "", env.IA_NEW_DB_FILE], ["", "1"]);
  assert.ok(!readFileSync(`/proc/${second[0]}/cmdline`, "utf8").split("\0").includes("--recopy-db"));
  st = await req("/admin/server");
  assert.equal(st.database.older_changed, null);
  assert.equal((await req("/settings")).default_model, "changed by the older build");
  assert.ok(existsSync(join(dir, "huntaway-2.db.replaced")) && !existsSync(join(dir, "recopy-db")));
  assert.deepEqual(backups(), ["0.3.0", "before"]);
  // Of huntaway-2.db as it was before it was replaced.
  const copy = join(testing.temp_dir(), "backup.db");
  // The server gzips it once it's up, which replaces the file: read whichever is there.
  await until("the backup", () => {
    const [made] = backup.list(backup.backup_dir(dir));
    try {
      const data = readFileSync(join(backup.backup_dir(dir), made.f));
      writeFileSync(copy, made.gz ? gunzipSync(data) : data);
      return true;
    } catch {
      return false;
    }
  });
  const b = new DatabaseSync(copy, { readOnly: true });
  assert.equal(db.get_setting(b, "default_model"), "from the older build");
  b.close();
  s.child.kill("SIGTERM");
  assert.equal(await s.exited, 0);
});

test("a_server_that_crashes_once_up_is_started_again_as_the_same_process", async () => {
  const s = await faulty_server();
  const before = await s.req("/admin/server");
  const node = children(s.child.pid!);
  assert.deepEqual(await s.req("/debug/fault", { kind: "exit" }), { ok: true });
  assert.equal((await s.ready(2)).port, s.port);
  const after = await s.req("/admin/server");
  assert.notEqual(after.boot_id, before.boot_id);
  assert.equal(s.child.exitCode, null, "bin/huntaway's process carries on");
  assert.notDeepEqual(children(s.child.pid!), node);
  assert.match(s.log(), /the server stopped with 1; starting it again in 0s \(1 of 5\)/);
  // It can still restart (exec) and stop as before.
  assert.deepEqual(await s.req("/admin/restart", { rebuild: false }), { ok: true });
  assert.equal((await s.ready(3)).port, s.port);
  s.child.kill("SIGTERM");
  assert.equal(await s.exited, 0);
  assert.deepEqual(children(s.child.pid!), []);
});

test("a_server_that_fails_to_start_isn_t_started_again", async () => {
  // Its port is taken.
  const taken = createNetServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  servers.push(() => taken.close());
  const s = serve_bin(["--port", String((taken.address() as any).port)], { IA_CRASH_BACKOFF: "0" });
  assert.equal(await s.exited, 1);
  assert.match(s.log(), /binding/);
  assert.doesNotMatch(s.log(), /starting it again/);
});

/**
 * `bin/huntaway serve` with a stand-in for node that says it's up (as `supervisor_started` does), then runs `then`
 * (sh), and the number of times it was run once it has exited.
 */
async function crashing_node(then: string): Promise<{ code: number | null; runs: number; log: string }> {
  const dir = testing.temp_dir();
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\necho run >> "${dir}/runs"\n: > "$(dirname "$IA_RESTART_FILE")/started"\n${then}\n`, { mode: 0o755 });
  const s = serve_bin([], { IA_NODE: node, IA_CRASH_BACKOFF: "0" });
  const code = await s.exited;
  return { code, runs: readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length, log: s.log() };
}

test("bin_huntaway_gives_up_after_five_crashes_in_a_row", async () => {
  const r = await crashing_node("exit 3");
  assert.equal(r.runs, 6, r.log);
  assert.equal(r.code, 3, "the server's own code");
  assert.match(r.log, /\(5 of 5\)/);
  assert.match(r.log, /after starting it again 5 times in a row; giving up/);
});

test("bin_huntaway_starts_a_server_that_aborted_again_but_not_one_killed_or_stopped", async () => {
  // SIGABRT is how node ends when it runs out of memory. The shell's `wait` gives 134 (128 + 6) for that as it does
  // for `exit 134`, which the stand-in uses rather than aborting: a real SIGABRT dumped a core of sh for each of the
  // six runs, which systemd-coredump keeps and lists as a crash of bash (HA-231), even with `ulimit -c 0`.
  const aborted = await crashing_node("exit 134");
  assert.equal(aborted.runs, 6, aborted.log);
  for (const sig of ["KILL", "TERM"]) {
    const r = await crashing_node(`kill -${sig} $$`);
    assert.equal(r.runs, 1, `${sig}: ${r.log}`);
    assert.doesNotMatch(r.log, /starting it again/);
  }
  // Nor one that exited cleanly.
  assert.equal((await crashing_node("exit 0")).runs, 1);
});

test("a_release_this_host_updated_to_is_exec_d_at_startup", async () => {
  const out = join(testing.temp_dir(), "started");
  // A release in app/ that says how it was started, in place of serving.
  const data_dir = testing.temp_dir();
  const app = join(data_dir, "app");
  const dir = join(app, "9.9.9");
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "huntaway"), `#!/bin/sh\necho "$$ $IA_BUNDLED_SERVER $*" > ${out}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "ia-shim"), "");
  writeFileSync(join(dir, "ui/index.html"), "");
  writeFileSync(join(app, "state.json"), JSON.stringify({ current: "9.9.9", bad: [] }));
  const s = serve_bin(["--port", "0", "--release-updates", "o/r"], { IA_DESKTOP_VERSION: "", IA_BUNDLED_SERVER: "" }, data_dir);
  assert.equal(await s.exited, 0);
  const [pid, bundled, ...args] = readFileSync(out, "utf8").trim().split(" ");
  assert.equal(Number(pid), s.child.pid, "the release runs as bin/huntaway's process");
  assert.equal(bundled, realpathSync(BIN), "so that Roll back can come back to this server");
  assert.deepEqual(args, ["serve", "--host", "127.0.0.1", "--data-dir", data_dir, "--port", "0", "--release-updates", "o/r"]);
  assert.equal(JSON.parse(readFileSync(join(app, "state.json"), "utf8")).trying, "9.9.9");
});

/** The processes whose parent is `pid`. */
function children(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

test("a_rebuild_without_cargo_keeps_a_prebuilt_ia_shim", () => {
  const ts = testing.temp_dir();
  const cargo_dir = testing.temp_dir();
  writeFileSync(join(cargo_dir, "cargo"), "", { mode: 0o755 });
  const empty = testing.temp_dir();
  // No prebuilt shim: cargo builds it (and the step fails without cargo, saying so).
  assert.equal(builds_shim(empty, ts), true);
  mkdirSync(join(ts, "bin"));
  writeFileSync(join(ts, "bin/ia-shim"), "", { mode: 0o755 });
  assert.equal(builds_shim(empty, ts), false, "no cargo: the release's shim is kept");
  assert.equal(builds_shim(undefined, ts), false);
  assert.equal(builds_shim(`${empty}:${cargo_dir}`, ts), true, "with cargo, the checkout's own shim is built");
});
