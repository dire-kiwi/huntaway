// The tests of server/src/review/merged.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import * as api from "../api.ts";
import * as worktree from "../git/worktree.ts";
import * as pr_watch from "../mcp/pr_watch.ts";
import * as testing from "../testing.ts";
import type { AppState } from "../state.ts";
import { check, query, set_fake, states } from "./merged.ts";

function sh(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: ["ignore", "ignore", "inherit"] });
}

type Query = [string | null, string, string[]];

/**
 * GitHub as a map of pull request URLs to states (missing ones aren't found), recording the queries made: (account,
 * host, URLs).
 */
function fake_github(): [Map<string, string>, Query[]] {
  const prs = new Map<string, string>();
  const queries: Query[] = [];
  set_fake((account, host, targets) => {
    queries.push([account, host, targets.map((t) => t.url())]);
    const data: Record<string, any> = {};
    targets.forEach((t, i) => {
      const st = prs.get(t.url());
      data[`pr${i}`] = st ? { pullRequest: { state: st } } : null;
    });
    return { data };
  });
  return [prs, queries];
}

/**
 * A project on a fresh repository, with a task in In review whose worktree has a commit and whose pull request is
 * `url`: the repository, project id and task.
 */
async function task_in_review(s: AppState, profile: string, url: string): Promise<[string, string, Task]> {
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  sh(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const p = await api.create_project_inner(s, profile, { name: "x", repo_path: repo, key: null, base_branch: "master", use_worktrees: null });
  const t = await new_task(s, p.id, url);
  return [repo, p.id, t];
}

async function new_task(s: AppState, project: string, url: string): Promise<Task> {
  const created = api.create_task_inner(s, project, { ...api.CreateTask_default(), title: "Do it" });
  const t = await worktree.setup(s, created.id);
  const wt = t.worktree_path!;
  writeFileSync(join(wt, "a"), "a");
  sh(wt, ["add", "a"]);
  sh(wt, ["commit", "-qm", "a"]);
  return s.update_task(t.id, [
    ["status", "in_review"],
    ["pr_url", url],
  ])!;
}

const task = (s: AppState, id: string) => db.get_task(s.db(), id)!;

function events(s: AppState, id: string): string[] {
  return db
    .list_messages(s.db(), id)
    .filter((m: any) => m.kind === "event")
    .map((m: any) => m.data.text ?? "");
}

test("a_task_whose_pull_request_is_merged_is_done_and_its_worktree_removed", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const url = "https://github.com/o/r/pull/7";
  const [repo, , t] = await task_in_review(s, profile.id, url);
  const [prs, queries] = fake_github();
  const failing = new Map<string, string>();

  prs.set(url, "OPEN");
  await check(s, failing);
  assert.equal(task(s, t.id).status, "in_review");
  assert.deepEqual(queries, [[null, "github.com", [url]]]);

  // Merged on GitHub (squashed, say): its branch isn't in master, so the worktree stays.
  prs.set(url, "MERGED");
  await check(s, failing);
  const done = task(s, t.id);
  assert.deepEqual([done.status, done.resolution, done.worktree_state], ["done", "done", "ready"]);
  const ev = events(s, t.id);
  assert.ok(ev.includes("PR #7 was merged on GitHub, so the task is done."), JSON.stringify(ev));
  assert.ok(
    ev.some((e) => e.startsWith("The worktree was kept: its work isn't merged into master")),
    JSON.stringify(ev),
  );

  // Done, it isn't read again; moved back by the user, it stays where they put it.
  await check(s, failing);
  assert.equal(queries.length, 2);
  s.update_task(t.id, [["status", "in_review"]]);
  await check(s, failing);
  assert.equal(queries.length, 3);
  assert.equal(task(s, t.id).status, "in_review");

  // Another task, whose branch was merged as it is: its worktree goes.
  const url2 = "https://github.com/o/r/pull/8";
  const t2 = await new_task(s, t.project_id!, url2);
  sh(repo, ["merge", "-q", "--no-ff", "-m", "merge", t2.branch!]);
  prs.set(url2, "MERGED");
  await check(s, failing);
  const done2 = task(s, t2.id);
  assert.deepEqual([done2.status, done2.worktree_state], ["done", "none"]);
  assert.ok(!existsSync(t2.worktree_path!));
  set_fake(null);
});

test("a_closed_pull_request_flags_the_task_once", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const url = "https://github.com/o/r/pull/7";
  const [, , t] = await task_in_review(s, profile.id, url);
  const [prs] = fake_github();
  const failing = new Map<string, string>();
  prs.set(url, "CLOSED");
  await check(s, failing);
  const flagged = task(s, t.id);
  assert.equal(flagged.status, "needs_attention");
  assert.equal(flagged.attention_reason, "PR #7 was closed on GitHub without being merged");
  // Moved back to In review, it isn't flagged again until it's reopened and closed.
  s.update_task(t.id, [["status", "in_review"]]);
  await check(s, failing);
  assert.equal(task(s, t.id).status, "in_review");
  prs.set(url, "OPEN");
  await check(s, failing);
  prs.set(url, "CLOSED");
  await check(s, failing);
  assert.equal(task(s, t.id).status, "needs_attention");
  assert.equal(events(s, t.id).filter((e) => e.includes("closed on GitHub")).length, 2);

  // Already waiting on the user, its reason stays the agent's.
  s.update_task(t.id, [["attention_reason", "Which colour?"]]);
  prs.set(url, "OPEN");
  await check(s, failing);
  prs.set(url, "CLOSED");
  await check(s, failing);
  const now = task(s, t.id);
  assert.deepEqual([now.status, now.attention_reason], ["needs_attention", "Which colour?"]);
  assert.equal(events(s, t.id).filter((e) => e.includes("closed on GitHub")).length, 3);
  set_fake(null);
});

test("leaves_tasks_that_are_busy_merging_opted_out_or_in_a_subproject", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const url = "https://github.com/o/r/pull/7";
  const [, pid, t] = await task_in_review(s, profile.id, url);
  const [prs, queries] = fake_github();
  const failing = new Map<string, string>();
  prs.set(url, "MERGED");

  // Running, merging, or in a project that turned it off: not read.
  for (const k of ["running", "merging"]) {
    s.update_task(t.id, [[k, true]]);
    await check(s, failing);
    s.update_task(t.id, [[k, false]]);
  }
  db.update_project(s.db(), pid, [["done_when_merged", false]]);
  await check(s, failing);
  assert.equal(queries.length, 0);
  db.update_project(s.db(), pid, [["done_when_merged", true]]);

  // A subproject's task is merged by its subproject; the subproject waits for its tasks.
  s.update_task(t.id, [["subproject", true]]);
  const child = api.create_task_inner(s, pid, { ...api.CreateTask_default(), title: "Part", parent_id: t.id });
  s.update_task(child.id, [
    ["status", "in_review"],
    ["pr_url", "https://github.com/o/r/pull/9"],
  ]);
  prs.set("https://github.com/o/r/pull/9", "MERGED");
  await check(s, failing);
  assert.equal(queries.length, 0);
  assert.equal(task(s, child.id).status, "in_review");
  s.update_task(child.id, [["status", "done"]]);
  await check(s, failing);
  assert.equal(task(s, t.id).status, "done");
  set_fake(null);
});

test("reads_each_accounts_pull_requests_together_as_that_account", async () => {
  const s = testing.state();
  const work = db.insert_profile(s.db(), "work", [], null);
  const home = db.insert_profile(s.db(), "home", [], null);
  db.run(s.db(), "UPDATE profiles SET github_account='alice' WHERE id=?1", work.id);
  const [, p1, a] = await task_in_review(s, work.id, "https://github.com/o/r/pull/1");
  const b = await new_task(s, p1, "https://github.com/o/r/pull/2");
  // The same pull request twice is read once.
  const b2 = await new_task(s, p1, "https://github.com/o/r/pull/2");
  const [, p2, c] = await task_in_review(s, home.id, "https://github.com/o/r/pull/3");
  // An account on another host doesn't read github.com's.
  db.run(s.db(), "UPDATE projects SET github_account='acme.ghe.com/bob' WHERE id=?1", p2);
  const d = await new_task(s, p2, "https://acme.ghe.com/o/r/pull/4");
  const [prs, queries] = fake_github();
  prs.set("https://github.com/o/r/pull/2", "MERGED");
  await check(s, new Map());
  const q = [...queries].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(q, [
    ["acme.ghe.com/bob", "acme.ghe.com", ["https://acme.ghe.com/o/r/pull/4"]],
    ["alice", "github.com", ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]],
  ]);
  const statuses = [a, b, b2, c, d].map((t) => task(s, t.id).status);
  assert.deepEqual(statuses, ["in_review", "done", "done", "in_review", "in_review"]);
  set_fake(null);
});

test("builds_one_query_and_reads_its_answer", () => {
  const t = (o: string, n: number) => new pr_watch.Target("github.com", o, "r", n);
  const [a, b] = [t("o", 1), t("x", 2)];
  const [q, vars, numbers] = query([a, b]);
  assert.ok(q.startsWith("query($o0: String!, $n0: String!, $p0: Int!, $o1: String!, $n1: String!, $p1: Int!) {"), q);
  assert.ok(q.includes("pr1: repository(owner: $o1, name: $n1) { pullRequest(number: $p1) { state headRefOid commits(last: 1)"), q);
  // Each pull request's checks are asked of its own number.
  assert.ok(q.includes("isRequired(pullRequestNumber: $p1)") && !q.includes("$number"), q);
  assert.deepEqual(vars, [
    ["o0", "o"],
    ["n0", "r"],
    ["o1", "x"],
    ["n1", "r"],
  ]);
  assert.deepEqual(numbers, [
    ["p0", 1],
    ["p1", 2],
  ]);
  // One it can't read is null, with an error, and the others are still read.
  const v = { data: { pr0: null, pr1: { pullRequest: { state: "MERGED" } } }, errors: [{ message: "Could not resolve" }] };
  const read = states(v, 2);
  assert.equal(read[0], null);
  assert.equal(read[1]?.state, "merged");
  assert.throws(() => states({ errors: [{ message: "Bad credentials" }] }, 2), { message: "Bad credentials" });
  // With its head commit's checks.
  const pr = pr_watch.response("me", "c3", [["test", "COMPLETED", "FAILURE", false]], []).data.repository;
  const one = states({ data: { pr0: pr } }, 1)[0]!;
  assert.deepEqual([one.state, one.head, one.checks.length], ["open", "c3", 1]);
});
