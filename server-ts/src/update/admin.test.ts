// Port of the tests in server/src/update/admin.rs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sleep } from "../util.ts";
import * as testing from "../testing.ts";
import type { AppState } from "../state.ts";
import { check_deployed, pick_bundle_commit, status } from "./admin.ts";

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
