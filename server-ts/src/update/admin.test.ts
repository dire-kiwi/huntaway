// Port of the tests in server/src/update/admin.rs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
