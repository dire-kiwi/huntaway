// Port of server/src/api/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as db from "../db.ts";
import type { Project, Task } from "../db.ts";
import { ApiError, Reply, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import { path_str, sleep } from "../util.ts";
import { dispatch, makeReq, router } from "../api.ts";
import * as runs from "../agent/runs.ts";
import * as runner from "../agent/runner.ts";
import * as documents from "../agent/documents.ts";
import * as worktree from "../git/worktree.ts";
import * as questions from "../mcp/questions.ts";
import * as approval_rules from "../agent/approval_rules.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as review from "../review.ts";
import * as asana_tests from "../integrations/asana/tests.ts";
import * as github_tests from "../integrations/github/tests.ts";
import { create_group_task, create_scratch_task, create_scratch_task_inner, create_task, create_task_inner, type CreateTask } from "./new_task.ts";
import { check_agent_access, check_github_account, create_profile, update_profile } from "./profiles.ts";
import { clone_project, clone_project_inner, create_github_project_inner, create_project_inner, delete_project_inner, list_projects, remove_unused_dir, update_project_inner } from "./projects.ts";
import { delete_one, update_task, update_task_inner } from "./tasks.ts";
import { get_settings, internal_merge_gate, update_settings } from "./host.ts";
import { send_message, setup_worktree, start_setup_thread_inner, teardown_worktree } from "./thread.ts";
import { delete_profile } from "./claude_configs.ts";

// As the Rust tests run: with no ia-shim beside the test binary, this host can't run agents (but with TEST_CAN_RUN), and
// a run's launch fails rather than starting a real `claude`.
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

/** A request for calling a handler directly (Rust's tests call them with their extractors). */
function req(body: any = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): Req {
  return { method: "POST", path: "", params, query, query_string: "", headers: {}, body, raw: Buffer.alloc(0) };
}

/** Status and body (JSON, or the text if it isn't) of a request to the API. */
async function call(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  // The test state's token is empty.
  const headers: Record<string, string> = { authorization: "Bearer " };
  if (body !== undefined) headers["content-type"] = "application/json";
  const a = await dispatch(s, makeReq(method, path, headers, body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

/** The error a call ends in (it fails the test if it succeeds). */
async function err(f: (() => any) | Promise<any>): Promise<ApiError> {
  try {
    await (typeof f === "function" ? f() : f);
  } catch (e) {
    if (e instanceof ApiError) return e;
    if (e instanceof Reply) return new ApiError(e.status, String(e.body));
    return new ApiError(500, String(e));
  }
  assert.fail("expected an error");
}

async function fails(f: (() => any) | Promise<any>): Promise<boolean> {
  try {
    await (typeof f === "function" ? f() : f);
    return false;
  } catch {
    return true;
  }
}

function git(dir: string, args: string[]) {
  const r = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  assert.equal(r.status, 0, `git ${args.join(" ")}`);
}

const new_project = (profile_id: string): db.NewProject => ({
  id: "pr", profile_id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false,
});

const new_task = (profile_id: string, status = "todo"): db.NewTask => ({
  profile_id, project_id: null, kind: "task", title: "t", description: "", status, use_worktree: false, model: null, effort: null, claude_config_id: null,
});

/** With agents able to run (Rust's TEST_CAN_RUN), until `f` is done. */
async function can_run<T>(f: () => Promise<T>): Promise<T> {
  runs.TEST_CAN_RUN.set(true);
  try {
    return await f();
  } finally {
    runs.TEST_CAN_RUN.set(false);
  }
}

test("a_config_s_proxy_keys_are_write_only", async () => {
  const s = testing.state();
  const [status, cfg] = await call(s, "POST", "/api/claude-configs", { name: "pool", api_url: " http://10.0.0.7:8317/ ", api_key: "sk-1" });
  assert.equal(status, 200, JSON.stringify(cfg));
  assert.deepEqual([cfg.api_url, cfg.has_api_key, cfg.has_management_key], ["http://10.0.0.7:8317", true, false]);
  assert.ok(!("api_key" in cfg) && !("management_key" in cfg), JSON.stringify(cfg));
  const id = cfg.id;
  const path = `/api/claude-configs/${id}`;
  // Leaving a key out keeps it; setting another doesn't show it either.
  const [, cfg2] = await call(s, "PATCH", path, { management_key: "mk", show_usage: true });
  assert.deepEqual([cfg2.has_api_key, cfg2.has_management_key], [true, true]);
  const [, list] = await call(s, "GET", "/api/claude-configs");
  assert.ok(!JSON.stringify(list).includes("sk-1") && !JSON.stringify(list).includes('"mk"'), JSON.stringify(list));
  const stored = db.get_claude_config(s.db(), id)!;
  assert.deepEqual([stored.api_key, stored.management_key], ["sk-1", "mk"]);
  // Changing the proxy forgets usage read through the old one.
  s.usage.set(id, {});
  await call(s, "PATCH", path, { api_url: "https://proxy.example/" });
  assert.ok(!s.usage.has(id));
  for (const [body, error] of [
    [{ api_url: "ftp://x" }, "api_url must be an http:// or https:// URL"],
    [{ api_url: "nope" }, "api_url isn't a URL: relative URL without a base"],
    [{ api_key: 5 }, "api_key must be a string"],
    [{ agent: "codex" }, "a proxy is for Claude Code configs; clear api_url first"],
  ] as Array<[any, string]>) {
    assert.deepEqual(await call(s, "PATCH", path, body), [400, { error }], JSON.stringify(body));
  }
  // Blank clears it.
  const [, cfg3] = await call(s, "PATCH", path, { api_url: "", api_key: null, management_key: " " });
  assert.deepEqual([cfg3.api_url, cfg3.has_api_key, cfg3.has_management_key], [null, false, false]);
  const [status2] = await call(s, "PATCH", path, { agent: "codex" });
  assert.equal(status2, 200);
  assert.deepEqual(await call(s, "PATCH", path, { api_url: "http://x:1" }), [400, { error: "a proxy is for Claude Code configs; clear api_url first" }]);
  assert.deepEqual(await call(s, "POST", "/api/claude-configs", { name: "cx", agent: "codex", api_url: "http://x:1" }), [400, { error: "a proxy is for Claude Code configs" }]);
});

test("unknown_api_routes_get_a_json_404_not_the_ui", async () => {
  // (The UI fallback for paths outside /api is main.ts's, not the router's.)
  const s = testing.state();
  assert.deepEqual(await call(s, "GET", "/api/profiles"), [200, []]);
  for (const [method, path, missing] of [
    ["GET", "/api/projects", "GET /api/projects"],
    ["POST", "/api/tasks?x=1", "POST /api/tasks"],
    ["GET", "/api/tasks/t1/nope", "GET /api/tasks/t1/nope"],
    ["GET", "/api/", "GET /api/"],
    ["GET", "/api", "GET /api"],
    // Through the hub, to this host.
    ["GET", "/api/h/h/projects", "GET /api/projects"],
    ["DELETE", "/api/h/h/profiles/p/nope", "DELETE /api/profiles/p/nope"],
  ]) {
    assert.deepEqual(await call(s, method, path), [404, { error: `no such API route: ${missing}` }], `${method} ${path}`);
  }
  // A known route with the wrong method is still a 405.
  assert.deepEqual(await call(s, "DELETE", "/api/profiles"), [405, { error: "no such API route: DELETE /api/profiles" }]);
  assert.deepEqual(await call(s, "DELETE", "/api/h/h/profiles"), [405, { error: "no such API route: DELETE /api/profiles" }]);
});

test("threads_are_listed_whole_or_in_pages", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const t = db.insert_task(s.db(), new_task(profile.id));
  const add = (data: any) => db.insert_message(s.db(), t.id, "claude", data).id;
  const call_id = add({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }] } });
  const ids = [0, 1, 2, 3].map((i) => add({ type: "assistant", message: { content: [{ type: "text", text: String(i) }] } }));
  const ids_of = (v: any) => v.map((m: any) => m.id);
  // Without paging, a list (as hosts before API 56 answer), here and through the hub.
  for (const base of ["/api", "/api/h/h"]) {
    const [status, all] = await call(s, "GET", `${base}/tasks/${t.id}/messages`);
    assert.deepEqual([status, all.length], [200, 5]);
  }
  // The latest page, with the subagent started before it.
  let [, page] = await call(s, "GET", `/api/h/h/tasks/${t.id}/messages?limit=2`);
  assert.deepEqual([ids_of(page.messages), page.more], [ids.slice(2), true]);
  assert.deepEqual(ids_of(page.subagents), [call_id]);
  // Older ones, and newer ones than a message, without it.
  [, page] = await call(s, "GET", `/api/tasks/${t.id}/messages?before=${ids[2]}&limit=2`);
  assert.deepEqual([ids_of(page.messages), page.more, page.subagents], [[ids[0], ids[1]], true, []]);
  [, page] = await call(s, "GET", `/api/tasks/${t.id}/messages?after=${ids[1]}`);
  assert.deepEqual([ids_of(page.messages), page.more, page.subagents], [ids.slice(2), false, []]);
  assert.equal((await call(s, "GET", `/api/tasks/${t.id}/messages?limit=x`))[0], 400);
});

test("checks_github_accounts", () => {
  assert.equal(check_github_account(" octocat "), "octocat");
  assert.equal(check_github_account("ghe.example.com/me"), "ghe.example.com/me");
  assert.equal(check_github_account(""), null);
  assert.equal(check_github_account(null), null);
  assert.throws(() => check_github_account("--user=x"));
  assert.throws(() => check_github_account(3));
});

test("profiles_keep_their_github_account", async () => {
  const s = testing.state();
  const create = (b: any) => create_profile(s, req(b));
  const p = await create({ name: "work", github_account: " work-me " });
  assert.equal(p.github_account, "work-me");
  assert.equal(db.get_profile(s.db(), p.id)!.github_account, "work-me");
  const other = await create({ name: "personal" });
  assert.equal(other.github_account, null);
  assert.ok(await fails(create({ name: "bad", github_account: "--user=x" })));
  const update = (b: any) => update_profile(s, req(b, { id: p.id }));
  assert.equal((await update({ github_account: "ghe.example.com/me" })).github_account, "ghe.example.com/me");
  assert.equal((await update({ github_account: "" })).github_account, null);
});

test("profiles_choose_reviewers_and_a_summarizer_that_projects_can_override", async () => {
  const s = testing.state();
  const codex = db.insert_claude_config(s.db(), "Codex", "", "codex");
  const create = (b: any) => create_profile(s, req(b));
  const p = JSON.parse(JSON.stringify(await create({ name: "work", reviewers: [{ claude_config_id: codex.id, model: " " }], summarizer: { model: "haiku" } })));
  assert.deepEqual(p.reviewers, [{ claude_config_id: codex.id, model: null, effort: null }]);
  assert.deepEqual(p.summarizer, { claude_config_id: null, model: "haiku", effort: null });
  assert.deepEqual((await create({ name: "home" })).reviewers, []);
  assert.ok(await fails(create({ name: "bad", reviewers: [{ claude_config_id: "nope" }] })));
  assert.ok(await fails(create({ name: "bad", summarizer: "haiku" })));
  const id = p.id;
  db.insert_project(s.db(), { id: "pr", profile_id: id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
  const project = () => db.get_project(s.db(), "pr")!;
  const reviewers = () => db.reviewers_for(s.db(), project());
  const summarizer = () => db.summarizers_for(s.db(), project())[0];
  const codex_reviewer = { ...db.Reviewer_default(), claude_config_id: codex.id };
  const haiku = { ...db.Reviewer_default(), model: "haiku" };
  // A project with none of its own uses the profile's.
  assert.deepEqual(reviewers(), [codex_reviewer]);
  assert.deepEqual(summarizer(), haiku);
  // One with the defaults is a project's own choice, the task's config, over the profile's.
  await update_project_inner(s, "pr", { reviewers: [{}], summarizer: { claude_config_id: "", model: null } });
  assert.deepEqual(reviewers(), [db.Reviewer_default()]);
  assert.deepEqual(summarizer(), db.Reviewer_default());
  // Back to the profile's.
  await update_project_inner(s, "pr", { reviewers: [], summarizer: null });
  assert.deepEqual([project().reviewers, project().summarizer], [[], null]);
  assert.deepEqual(reviewers(), [codex_reviewer]);
  // A profile's with just the defaults is none, which is the same.
  const update = (b: any) => update_profile(s, req(b, { id }));
  const p2 = await update({ reviewers: [{ model: "" }], summarizer: {} });
  assert.deepEqual([p2.reviewers, p2.summarizer], [[], null]);
  assert.deepEqual(reviewers(), [db.Reviewer_default()]);
  assert.deepEqual(summarizer(), db.Reviewer_default());
  assert.deepEqual((await update({ summarizer: { effort: "low" } })).reviewers, [], "kept when other fields change");
  const seven = Array.from({ length: review.MAX_REVIEWERS + 1 }, () => ({}));
  assert.ok(await fails(update({ reviewers: seven })));
});

test("profiles_and_projects_can_have_several_summarizers_with_skills", async () => {
  const s = testing.state();
  const create = (b: any) => create_profile(s, req(b));
  const listed = [
    { name: " Baseline ", model: "haiku" },
    { name: "Skilled", skills: [" /tldr ", "changelog", "tldr", ""], prompt: "  Be brief.  " },
  ];
  const p = JSON.parse(JSON.stringify(await create({ name: "work", summarizers: listed })));
  const wanted = [
    { claude_config_id: null, model: "haiku", effort: null, name: "Baseline" },
    { claude_config_id: null, model: null, effort: null, name: "Skilled", skills: ["tldr", "changelog"], prompt: "Be brief." },
  ];
  assert.deepEqual(p.summarizers, wanted);
  // Older clients read the first.
  assert.deepEqual(p.summarizer, wanted[0]);
  const id = p.id;
  db.insert_project(s.db(), { id: "pr", profile_id: id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
  const summarizers = () => db.summarizers_for(s.db(), db.get_project(s.db(), "pr")!);
  assert.equal(summarizers().length, 2);
  // A project's own, over the profile's, and back with an empty list.
  let project = await update_project_inner(s, "pr", { summarizers: [{ skills: ["x"] }] });
  assert.deepEqual([project.summarizers.length, project.summarizer?.skills], [1, ["x"]]);
  assert.deepEqual(summarizers()[0].skills, ["x"]);
  project = await update_project_inner(s, "pr", { summarizers: [] });
  assert.deepEqual([project.summarizers.length, project.summarizer == null], [0, true]);
  assert.equal(summarizers().length, 2);
  // A client from before there could be several sends the one, and `summarizers` wins when both are given.
  await update_project_inner(s, "pr", { summarizer: { model: "sonnet" } });
  assert.deepEqual(summarizers(), [{ ...db.Reviewer_default(), model: "sonnet" }]);
  await update_project_inner(s, "pr", { summarizer: { model: "sonnet" }, summarizers: [{}, {}] });
  assert.equal(summarizers().length, 2);
  await update_project_inner(s, "pr", { summarizer: null });
  assert.equal(summarizers().length, 2, "the profile's again");
  // A client from before API 103 sends the first as `summarizer` with every save: the rest stay.
  await update_project_inner(s, "pr", { summarizers: [{ name: "A", model: "haiku" }, { name: "B" }, { name: "C" }] });
  await update_project_inner(s, "pr", { summarizer: { claude_config_id: null, model: "haiku", effort: null } });
  assert.deepEqual(summarizers().map((r) => r.name), ["A", "B", "C"]);
  // Changed, it replaces just the first.
  await update_project_inner(s, "pr", { summarizer: { model: "sonnet" } });
  const after = summarizers();
  assert.deepEqual([after.length, after[0].model, after[1].name], [3, "sonnet", "B"]);
  await update_project_inner(s, "pr", { summarizers: [] });
  const update_profile_body = (b: any) => update_profile(s, req(b, { id }));
  const first = { claude_config_id: null, model: "haiku", effort: null };
  // The same for a profile: a rename from an old UI that sends `summarizer` too keeps its two.
  let p2 = await update_profile_body({ name: "renamed", summarizer: first });
  assert.deepEqual([p2.name, p2.summarizers.length], ["renamed", 2]);
  p2 = await update_profile_body({ summarizer: null });
  assert.deepEqual(p2.summarizers, []);
  // Bad ones.
  const update = (b: any) => update_project_inner(s, "pr", b);
  assert.ok(await fails(update({ summarizers: [{ skills: ["two words"] }] })));
  assert.ok(await fails(update({ summarizers: [{ skills: "tldr" }] })));
  assert.ok(await fails(update({ summarizers: Array.from({ length: review.MAX_REVIEWERS + 1 }, () => ({})) })));
  assert.ok(await fails(update({ summarizers: [{ claude_config_id: "nope" }] })));
  // Reviewers keep their prompt and skills, tidied (HA-142), but not the name only summarizers have.
  project = await update({ reviewers: [{ name: "x", skills: [" /audit ", "audit", "b", ""], prompt: "  Only security.\n" }] });
  assert.deepEqual(project.reviewers, [{ ...db.Reviewer_default(), skills: ["audit", "b"], prompt: "Only security." }]);
  assert.ok(await fails(update({ reviewers: [{ prompt: "x".repeat(20_001) }] })));
  assert.ok(await fails(update({ reviewers: [{ skills: ["two words"] }] })));
  const many = Array.from({ length: 21 }, (_, i) => `s${i}`);
  assert.ok(await fails(update({ reviewers: [{ skills: many }] })));
});

test("a_deleted_reviewer_config_doesnt_stop_saving_other_settings", async () => {
  const s = testing.state();
  const gone = db.insert_claude_config(s.db(), "Gone", "", "claude");
  const other = db.insert_claude_config(s.db(), "Other", "", "claude");
  const spec = { claude_config_id: gone.id, model: "haiku", effort: null };
  const p = await create_profile(s, req({ name: "work", reviewers: [spec], summarizer: spec }));
  const id = p.id;
  db.insert_project(s.db(), { id: "pr", profile_id: id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: null, use_worktrees: false });
  await update_project_inner(s, "pr", { reviewers: [spec], summarizer: spec });
  db.delete_claude_config(s.db(), gone.id);
  // The forms send them unchanged with every save, as they were saved.
  const update = (b: any) => update_profile(s, req(b, { id }));
  const p2 = JSON.parse(JSON.stringify(await update({ name: "job", reviewers: [spec], summarizer: spec })));
  assert.deepEqual([p2.name, p2.reviewers, p2.summarizer], ["job", [spec], spec]);
  let project = await update_project_inner(s, "pr", { name: "y", reviewers: [spec, { claude_config_id: other.id }], summarizer: spec });
  assert.deepEqual([project.name, project.reviewers.length], ["y", 2]);
  // A project taking its own, starting from the profile's, keeps the profile's too.
  await update_project_inner(s, "pr", { reviewers: [], summarizer: null });
  const edited = { claude_config_id: gone.id, model: "sonnet", effort: "low" };
  project = await update_project_inner(s, "pr", { reviewers: [edited] });
  assert.equal(project.reviewers[0].model, "sonnet");
  project = await update_project_inner(s, "pr", { summarizer: edited });
  assert.equal(project.summarizer!.claude_config_id, gone.id);
  // A config that was never saved there still has to exist.
  const unknown = { claude_config_id: "nope" };
  assert.ok(await fails(update({ summarizer: unknown })));
  assert.ok(await fails(update({ reviewers: [unknown] })));
  assert.ok(await fails(update_project_inner(s, "pr", { summarizer: unknown })));
});

test("profiles_keep_their_clone_folder", async () => {
  const s = testing.state();
  const create = (b: any) => create_profile(s, req(b));
  let p = await create({ name: "work", clone_dir: " ~/src/work " });
  assert.equal(p.clone_dir, "~/src/work");
  p = await create({ name: "personal" });
  assert.deepEqual([p.clone_dir, p.asana_enabled], [null, true]);
  assert.equal((await create({ name: "home", asana_enabled: false })).asana_enabled, false);
  for (const bad of ["src", "~work", 3]) assert.ok(await fails(create({ name: "bad", clone_dir: bad })), JSON.stringify(bad));
  const id = p.id;
  const update = (b: any) => update_profile(s, req(b, { id }));
  assert.equal((await update({ clone_dir: "/srv/repos" })).clone_dir, "/srv/repos");
  assert.ok(await fails(update({ clone_dir: "repos" })));
  assert.equal((await update({ name: "job" })).clone_dir, "/srv/repos", "kept when other fields change");
  p = await update({ clone_dir: " " });
  assert.equal(p.clone_dir, null);
  assert.equal(db.clone_dir_or_default(db.get_profile(s.db(), id)!), "~/job");
});

test("profiles_connect_to_asana_and_search_it", async () => {
  await asana_tests.fake();
  const s = testing.state();
  const p = db.insert_profile(s.db(), "work", [], null);
  const update = (b: any) => update_profile(s, req(b, { id: p.id }));
  const search = `/api/profiles/${p.id}/asana/tasks?q=fix`;
  let [status, body] = await call(s, "GET", search);
  assert.deepEqual([status, body.error], [409, "the work profile isn't connected to Asana"]);

  // A token Asana turns down isn't kept.
  const e = await err(update({ asana_token: "nope" }));
  assert.equal(e.status, 400);
  assert.ok(e.message.includes("didn't accept the token"), e.message);
  assert.equal(db.get_profile(s.db(), p.id)!.asana_token, null);

  // One it takes is, with who it's for; the board sees only that.
  const v = await update({ asana_token: ` ${asana_tests.TOKEN} ` });
  assert.equal(v.asana_user, "Ivy (ivy@example.com)");
  assert.ok(!JSON.stringify(v).includes("asana_token"), JSON.stringify(v));
  assert.equal(db.get_profile(s.db(), p.id)!.asana_token, asana_tests.TOKEN);
  const [, list] = await call(s, "GET", "/api/profiles");
  assert.ok(!JSON.stringify(list).includes(asana_tests.TOKEN));
  assert.equal((await update({ name: "job" })).asana_user, "Ivy (ivy@example.com)", "kept when other fields change");

  let found;
  [status, found] = await call(s, "GET", search);
  assert.equal(status, 200);
  assert.deepEqual(found.map((t: any) => t.name), ["Fix signup", "Fix login"]);
  assert.equal(found[0].url, "https://app.asana.com/0/1/1002");
  // Through the hub too, and a URL for a task the token can't see finds nothing.
  assert.deepEqual(await call(s, "GET", `/api/h/h/profiles/${p.id}/asana/tasks?q=https%3A%2F%2Fapp.asana.com%2F0%2F1%2F7777`), [200, []]);

  // Turned off, it keeps its token but finds nothing, until it's turned on again.
  assert.ok(await fails(update({ asana_enabled: "no" })));
  const off = await update({ asana_enabled: false });
  assert.deepEqual([off.asana_enabled, off.asana_user], [false, "Ivy (ivy@example.com)"]);
  [status, body] = await call(s, "GET", search);
  assert.deepEqual([status, body.error], [409, "Asana is turned off for the job profile (Settings → Profiles)"]);
  assert.equal((await update({ name: "work" })).asana_enabled, false, "kept when other fields change");
  assert.equal((await update({ asana_enabled: true })).asana_enabled, true);
  assert.equal((await call(s, "GET", search))[0], 200);

  const cleared = await update({ asana_token: null });
  assert.equal(cleared.asana_user, null);
  assert.equal(db.get_profile(s.db(), p.id)!.asana_token, null);
  assert.equal((await call(s, "GET", search))[0], 409);
});

test("updating_a_task_from_the_api_puts_it_in_now", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = db.insert_project(s.db(), new_project(p.id));
  const t = create_task_inner(s, project.id, { title: "Fix it" });
  assert.equal(t.now_at, null);
  const patch = async (v: any): Promise<[any, any]> => {
    const shown = await update_task(s, req(v, { id: t.id }));
    return [shown.now_at ?? null, db.get_task(s.db(), shown.id)!.now_at ?? null];
  };
  // Asking for Later in the same request keeps it there; any other update is a reason for Now.
  assert.deepEqual(await patch({ description: "More", now: false }), [null, null]);
  const [shown, kept] = await patch({ description: "Even more" });
  assert.ok(kept != null && shown === kept);
  await patch({ now: false });
  // The board renumbers a column's positions when a card is dropped: that touches no other card.
  assert.deepEqual(await patch({ position: 7.5 }), [null, null]);
  // The dropped card's own request moves it too.
  assert.ok((await patch({ status: "in_progress", position: 8.5 }))[1] != null);
});

test("a_tasks_fields_are_checked_for_type_before_theyre_stored", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = db.insert_project(s.db(), new_project(p.id));
  const t = create_task_inner(s, project.id, { title: "Fix it", description: "How" });
  const set = (v: any) => update_task_inner(s, t.id, v);
  for (const bad of [
    { title: null },
    { title: "" },
    { title: "  " },
    { title: { a: 1 } },
    { title: 7 },
    { description: 42 },
    { description: ["x"] },
    // Stored as text in a REAL or INTEGER column, these would make the row unreadable.
    { position: "top" },
    { position: null },
    { use_worktree: "yes" },
    { use_worktree: 1 },
    { model: 3 },
    { base_branch: ["main"] },
  ]) {
    const e = await err(set(bad));
    assert.equal(e.status, 400, `${JSON.stringify(bad)}: ${e.message}`);
  }
  // Nothing stuck: the task reads back as it was, in every list.
  const back = db.get_task(s.db(), t.id)!;
  assert.deepEqual([back.title, back.description, back.use_worktree], ["Fix it", "How", false]);
  assert.equal(db.list_tasks_for_project(s.db(), project.id, "task").length, 1);
  assert.equal((await set({ position: 2.5, use_worktree: true, model: "haiku", base_branch: null })).position, 2.5);
  const fixed = await set({ title: " Fixed ", description: null });
  assert.deepEqual([fixed.title, fixed.description], ["Fixed", ""]);
});

test("a_setting_of_the_wrong_type_is_refused_rather_than_cleared", async () => {
  const s = testing.state();
  const set = (v: any) => update_settings(s, req(v));
  let out = await set({ default_model: "haiku", default_effort: "high" });
  assert.deepEqual([out.default_model, out.default_effort], ["haiku", "high"]);
  for (const bad of [{ default_model: 123 }, { default_permission_mode: 5 }, { default_effort: ["high"] }, { scratch_host: true }]) {
    const e = await err(set(bad));
    assert.equal(e.status, 400, `${JSON.stringify(bad)}: ${e.message}`);
  }
  out = await set({});
  assert.deepEqual([out.default_model, out.default_effort], ["haiku", "high"], "nothing cleared");
  out = await set({ default_model: null, default_effort: "" });
  assert.ok(out.default_model === null && out.default_effort === null, `null and blank clear: ${JSON.stringify(out)}`);
});

/** A task in a project, and a second one waiting for it, to start without an agent running. */
function waiting_for_another(s: AppState): [Project, Task] {
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = db.insert_project(s.db(), new_project(p.id));
  const first = create_task_inner(s, project.id, { title: "First" });
  return [project, first];
}

test("the_users_prompts_put_a_task_in_now_but_agents_and_starts_do_not", async () => {
  await can_run(async () => {
    const s = testing.state();
    const [project, first] = waiting_for_another(s);
    const make = (v: any): Promise<Task> => create_task(s, req({ depends_on: [first.id], title: "T", ...v }, { id: project.id }));
    // Made from the board with a prompt, it's in now; started without one (or by an agent: create_task_inner), it isn't.
    assert.ok((await make({ start: "Do it" })).now_at != null);
    // The new task dialog sends `start: true` with the description they typed (its title is made from it).
    const dialog = { description: "Implement the feature", start: true, status: "in_progress" };
    assert.ok((await make(dialog)).now_at != null);
    assert.equal((await make({ start: true })).now_at ?? null, null);
    assert.equal((await make({ description: "  ", start: true })).now_at ?? null, null);
    assert.equal((await make({ description: "Implement the feature" })).now_at ?? null, null);
    // The same for the dialog's scratch and group tasks, which share it.
    const profile = project.profile_id;
    const body = (extra: any) => ({ title: "T", ...extra });
    let scratch = await create_scratch_task(s, req(body(dialog), { id: profile }));
    assert.ok(scratch.now_at != null);
    scratch = await create_scratch_task(s, req(body({ start: true }), { id: profile }));
    assert.equal(scratch.now_at ?? null, null);
    await update_project_inner(s, project.id, { group_name: "Shop" });
    const group = (extra: any) => ({ group: "Shop", ...body(extra) });
    let g = await create_group_task(s, req(group(dialog), { id: profile }));
    assert.ok(g.now_at != null);
    g = await create_group_task(s, req(group({ start: true }), { id: profile }));
    assert.equal(g.now_at ?? null, null);
    assert.equal((await make({})).now_at ?? null, null);
    const by_agent = create_task_inner(s, project.id, { title: "T", depends_on: [first.id], start: "Do it" });
    assert.equal(by_agent.now_at ?? null, null);

    // A prompt sent on its thread, not an empty one that starts its agent.
    const t = await make({ start: true });
    await send_message(s, req({ text: "  " }, { id: t.id }));
    assert.equal(db.get_task(s.db(), t.id)!.now_at ?? null, null);
    await send_message(s, req({ text: "and this" }, { id: t.id }));
    assert.ok(db.get_task(s.db(), t.id)!.now_at != null);
  });
});

test("how_long_a_task_stays_in_now_is_a_setting", async () => {
  const s = testing.state();
  const set = (v: any) => update_settings(s, req(v));
  assert.equal((await get_settings(s)).now_expiry_hours, 24);
  assert.equal((await set({ now_expiry_hours: 6 })).now_expiry_hours, 6);
  // 0 keeps tasks there for good, and null goes back to a day.
  assert.equal((await set({ now_expiry_hours: 0 })).now_expiry_hours, 0);
  assert.equal((await set({})).now_expiry_hours, 0);
  assert.equal((await set({ now_expiry_hours: null })).now_expiry_hours, 24);
  for (const bad of [{ now_expiry_hours: -1 }, { now_expiry_hours: 1.5 }, { now_expiry_hours: "soon" }, { now_expiry_hours: 999999 }]) {
    const e = await err(set(bad));
    assert.equal(e.status, 400, `${JSON.stringify(bad)}: ${e.message}`);
  }
});

test("keeping_threads_as_items_is_a_setting_off_by_default", async () => {
  const s = testing.state();
  const set = (v: any) => update_settings(s, req(v));
  assert.equal((await get_settings(s)).thread_items, false);
  assert.equal((await set({ thread_items: true })).thread_items, true);
  assert.equal(db.get_setting(s.db(), "thread_items"), "true");
  assert.equal((await set({})).thread_items, true);
  assert.equal((await set({ thread_items: false })).thread_items, false);
  assert.equal(db.get_setting(s.db(), "thread_items"), null);
  assert.equal((await set({ thread_items: true })).thread_items, true);
  assert.equal((await set({ thread_items: null })).thread_items, false);
  const e = await err(set({ thread_items: "yes" }));
  assert.equal(e.status, 400);
});

test("tasks_link_to_asana_tasks", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = db.insert_project(s.db(), new_project(p.id));
  const link = (id: string, title: string) => ({ provider: "asana", id, url: `https://app.asana.com/0/1/${id}`, title });

  const t = create_task_inner(s, project.id, { title: "Fix it", external_links: [link("1002", " Fix signup ")] });
  assert.deepEqual(t.external_links, [{ provider: "asana", id: "1002", url: "https://app.asana.com/0/1/1002", title: "Fix signup" }]);
  assert.throws(() => create_task_inner(s, project.id, { title: "x", external_links: [{ provider: "jira", id: "1", url: "https://x" }] }));
  const scratch = create_scratch_task_inner(s, p.id, { title: "Ask", external_links: [link("1", "One")] });
  assert.equal(scratch.external_links.length, 1);
  assert.equal(create_task_inner(s, project.id, { title: "Plain" }).external_links.length, 0);

  // Each task once, and only with an id and a web link.
  const set = (v: any) => update_task_inner(s, t.id, { external_links: v });
  const t2 = await set([link("1002", "Fix signup"), link("2001", "Write docs"), link("1002", "again")]);
  assert.deepEqual(t2.external_links.map((l: any) => l.id), ["1002", "2001"]);
  for (const bad of ["x", [{ provider: "asana", id: "", url: "https://x" }], [{ provider: "asana", id: "1", url: "javascript:x" }]]) {
    assert.ok(await fails(set(bad)), JSON.stringify(bad));
  }
  assert.ok(await fails(set(Array.from({ length: db.MAX_LINKS + 1 }, (_, i) => link(String(i), "t")))));
  assert.equal((await set(null)).external_links.length, 0);
});

test("cloning_adds_a_clone_thats_there_already_and_checks_what_it_can_first", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = testing.temp_dir();
  const clone = (b: any) => clone_project(s, req(b, { id: profile.id }));
  const path = (name: string) => path_str(join(dir, name));
  const message = async (p: Promise<any>) => (await err(p)).message;

  assert.ok((await message(clone({ repo: "nope" }))).includes("OWNER/REPO"));
  assert.ok((await message(clone({ repo: "o/r", repo_path: "rel/r" }))).includes("absolute"));
  // A folder that's in the way isn't cloned into, nor taken for a clone.
  mkdirSync(join(dir, "full"), { recursive: true });
  writeFileSync(join(dir, "full/notes.txt"), "mine");
  assert.ok((await message(clone({ repo: "o/r", repo_path: path("full") }))).includes("already exists"));
  assert.equal(readFileSync(join(dir, "full/notes.txt"), "utf8"), "mine");

  // A clone of the repository there already is added as it is, named after the folder.
  const r = join(dir, "r");
  mkdirSync(r, { recursive: true });
  await worktree.git(r, ["init", "-q"]);
  await worktree.git(r, ["remote", "add", "origin", "git@github.com:o/r.git"]);
  const p = await clone({ repo: "o/r", repo_path: path("r"), key: "rr" });
  assert.deepEqual([p.name, p.key, p.repo_path], ["r", "RR", path("r")]);
  // But only once.
  const again = await message(clone({ repo: "o/r", repo_path: `${path("r")}/` }));
  assert.ok(again.includes('already the project "r"'), again);
  // Its key is checked before cloning anything.
  const taken = await message(clone({ repo: "o/other", repo_path: path("other"), key: "RR" }));
  assert.ok(taken.includes("already has the key RR"), taken);
  assert.ok((await message(clone({ repo: "o/other", repo_path: path("other"), key: "S" }))).includes("scratch tasks"));
  assert.ok(!existsSync(join(dir, "other")));
  assert.ok((await message(clone_project(s, req({ repo: "o/r" }, { id: "nope" })))).includes("profile"));
});

test("creates_a_github_repository_and_adds_the_folder_as_a_project", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const fake = github_tests.fake_gh_create();
  const gh = path_str(join(fake, "gh"));
  const create = (b: any) => create_github_project_inner(s, profile.id, b, gh);
  const path = (n: string) => path_str(join(fake, "projects", n));
  const message = async (p: Promise<any>) => (await err(p)).message;
  const log = () => readFileSync(join(fake, "create.log"), "utf8");

  let p = await create({ repo_path: path("one"), owner: "o", visibility: "private", key: "ab" });
  assert.deepEqual([p.name, p.key, p.github.full_name], ["one", "AB", "o/one"]);
  assert.ok(log().includes("repo create o/one --private"));
  assert.ok(existsSync(join(fake, "projects/one/.git")));
  // The repository can be named differently from the folder, and be public.
  p = await create({ repo_path: path("two"), repo_name: "other", owner: "o", visibility: "public", name: "Two" });
  assert.deepEqual([p.name, p.github.full_name], ["Two", "o/other"]);
  assert.ok(log().includes("repo create o/other --public"));

  // Checked before anything is made: the visibility, the name, the key, and a project there already.
  const before = log();
  assert.ok((await message(create({ repo_path: path("x"), visibility: "secret" }))).includes("public or private"));
  assert.ok((await message(create({ repo_path: path("x"), visibility: "public", repo_name: "a b" }))).includes("repository's name"));
  assert.ok((await message(create({ repo_path: "x", visibility: "public" }))).includes("absolute"));
  assert.ok((await message(create({ repo_path: path("x"), visibility: "public", key: "AB" }))).includes("already has the key AB"));
  assert.ok((await message(create({ repo_path: path("one"), visibility: "public" }))).includes('already the project "one"'));
  assert.equal(log(), before);
  assert.ok(!existsSync(join(fake, "projects/x")));
  // A repository GitHub refuses adds no project and leaves nothing behind.
  const e = await message(create({ repo_path: path("fails"), visibility: "public" }));
  assert.ok(e.includes("Name already exists"), e);
  assert.ok(!existsSync(join(fake, "projects/fails")));
  assert.equal(db.list_projects(s.db(), profile.id).length, 2);
  assert.ok(await fails(create_github_project_inner(s, "nope", { repo_path: path("y"), visibility: "public" }, gh)));
  rmSync(fake, { recursive: true, force: true });
});

test("a_folder_being_cloned_into_waits_for_that_clone_and_isnt_added_twice", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const github = github_tests.fake_github();
  const gh = path_str(join(github, "gh"));
  // Also as a path through a symlink to a folder above it, below which there's a folder that isn't there until the
  // clone makes it, and with the symlink after a folder that isn't there and `..`.
  mkdirSync(join(github, "real"), { recursive: true });
  symlinkSync(join(github, "real"), join(github, "alias"));
  const paths = [["clones/slow", "clones/slow"], ["alias/new/slow", "real/new/slow"], ["missing/../alias/other/slow", "real/other/slow"]];
  for (const [d, f] of paths) {
    // (Joined as Rust's Path::join does, without resolving the `..`.)
    const destGiven = `${github}/${d}`;
    const clone = () => clone_project_inner(s, profile.id, { repo: "o/slow", repo_path: destGiven }, gh);
    // The second comes while the first is cloning, with the folder a clone of it by then.
    const [first, second] = await Promise.allSettled([clone(), sleep(400).then(clone)]);
    const folder = path_str(join(github, f));
    const projects = db.list_projects(s.db(), profile.id).filter((p) => p.repo_path === folder);
    assert.equal(projects.length, 1, destGiven);
    assert.equal(first.status, "fulfilled", destGiven);
    assert.equal((first as PromiseFulfilledResult<Project>).value.id, projects[0].id);
    assert.equal(second.status, "rejected");
    const e = (second as PromiseRejectedResult).reason as ApiError;
    assert.equal(e.status, 409, `${destGiven}: ${e.message}`);
    assert.ok(e.message.includes('already the project "slow"'), e.message);
  }
  rmSync(github, { recursive: true, force: true });
});

test("tidies_agent_access", () => {
  assert.deepEqual(check_agent_access("work", [" personal ", "work", "", "lab", "personal"]), ["lab", "personal"]);
  assert.deepEqual(check_agent_access("work", ["lab", "*"]), ["*"]);
  assert.throws(() => check_agent_access("work", "personal"));
});

test("worktrees_start_once_the_folder_is_a_git_repo", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.ok(p.use_worktrees && !p.is_git);
  const task = (title: string): CreateTask => ({ title });
  assert.ok(!create_task_inner(s, p.id, task("before")).use_worktree);
  execFileSync("git", ["init", "-q", dir]);
  assert.ok(create_task_inner(s, p.id, task("after")).use_worktree);
});

test("projects_turn_their_tasks_pull_requests_on_and_off", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  let p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.ok(p.pull_requests && p.subproject_pull_requests);
  const id = p.id;
  const set = (b: any) => update_project_inner(s, id, b);
  p = await set({ subproject_pull_requests: false });
  assert.ok(p.pull_requests && !p.subproject_pull_requests);
  p = await set({ pull_requests: false, subproject_pull_requests: true });
  assert.ok(!p.pull_requests && p.subproject_pull_requests);
  for (const bad of ["no", null, 0]) assert.ok(await fails(set({ pull_requests: bad })));
});

test("projects_watch_pull_requests_in_review_once_asked_to", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.equal(p.watch_pull_requests, "off");
  const set = (v: any) => update_project_inner(s, p.id, { watch_pull_requests: v });
  for (const mode of ["failures", "all", "off"]) assert.equal((await set(mode)).watch_pull_requests, mode);
  for (const bad of ["everything", null, true]) assert.ok(await fails(set(bad)));
});

/** A git repository with a commit on master, and a project on it: (folder, project). */
async function git_project(s: AppState): Promise<[string, Project]> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = testing.temp_dir();
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  return [dir, await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir), key: "X" })];
}

// HA-42: a relative worktrees_root put worktrees in the main checkout, and base branches weren't checked.
test("worktree_settings_are_checked", async () => {
  const s = testing.state();
  const [dir, p] = await git_project(s);
  const set = (v: any) => update_project_inner(s, p.id, v);
  for (const bad of [
    { worktrees_root: "worktrees" },
    { worktrees_root: "./w" },
    { worktrees_root: path_str(dir) },
    { worktrees_root: `${path_str(dir)}/` },
    { worktrees_root: `${path_str(dir)}/../${basename(dir)}` },
    { base_branch: "a..b" },
    { base_branch: "-x" },
    { base_branch: "@{-1}" },
    { base_branch: "with space" },
    { base_branch: "main.lock" },
    { base_branch: 3 },
  ]) {
    const e = await err(set(bad));
    assert.equal(e.status, 400, `${JSON.stringify(bad)}: ${e.message}`);
  }
  let p2 = db.get_project(s.db(), p.id)!;
  assert.deepEqual([p2.worktrees_root, p2.base_branch], [p.worktrees_root, "master"]);
  const inside = join(dir, ".worktrees");
  p2 = await set({ worktrees_root: path_str(inside), base_branch: " feature/x " });
  assert.deepEqual([p2.worktrees_root, p2.base_branch], [path_str(inside), "feature/x"]);
  assert.equal((await set({ base_branch: "" })).base_branch, null);

  // A task's too, which its agent may set.
  const t = create_task_inner(s, p.id, { title: "x" });
  const task = (v: any) => update_task_inner(s, t.id, v);
  for (const bad of ["a..b", "-x", "HEAD:x", "x~1"]) assert.equal((await err(task({ base_branch: bad }))).status, 400, bad);
  assert.equal((await task({ base_branch: "release/1.2" })).base_branch, "release/1.2");
  assert.equal((await task({ base_branch: " " })).base_branch, null);
  const e = await err(create_project_inner(s, p.profile_id, { name: "y", repo_path: path_str(dir), key: "Y", base_branch: "no..pe" }));
  assert.equal(e.status, 400);
});

// HA-42: setting up or tearing down a worktree checked only the task's own agent, not its reviewers'.
test("a_worktree_isnt_torn_down_or_set_up_under_a_reviewer", async () => {
  const s = testing.state();
  const [, p] = await git_project(s);
  let t = create_task_inner(s, p.id, { title: "x" });
  t = await worktree.setup(s, t.id);
  const r = db.insert_task(s.db(), { ...new_task(t.profile_id), project_id: t.project_id ?? null, kind: "review", title: "Review" });
  db.update_task(s.db(), r.id, [["parent_id", t.id], ["running", true]]);
  const teardown = () => teardown_worktree(s, req({}, { id: t.id }));
  assert.equal((await err(teardown())).status, 409);
  assert.equal((await err(setup_worktree(s, req({}, { id: t.id })))).status, 409);
  assert.ok(existsSync(t.worktree_path!));
  db.update_task(s.db(), r.id, [["running", false]]);
  assert.equal((await teardown()).worktree_state, "none");
});

// HA-42: moved to Ready for merge where agents couldn't run, a task never joined the merge queue.
test("ready_for_merge_queues_the_merge_even_before_agents_can_run", async () => {
  const s = testing.state();
  const [, p] = await git_project(s);
  let t = create_task_inner(s, p.id, { title: "x" });
  t = await worktree.setup(s, t.id);
  git(t.worktree_path!, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
  assert.ok(!runs.can_run_agents(s));
  t = await update_task_inner(s, t.id, { status: "ready_for_merge" });
  assert.deepEqual([t.status, t.merging], ["ready_for_merge", true]);
  assert.equal(db.queued_merges(s.db(), p.id, null).length, 1);
});

// HA-113: where GitHub approval is required, a task with no approved pull request can't go to Ready for merge.
test("ready_for_merge_needs_a_github_approval_where_required", async () => {
  const s = testing.state();
  const [dir, p] = await git_project(s);
  const t = await task_with_work(s, p, "a");
  const go = (id: string) => update_task_inner(s, id, { status: "ready_for_merge" });
  // A local-only repository, or one pushed elsewhere than GitHub, has no pull request workflow.
  db.update_profile(s.db(), p.profile_id, [["require_pr_approval", true]]);
  let cur = db.get_task(s.db(), t.id)!;
  assert.ok(!(await worktree.pr_approval_required(s, cur)));
  git(dir, ["remote", "add", "origin", "https://gitlab.com/o/r.git"]);
  assert.ok(!(await worktree.pr_approval_required(s, cur)));
  git(dir, ["remote", "set-url", "origin", "https://github.com/o/r.git"]);
  assert.ok(await worktree.pr_approval_required(s, cur));
  // The profile asks for it: no pull request, so refused, and the task stays where it was.
  db.update_profile(s.db(), p.profile_id, [["require_pr_approval", true]]);
  assert.ok(await fails(go(t.id)));
  assert.notEqual(db.get_task(s.db(), t.id)!.status, "ready_for_merge");
  // A pull request set or cleared by the same request is the one checked: cleared, there's none.
  db.update_task(s.db(), t.id, [["pr_url", "https://github.com/o/r/pull/1"]]);
  const cleared = await err(update_task_inner(s, t.id, { status: "ready_for_merge", pr_url: null }));
  assert.ok(cleared.message.includes("no pull request"), cleared.message);
  db.update_task(s.db(), t.id, [["pr_url", null]]);
  // Where the project's settings open no pull request for its tasks, there's none to wait for.
  db.update_project(s.db(), p.id, [["pull_requests", false]]);
  cur = db.get_task(s.db(), t.id)!;
  assert.ok(!(await worktree.pr_approval_required(s, cur)));
  db.update_project(s.db(), p.id, [["pull_requests", true], ["subproject_pull_requests", false]]);
  const sub = await task_with_work(s, p, "sub");
  db.update_task(s.db(), sub.id, [["subproject", true]]);
  db.update_task(s.db(), t.id, [["parent_id", sub.id]]);
  cur = db.get_task(s.db(), t.id)!;
  assert.ok(!(await worktree.pr_approval_required(s, cur)));
  db.update_task(s.db(), t.id, [["parent_id", null]]);
  cur = db.get_task(s.db(), t.id)!;
  assert.ok(await worktree.pr_approval_required(s, cur));
  // The project says otherwise.
  db.update_project(s.db(), p.id, [["require_pr_approval", false]]);
  assert.equal((await go(t.id)).status, "ready_for_merge");
});

test("a_folder_not_ready_for_worktrees_gets_one_setup_thread", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  let p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.ok(!p.is_git && !p.has_commits && p.setup_task_id == null);
  // This host can't run agents, so its agent doesn't start, but the thread is kept to try again from.
  const e = await err(start_setup_thread_inner(s, p.id, { message: "Use trunk" }));
  assert.ok(e.message.includes("can't run agents"), e.message);
  p = db.get_project(s.db(), p.id)!;
  const id = p.setup_task_id!;
  const t = db.get_task(s.db(), id)!;
  assert.deepEqual([t.project_id, t.use_worktree, t.task_type ?? null], [p.id, false, null]);
  assert.ok(t.description.includes("isn't a git repository yet") && t.description.includes(p.repo_path), t.description);
  // Asked again (from another tab, say), it's the same thread.
  await can_run(async () => {
    assert.equal((await start_setup_thread_inner(s, p.id, {})).id, id);
    assert.equal(db.list_tasks_for_project(s.db(), p.id, "task").length, 1);
  });

  git(dir, ["init", "-q"]);
  p = db.get_project(s.db(), p.id)!;
  assert.ok(p.is_git && !p.has_commits);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  assert.ok(db.get_project(s.db(), p.id)!.has_commits);
  // One that's ready gets no new thread.
  db.update_project(s.db(), p.id, [["setup_task_id", null]]);
  const e2 = await err(start_setup_thread_inner(s, p.id, {}));
  assert.ok(e2.message.includes("ready for worktrees already"), e2.message);
});

test("tasks_get_their_pull_requests_previews", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const project = db.insert_project(s.db(), new_project(p.id));
  const task = (title: string) => create_task_inner(s, project.id, { title }).id;
  const update = (id: string, v: any) => update_task_inner(s, id, v);
  const set = (v: any) => update_project_inner(s, project.id, { pr_preview_url: v });
  const preview = (id: string) => db.get_task(s.db(), id)!.preview_url ?? null;
  const pr = (n: number) => `https://github.com/o/web/pull/${n}`;

  // Before the project has one, from the pull requests they already had.
  const [open, own, done, none] = [task("Open"), task("Own"), task("Done"), task("No PR")];
  await update(open, { pr_url: pr(4) });
  await update(own, { pr_url: pr(5), preview_url: "https://staging.example.com/" });
  await update(done, { pr_url: pr(6), status: "done" });
  assert.equal(preview(open), null);
  for (const bad of ["https://pr.example.com/", "pr{pr}.example.com", 3]) assert.ok(await fails(set(bad)), JSON.stringify(bad));
  assert.equal((await set(" https://pr{pr}.example.com/b ")).pr_preview_url, "https://pr{pr}.example.com/b");
  assert.equal(preview(open), "https://pr4.example.com/b");
  // One set otherwise stays, a done task's preview is gone, and without a PR there's none.
  assert.equal(preview(own), "https://staging.example.com/");
  assert.deepEqual([preview(done), preview(none)], [null, null]);

  // Its new pull request's, from then on.
  await update(none, { pr_url: pr(7) });
  assert.equal(preview(none), "https://pr7.example.com/b");
  await update(none, { pr_url: pr(8) });
  assert.equal(preview(none), "https://pr8.example.com/b");
  s.update_task(task("Found"), [["pr_url", pr(9)]]);
  const found = db.list_tasks_for_project(s.db(), project.id, "task").find((t) => t.title === "Found")!;
  assert.equal(found.preview_url, "https://pr9.example.com/b");
  await update(none, { pr_url: "" });
  assert.equal(preview(none), null);
  await update(own, { pr_url: pr(10) });
  assert.equal(preview(own), "https://staging.example.com/");
  // One given with it wins.
  await update(none, { pr_url: pr(11), preview_url: "https://mine.example.com/" });
  assert.equal(preview(none), "https://mine.example.com/");

  // Changing it moves those it made, and clearing it takes them off.
  await set("https://{pr}.preview.example.com/");
  assert.equal(preview(open), "https://4.preview.example.com/");
  assert.equal(preview(own), "https://staging.example.com/");
  assert.equal(preview(none), "https://mine.example.com/");
  assert.equal((await set("")).pr_preview_url, null);
  assert.deepEqual([preview(open), preview(found.id)], [null, null]);
  assert.equal(preview(own), "https://staging.example.com/");
  await update(open, { pr_url: pr(12) });
  assert.equal(preview(open), null);
});

test("groups_projects", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.equal(p.group_name, null);
  const set = (v: any) => update_project_inner(s, p.id, { group_name: v });
  assert.equal((await set("  Work  ")).group_name, "Work");
  assert.equal(db.get_project(s.db(), p.id)!.group_name, "Work");
  assert.equal((await set(" ")).group_name, null);
  await set("Work");
  assert.equal((await set(null)).group_name, null);
  assert.ok(await fails(set(3)));
  assert.ok(await fails(set("x".repeat(101))));
});

test("scratch_tasks_are_in_no_project_and_work_in_their_own_folder", async () => {
  await can_run(async () => {
    const s = testing.state();
    const profile = db.insert_profile(s.db(), "p", [], null);
    const t = create_scratch_task_inner(s, profile.id, {});
    assert.deepEqual([t.title, t.number, t.project_id ?? null, db.is_scratch(t)], ["New scratch task", 1, null, true]);
    assert.equal(runner.task_key_prefix(s, t), "S");
    const t2 = create_scratch_task_inner(s, profile.id, { title: "Notes", task_type: "scratch" });
    assert.equal(t2.number, 2);
    assert.equal(documents.work_dir(s, t2), documents.dir(s, t2.id));
    assert.equal(runner.work_dir(s, t2), documents.dir(s, t2.id));
    // It can have labels too, also given as a type as before API 71.
    const planned = create_scratch_task_inner(s, profile.id, { task_type: "plan" });
    assert.deepEqual([planned.task_type, planned.labels], ["scratch", ["plan"]]);
    for (const bad of [{ task_type: "essay" }, { labels: ["essay"] }, { use_worktree: true }, { subproject: true }, { kind: "review" }] as CreateTask[]) {
      assert.throws(() => create_scratch_task_inner(s, profile.id, bad), JSON.stringify(bad));
    }
    assert.throws(() => create_scratch_task_inner(s, "nobody", {}));
    // Nothing to merge, so Ready for merge marks it done.
    const done = await update_task_inner(s, t.id, { status: "ready_for_merge" });
    assert.deepEqual([done.status, done.merging], ["done", false]);

    // No project can take the key its tasks use.
    const dir = join(testing.temp_dir(), "x");
    const b = (key: string | null) => ({ name: "Shop", repo_path: path_str(dir), key });
    const e = await err(create_project_inner(s, profile.id, b("s")));
    assert.ok(e.message.includes("scratch tasks"), e.message);
    const p = await create_project_inner(s, profile.id, b(null));
    assert.ok(await fails(update_project_inner(s, p.id, { key: "S" })));
  });
});

test("archives_projects", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = testing.temp_dir();
  const make = (name: string) => create_project_inner(s, profile.id, { name, repo_path: path_str(join(dir, name)) });
  const p = await make("x");
  const other = await make("y");
  for (const id of [p.id, other.id]) await update_project_inner(s, id, { group_name: "Shop" });
  const task = create_task_inner(s, p.id, { title: "t" });
  const set = (v: any) => update_project_inner(s, p.id, { archived: v });
  const listed = async (archived: boolean) => (await list_projects(s, req({}, { id: profile.id }, { archived: String(archived) }))).map((p: any) => p.name);
  assert.deepEqual(await listed(false), ["x", "y"]);
  assert.deepEqual(await listed(true), []);

  // Not while one of its agents is running.
  s.runs.set(task.id, { run_id: "r", cancel: null });
  const e = await err(set(true));
  assert.ok(e.message.includes("1 of the project's agents is running"), e.message);
  s.runs.clear();

  const archived = (await set(true)).archived_at;
  assert.ok(archived, "archived");
  assert.deepEqual([await listed(false), await listed(true)], [["y"], ["x"]]);
  // Out of its group, and no new tasks.
  assert.deepEqual(db.group_projects(s.db(), profile.id, "Shop").map((p) => p.name), ["y"]);
  const e2 = await err(() => create_task_inner(s, p.id, { title: "u" }));
  assert.ok(e2.message.includes("is archived"), e2.message);
  // Archiving again keeps when it was archived.
  assert.equal((await set(true)).archived_at, archived);
  assert.ok(await fails(set("yes")));

  assert.equal((await set(false)).archived_at, null);
  assert.deepEqual(await listed(false), ["x", "y"]);
  create_task_inner(s, p.id, { title: "u" });
});

test("a_done_task_can_be_given_when_it_was_done", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const t = db.insert_task(s.db(), new_task(profile.id));
  const set = (b: any) => update_task_inner(s, t.id, b);
  // Only a done task has one, and only a time will do.
  assert.ok(await fails(set({ done_at: "2026-01-01T00:00:00Z" })));
  assert.ok(await fails(set({ status: "done", done_at: "yesterday" })));
  assert.ok(await fails(set({ status: "done", done_at: null })));
  assert.equal((await set({ status: "todo" })).done_at ?? null, null);
  // Moved into done with one, it keeps it, in UTC; a new one replaces it.
  const done = await set({ status: "done", done_at: "2026-01-01T13:00:00+13:00" });
  assert.equal(done.done_at, "2026-01-01T00:00:00.000Z");
  assert.equal((await set({ done_at: "2026-02-01T00:00:00Z" })).done_at, "2026-02-01T00:00:00.000Z");
  // Moving it out of done in the same request isn't allowed, and moving it out clears it.
  assert.ok(await fails(set({ status: "in_review", done_at: "2026-02-01T00:00:00Z" })));
  assert.equal((await set({ status: "in_review" })).done_at ?? null, null);
});

test("any_task_can_have_labels", async () => {
  await can_run(async () => {
    const s = testing.state();
    const profile = db.insert_profile(s.db(), "p", [], null);
    const dir = testing.temp_dir();
    execFileSync("git", ["init", "-q", dir]);
    const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
    const labelled = (l: any): CreateTask => ({ title: "Draw it", labels: l });
    const typed = (t: string): CreateTask => ({ title: "Draw it", task_type: t });
    const labels = (t: Task) => t.labels.join(",");

    // A code task, in a worktree, with a plan and a diagram.
    const plan = create_task_inner(s, p.id, labelled(["diagram", "plan"]));
    assert.deepEqual([plan.task_type ?? null, labels(plan), plan.use_worktree], [null, "plan,diagram", true]);
    // A type that's a label, as before API 71, is that label.
    let old = create_task_inner(s, p.id, { ...typed("plan"), labels: ["artifact"] });
    assert.deepEqual([old.task_type ?? null, labels(old), old.use_worktree], [null, "plan,artifact", true]);
    assert.throws(() => create_task_inner(s, p.id, typed("essay")));
    assert.throws(() => create_task_inner(s, p.id, labelled(["essay"])));
    assert.throws(() => create_task_inner(s, p.id, labelled("plan")));
    const sp = create_task_inner(s, p.id, { ...typed("plan"), subproject: true });
    assert.deepEqual([sp.subproject, labels(sp)], [true, "plan"]);
    assert.throws(() => create_task_inner(s, p.id, { ...typed("plan"), kind: "review" }));
    assert.equal(labels(create_task_inner(s, p.id, typed(" "))), "");

    // Labels can be added and taken off.
    const set = (id: string, b: any) => update_task_inner(s, id, b);
    assert.equal(labels(await set(plan.id, { labels: ["artifact", "plan"] })), "plan,artifact");
    assert.ok(await fails(set(plan.id, { labels: ["poem"] })));
    assert.ok(await fails(set(plan.id, { labels: "plan" })));
    assert.equal(labels(await set(plan.id, { labels: [] })), "");
    // A labelled task without changes has nothing to merge, as any task.
    await set(plan.id, { labels: ["plan"], use_worktree: false });
    const merged = await set(plan.id, { status: "ready_for_merge" });
    assert.equal(merged.status, "done");

    // A plan task from before labels (as the migration leaves it) still works in its own folder.
    old = db.update_task(s.db(), old.id, [["labels", ["plan"]], ["use_worktree", false], ["work_dir", `documents/${old.id}`]])!;
    assert.equal(runner.work_dir(s, old), documents.dir(s, old.id));
    assert.ok(await fails(set(old.id, { use_worktree: true })));
    assert.ok(await fails(set(old.id, { subproject: true })));
    // The board keeps the document, so there's nothing to merge.
    const done = await set(old.id, { status: "ready_for_merge" });
    assert.deepEqual([done.status, done.resolution, done.merging], ["done", "done", false]);

    // A group task can have them too.
    await update_project_inner(s, p.id, { group_name: "Shop" });
    const g = await create_group_task(s, req({ group: "Shop", ...labelled(["diagram"]) }, { id: profile.id }));
    assert.deepEqual([g.task_type ?? null, g.labels, g.group_name], [null, ["diagram"], "Shop"]);
    assert.ok(await fails(create_group_task(s, req({ group: "Shop", ...typed("poem") }, { id: profile.id }))));
    assert.ok(await fails(create_group_task(s, req({ group: "Shop", ...typed("scratch") }, { id: profile.id }))));

    // Its folder goes with it.
    const folder = documents.dir(s, done.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "plan.html"), "<h1>Plan</h1>");
    // So do its finished runs' folders; one still stopping is left for runs::prune.
    const run = (exit: boolean) => {
      const r = db.insert_run(s.db(), done.id, "prompt");
      const d = runs.run_dir(s, r.id);
      mkdirSync(d, { recursive: true });
      if (exit) writeFileSync(join(d, "exit"), "{}");
      return d;
    };
    const finished = run(true), stopping = run(false);
    await delete_one(s, done, false);
    assert.ok(!existsSync(folder));
    assert.ok(!existsSync(finished) && existsSync(stopping));
  });
});

test("tasks_made_from_one_prompt_share_a_fanout_id", async () => {
  await can_run(async () => {
    const s = testing.state();
    const profile = db.insert_profile(s.db(), "p", [], null);
    const dir = testing.temp_dir();
    const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir), key: "WEB" });
    const fanned = (id: string): CreateTask => ({ title: "Look", fanout_id: id });
    const a = create_task_inner(s, p.id, fanned("f-1"));
    const b = create_task_inner(s, p.id, { ...fanned("f-1"), model: "opus" });
    assert.deepEqual([a.fanout_id, b.fanout_id], ["f-1", "f-1"]);
    const scratch = create_scratch_task_inner(s, profile.id, { title: "Ask", fanout_id: "f_2" });
    assert.equal(scratch.fanout_id, "f_2");
    // On its own, or with a blank one, it has none.
    assert.equal(create_task_inner(s, p.id, { title: "Alone" }).fanout_id ?? null, null);
    assert.equal(create_task_inner(s, p.id, fanned(" ")).fanout_id ?? null, null);
    // A group's plans made from one prompt are linked too.
    await update_project_inner(s, p.id, { group_name: "Shop" });
    const grouped = (id: string) => req({ group: "Shop", ...fanned(id), task_type: "plan" }, { id: profile.id });
    const g = await create_group_task(s, grouped("f-3"));
    assert.deepEqual([g.labels, g.fanout_id], [["plan"], "f-3"]);
    for (const bad of ["a b", "x/y", "z".repeat(65)]) {
      assert.throws(() => create_task_inner(s, p.id, fanned(bad)), bad);
      assert.throws(() => create_scratch_task_inner(s, profile.id, fanned(bad)), bad);
      assert.ok(await fails(create_group_task(s, grouped(bad))), bad);
    }
  });
});

test("scratch_tasks_and_subprojects_are_task_types_in_a_project", async () => {
  await can_run(async () => {
    const s = testing.state();
    const profile = db.insert_profile(s.db(), "p", [], null);
    const dir = testing.temp_dir();
    execFileSync("git", ["init", "-q", dir]);
    const p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir), key: "WEB" });
    const typed = (t: string): CreateTask => ({ title: "Look", task_type: t });

    // A subproject is a type of task, though it's kept as the subproject flag.
    const sp = create_task_inner(s, p.id, typed("subproject"));
    assert.deepEqual([sp.subproject, sp.task_type ?? null, sp.use_worktree], [true, null, true]);

    // A scratch task in the project is numbered with its tasks and works in its own folder.
    const scratch = create_task_inner(s, p.id, typed("scratch"));
    assert.ok(db.is_scratch(scratch));
    assert.deepEqual([scratch.project_id, scratch.number, scratch.use_worktree], [p.id, 2, false]);
    assert.equal(runner.task_key_prefix(s, scratch), "WEB");
    assert.equal(runner.work_dir(s, scratch), documents.dir(s, scratch.id));
    assert.ok(db.is_scratch(create_task_inner(s, p.id, { ...typed("scratch"), use_worktree: true })));
    assert.throws(() => create_task_inner(s, p.id, { ...typed("scratch"), subproject: true }));

    // And in a subproject, where it isn't part of the subproject's work: its column doesn't follow it, and the
    // subproject merges without asking about it.
    const inner = create_task_inner(s, p.id, { ...typed("scratch"), parent_id: sp.id });
    assert.deepEqual([inner.parent_id, inner.use_worktree, db.is_scratch(inner)], [sp.id, false, true]);
    s.update_task(inner.id, [["status", "in_progress"]]);
    assert.equal(db.get_task(s.db(), sp.id)!.status, "todo");
    assert.throws(() => create_task_inner(s, p.id, { ...typed("subproject"), parent_id: sp.id }));

    // Nothing to merge, so Ready for merge marks it done.
    let done = await update_task_inner(s, scratch.id, { status: "ready_for_merge" });
    assert.deepEqual([done.status, done.merging], ["done", false]);
    // Nor does its scratch task give the subproject anything to merge: never started, it's done without a merge run
    // (IA-129 review).
    done = await update_task_inner(s, sp.id, { status: "ready_for_merge" });
    assert.deepEqual([done.status, done.merging, done.running], ["done", false, false]);
  });
});

test("sets_a_script_per_status", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const dir = join(testing.temp_dir(), "x");
  let p = await create_project_inner(s, profile.id, { name: "x", repo_path: path_str(dir) });
  assert.deepEqual(p.status_scripts, {});
  const id = p.id;
  const set = (v: any) => update_project_inner(s, id, { status_scripts: v });
  // Blank scripts are dropped.
  p = await set({ done: "make clean", todo: "  " });
  assert.deepEqual(p.status_scripts, { done: "make clean" });
  assert.deepEqual(db.get_project(s.db(), p.id)!.status_scripts, p.status_scripts);
  assert.ok(await fails(set({ finished: "x" })));
  assert.ok(await fails(set({ done: 3 })));
  assert.ok(await fails(set("make clean")));
  assert.deepEqual((await set(null)).status_scripts, {});
});

test("deleting_a_running_task_lets_go_of_its_run", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "in_progress"));
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  const dir = runs.run_dir(s, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), "");
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  await delete_one(s, task, false);
  // The agent exits after its task (and with it the run's row) is gone.
  runner.on_exit(s, run.id, null, 15, null, "");
  assert.ok(!s.is_running(task.id));
});

// HA-37: deleting a profile left its worktrees registered in their repositories, and its folders, runs and documents
// behind.
test("deleting_a_profile_cleans_up_after_its_projects_and_threads", async () => {
  const s = testing.state();
  const [dir, p] = await git_project(s);
  let t = create_task_inner(s, p.id, { title: "x" });
  t = await worktree.setup(s, t.id);
  const wt = t.worktree_path!;
  const worktrees = () => execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" });
  assert.ok(worktrees().includes(wt));
  // A finished run, and a scratch task's documents.
  const run = db.insert_run(s.db(), t.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  const run_dir = runs.run_dir(s, run.id);
  mkdirSync(run_dir, { recursive: true });
  writeFileSync(join(run_dir, "exit"), "0");
  const scratch = create_scratch_task_inner(s, p.profile_id, {});
  const docs = documents.dir(s, scratch.id);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "notes.md"), "x");
  mkdirSync(s.profile_scratch_dir(p.profile_id), { recursive: true });
  const project_dir = join(s.data_dir, "projects", p.id);
  assert.ok(statSync(project_dir).isDirectory());

  assert.deepEqual(await call(s, "DELETE", `/api/profiles/${p.profile_id}`), [200, { ok: true }]);
  assert.ok(!worktrees().includes(wt), worktrees());
  assert.ok(!existsSync(wt));
  assert.ok(!existsSync(project_dir) && !existsSync(run_dir) && !existsSync(docs));
  assert.ok(!existsSync(join(s.data_dir, "profiles", p.profile_id)));
  assert.equal(db.get_task(s.db(), scratch.id), null);
  // The branch is kept.
  assert.equal(spawnSync("git", ["-C", dir, "rev-parse", "--verify", "-q", t.branch!], { stdio: "ignore" }).status, 0);
  assert.equal((await call(s, "DELETE", `/api/profiles/${p.profile_id}`))[0], 404);
});

test("deleting_a_project_keeps_its_folder_if_another_uses_it", async () => {
  const s = testing.state();
  const [, a] = await git_project(s);
  const [, b] = await git_project(s);
  const shared = join(s.data_dir, "projects", a.id, "shared");
  await update_project_inner(s, b.id, { worktrees_root: path_str(shared) });
  await delete_project_inner(s, a.id);
  assert.ok(statSync(join(s.data_dir, "projects", a.id)).isDirectory());
  await delete_project_inner(s, b.id);
  assert.ok(!existsSync(join(s.data_dir, "projects", b.id)));
});

test("unknown_ids_get_a_404", async () => {
  const s = testing.state();
  for (const [method, path] of [
    ["DELETE", "/api/profiles/nope"],
    ["DELETE", "/api/claude-configs/nope"],
    ["DELETE", "/api/tasks/nope/terminal"],
    ["POST", "/api/tasks/nope/terminal/keepalive?tool=x"],
    ["GET", "/api/projects/nope/tasks"],
  ]) {
    assert.equal((await call(s, method, path))[0], 404, `${method} ${path}`);
  }
});

// HA-37: a blank name made a profile's clone folder ~, and one renamed to another's took its grants.
test("profile_names_are_required_and_unique", async () => {
  const s = testing.state();
  const create = (name: any) => create_profile(s, req({ name }));
  const personal = await create(" personal ");
  assert.equal(personal.name, "personal");
  const work = await create("work");
  assert.equal((await err(create("Personal"))).status, 409);
  assert.equal((await err(create(" "))).status, 400);
  const rename = (id: string, name: any) => update_profile(s, req({ name }, { id }));
  for (const [bad, status] of [["", 400], [" ", 400], [3, 400], [null, 400], [" PERSONAL", 409]] as Array<[any, number]>) {
    assert.equal((await err(rename(work.id, bad))).status, status, JSON.stringify(bad));
  }
  assert.equal(db.get_profile(s.db(), work.id)!.name, "work");
  // Its own name in another case is fine.
  assert.equal((await rename(personal.id, "Personal")).name, "Personal");
  assert.equal((await rename(work.id, " office ")).name, "office");
});

// HA-47: two profiles named in different cases before HA-37 got a 409 on every save of either.
test("profiles_sharing_a_name_in_another_case_can_still_be_saved", async () => {
  const s = testing.state();
  const upper = db.insert_profile(s.db(), "Work", [], null);
  const lower = db.insert_profile(s.db(), "work", [], null);
  const save = (id: string, body: any) => update_profile(s, req(body, { id }));
  for (const p of [upper, lower]) {
    const saved = await save(p.id, { name: ` ${p.name} `, default_model: "haiku" });
    assert.deepEqual([saved.name, saved.default_model], [p.name, "haiku"]);
  }
  // A change of case is still checked.
  assert.equal((await err(save(lower.id, { name: "WORK" }))).status, 409);
  assert.equal((await save(lower.id, { name: "office" })).name, "office");
});

// HA-47: deleting a profile removed its folder even with another project's worktrees in it.
test("deleting_a_profile_keeps_its_folder_if_a_project_uses_it", async () => {
  const s = testing.state();
  const gone = db.insert_profile(s.db(), "gone", [], null);
  const folder = join(s.data_dir, "profiles", gone.id);
  mkdirSync(join(folder, "scratch"), { recursive: true });
  const [, p] = await git_project(s);
  db.run(s.db(), "UPDATE projects SET worktrees_root=?1 WHERE id=?2", path_str(join(folder, "worktrees")), p.id);
  await delete_profile(s, req({}, { id: gone.id }));
  assert.ok(statSync(folder).isDirectory());
});

// HA-47: through a symlinked data dir, a used path that didn't exist yet didn't keep its folder.
test("a_folder_is_kept_for_a_path_in_it_through_a_symlink", async () => {
  const s = testing.state();
  const tmp = testing.temp_dir();
  mkdirSync(join(tmp, "real/projects/x"), { recursive: true });
  symlinkSync(join(tmp, "real"), join(tmp, "link"));
  const dir = join(tmp, "link/projects/x");
  const [, p] = await git_project(s);
  db.run(s.db(), "UPDATE projects SET worktrees_root=?1 WHERE id=?2", path_str(join(dir, "worktrees")), p.id);
  remove_unused_dir(s, dir, "project");
  assert.ok(statSync(join(tmp, "real/projects/x")).isDirectory());
  db.run(s.db(), "UPDATE projects SET worktrees_root=?1 WHERE id=?2", path_str(join(tmp, "elsewhere")), p.id);
  remove_unused_dir(s, dir, "project");
  assert.ok(!existsSync(join(tmp, "real/projects/x")));
});

test("claude_config_fields_must_be_strings", async () => {
  const s = testing.state();
  const cfg = db.insert_claude_config(s.db(), "c", "/claude/c", "claude");
  const { update_claude_config } = await import("./claude_configs.ts");
  for (const bad of [{ config_dir: 3 }, { config_dir: null }, { name: false }, { agent: 1 }]) {
    assert.equal((await err(update_claude_config(s, req(bad, { id: cfg.id })))).status, 400, JSON.stringify(bad));
  }
  assert.equal(db.get_claude_config(s.db(), cfg.id)!.config_dir, "/claude/c");
  assert.equal((await update_claude_config(s, req({ config_dir: "" }, { id: cfg.id }))).config_dir, "");
});

// HA-37: two moves to Ready for merge at once both started a merge.
test("two_moves_to_ready_for_merge_at_once_queue_one_merge", async () => {
  const s = testing.state();
  const [, p] = await git_project(s);
  let t = create_task_inner(s, p.id, { title: "x" });
  t = await worktree.setup(s, t.id);
  git(t.worktree_path!, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
  const body = { status: "ready_for_merge" };
  const results = await Promise.allSettled([update_task_inner(s, t.id, body), update_task_inner(s, t.id, body)]);
  const codes = results.map((r) => (r.status === "fulfilled" ? null : (r.reason as ApiError).status));
  assert.ok(codes.includes(null) && codes.includes(409), JSON.stringify(codes));
});

/** A task in project `p` with a commit to merge. */
async function task_with_work(s: AppState, p: Project, title: string): Promise<Task> {
  let t = create_task_inner(s, p.id, { title });
  t = await worktree.setup(s, t.id);
  git(t.worktree_path!, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
  return t;
}

/** Until the launch of `id`'s run is over: it fails, as there's no agent here. */
async function idle(s: AppState, id: string) {
  const deadline = Date.now() + 30_000;
  while (s.is_running(id)) {
    if (Date.now() > deadline) assert.fail(`${id} is still running`);
    await sleep(10);
  }
}

/** The agent's run on `id` ends, having answered (after its launch here failed). */
async function run_ends(s: AppState, id: string) {
  await idle(s, id);
  const run = db.insert_run(s.db(), id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running', saw_result=1 WHERE id=?1", run.id);
  s.runs.set(id, { run_id: run.id, cancel: null });
  s.update_task(id, [["running", true]]);
  runner.on_exit(s, run.id, 0, null, null, "");
}

function last_prompt(s: AppState, id: string): string {
  const m = db.list_messages(s.db(), id).filter((m) => m.kind === "user").pop()!;
  return m.data.text;
}

function approval_cards(s: AppState, id: string): db.Message[] {
  return db.list_messages(s.db(), id).filter((m) => m.kind === "question" && m.data.merge_approval === true);
}

const pick = (choice: string): questions.Answer => ({ choices: [choice], text: null });

// HA-86: a merge waits for the user's approval of its agent's summary.
test("a_merge_waits_for_the_users_approval_of_its_summary", async () => {
  await can_run(async () => {
    const s = testing.state();
    const [, p] = await git_project(s);
    db.update_profile(s.db(), p.profile_id, [["merge_approval", true]]);
    let t = await task_with_work(s, p, "a");
    const blocked = (id: string) => merge_gate.blocked(s.db(), db.get_task(s.db(), id)!);
    // Not merging, it can't merge either.
    assert.ok(blocked(t.id) != null);

    // Moved to Ready for merge, its agent summarises the merge, out of the merge queue.
    t = await update_task_inner(s, t.id, { status: "ready_for_merge" });
    assert.deepEqual([t.status, t.merging, t.merge_approval, t.running], ["ready_for_merge", true, "pending", true]);
    assert.ok(last_prompt(s, t.id).includes("Do not merge yet"), last_prompt(s, t.id));
    assert.ok(blocked(t.id)!.includes("hasn't approved"));
    let run = db.latest_run(s.db(), t.id, null)!;
    const gate = await internal_merge_gate(s, req({}, { run_id: run }));
    assert.ok(gate.blocked!.startsWith("Merging is disabled"), JSON.stringify(gate));
    assert.equal(db.active_merge(s.db(), p.id, null), null);

    // Once it's done, the user is asked.
    await run_ends(s, t.id);
    t = db.get_task(s.db(), t.id)!;
    assert.deepEqual([t.status, t.merging, t.merge_approval], ["needs_attention", true, "pending"]);
    const cards = approval_cards(s, t.id);
    assert.deepEqual([cards.length, cards[0].data.status], [1, "pending"]);
    // It doesn't hold the merge slot meanwhile: another task merges.
    const other = await task_with_work(s, p, "b");
    db.update_task(s.db(), other.id, [["status", "ready_for_merge"], ["merging", true], ["merge_approval", "approved"]]);
    runner.start_next_merge(s, p.id);
    assert.ok(s.is_running(other.id));
    assert.ok(last_prompt(s, other.id).includes("The user approved the merge."));
    await idle(s, other.id);
    await update_task_inner(s, other.id, { status: "done" });

    // Approved, it merges.
    t = questions.answer(s, t.id, cards[0].id, pick("Approve"));
    assert.deepEqual([t.status, t.merging, t.merge_approval, t.running], ["ready_for_merge", true, "approved", true]);
    assert.ok(last_prompt(s, t.id).includes("The user approved the merge."), last_prompt(s, t.id));
    assert.deepEqual(approval_cards(s, t.id)[0].data.answer.choices, ["Approve"]);
    // The board's own question isn't a prompt of the user's.
    assert.equal(t.now_at ?? null, null);
    assert.equal(blocked(t.id), null);
    assert.throws(() => questions.answer(s, t.id, cards[0].id, pick("Deny")), "answered once");
    // The run's gh server asks the board.
    run = db.latest_run(s.db(), t.id, null)!;
    assert.deepEqual(await internal_merge_gate(s, req({}, { run_id: run })), { blocked: null });
    // Leaving the merge, it needs approving again.
    await idle(s, t.id);
    t = await update_task_inner(s, t.id, { status: "in_review" });
    assert.equal(t.merge_approval ?? null, null);
    assert.ok(blocked(t.id) != null);
  });
});

// HA-86: denied, a merge goes back to review; moved again, it's summarised again.
test("a_denied_merge_goes_back_to_review", async () => {
  await can_run(async () => {
    const s = testing.state();
    const [, p] = await git_project(s);
    // The project's setting wins over the profile's.
    db.update_profile(s.db(), p.profile_id, [["merge_approval", false]]);
    await update_project_inner(s, p.id, { merge_approval: true });
    let t = await task_with_work(s, p, "a");
    const to_merge = { status: "ready_for_merge" };
    await update_task_inner(s, t.id, to_merge);
    // It can't step out of a queue it isn't in.
    assert.equal((await err(update_task_inner(s, t.id, { status: "in_progress", remerge: true }))).status, 400);
    await run_ends(s, t.id);
    const card = approval_cards(s, t.id)[0].id;
    t = questions.answer(s, t.id, card, pick("Deny"));
    assert.deepEqual([t.status, t.merging, t.merge_approval ?? null, t.running], ["in_review", false, null, false]);

    // Moved there again while waiting, the old card goes and it's summarised again.
    await update_task_inner(s, t.id, to_merge);
    await run_ends(s, t.id);
    await update_task_inner(s, t.id, to_merge);
    t = db.get_task(s.db(), t.id)!;
    assert.deepEqual([t.status, t.merge_approval, t.running], ["ready_for_merge", "pending", true]);
    const cards = approval_cards(s, t.id);
    assert.deepEqual(cards.map((c) => c.data.status), ["answered", "replaced"]);
    assert.equal((await err(() => questions.answer(s, t.id, cards[1].id, pick("Approve")))).status, 409);
    await idle(s, t.id);

    // Turned off, merges go straight to the queue.
    await update_project_inner(s, p.id, { merge_approval: false });
    let u = await task_with_work(s, p, "b");
    u = await update_task_inner(s, u.id, to_merge);
    assert.deepEqual([u.merge_approval ?? null, u.running], [null, true]);
    assert.ok(last_prompt(s, u.id).startsWith('The user moved this task to "Ready for merge". Merge branch'), last_prompt(s, u.id));
    await idle(s, u.id);
  });
});

test("approval_rules_with_a_pattern_twice_arent_saved_and_saved_ones_decide_as_they_were_shown", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const path = `/api/profiles/${profile.id}/approval-rules`;
  // Bash: never under Bash: allow (the dialog's Try a tool says never) isn't saved as allow: it isn't saved.
  let [status, v] = await call(s, "POST", path, { rules: [{ tool: "Bash", decision: "allow" }, { tool: "bash", decision: "never" }] });
  assert.equal(status, 400, JSON.stringify(v));
  assert.ok(v.error.includes("more than one rule"), JSON.stringify(v));
  assert.equal((await call(s, "GET", path))[1].is_default, true);
  // Saved with one, it reads back, and decides, as it was sent.
  [status] = await call(s, "POST", path, { rules: [{ tool: "Bash", decision: "never" }, { tool: "mcp__g", decision: "allow" }] });
  assert.equal(status, 200);
  [, v] = await call(s, "GET", path);
  assert.deepEqual(v.rules, [{ tool: "Bash", decision: "never" }, { tool: "mcp__g", decision: "allow" }]);
  assert.equal(approval_rules.decide(approval_rules.get(s.db(), profile.id), "Bash")?.decision, "never");
});

test("approval_rules_and_the_action_log_take_only_what_they_should", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const path = `/api/profiles/${profile.id}/approval-rules`;
  // The view: the defaults until the profile saves its own, and what the UI needs to name the board's tools.
  let [status, v] = await call(s, "GET", path);
  assert.equal(status, 200);
  assert.deepEqual([v.is_default, v.expiry_minutes, v.board_server, v.google_server, v.create_task_tools], [true, 30, "huntaway", "google", ["create_task"]]);
  assert.deepEqual(v.rules, v.defaults.rules);
  // Only the expiry: the rules stay the defaults' (saved now), and a week at most.
  [status, v] = await call(s, "POST", path, { expiry_minutes: 0 });
  assert.deepEqual([status, v.is_default, v.expiry_minutes, v.rules.length], [200, false, 0, v.defaults.rules.length]);
  assert.equal((await call(s, "POST", path, { expiry_minutes: 7 * 24 * 60 + 1 }))[0], 400);
  // Rules of the wrong shape aren't taken.
  for (const body of [{ rules: [{ tool: "x", decision: "maybe" }] }, { rules: "Bash" }, { expiry_minutes: -1 }, { expiry_minutes: 1.5 }]) {
    assert.ok([400, 422].includes((await call(s, "POST", path, body))[0]), JSON.stringify(body));
  }
  // Reset: the defaults again.
  [, v] = await call(s, "POST", path, { reset: true });
  assert.equal(v.is_default, true);
  // A profile that isn't there.
  assert.equal((await call(s, "GET", "/api/profiles/nope/approval-rules"))[0], 404);
  assert.equal((await call(s, "POST", "/api/profiles/nope/approval-rules", { reset: true }))[0], 404);
  assert.equal((await call(s, "GET", "/api/profiles/nope/approval-log"))[0], 404);
  // The action log is the profile's own.
  const other = db.insert_profile(s.db(), "q", [], null);
  const mine = db.insert_task(s.db(), {
    profile_id: profile.id, project_id: null, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: null, effort: null,
    claude_config_id: null,
  });
  approval_rules.log_blocked(s, mine, "mcp__g__delete", { id: 1 }, "mcp__g__*delete*");
  assert.equal((await call(s, "GET", `/api/profiles/${profile.id}/approval-log`))[1].length, 1);
  assert.deepEqual((await call(s, "GET", `/api/profiles/${other.id}/approval-log?limit=5`))[1], []);
  // Answering a prompt from a notification needs no board token, but the rest of the API does.
  if (!s.local_router) router(s);
  const bare = (method: string, url: string, body: any) =>
    dispatch(s, makeReq(method, url, { "content-type": "application/json" }, Buffer.from(JSON.stringify(body))));
  assert.equal((await bare("POST", "/api/permissions/x/push-answer", { token: "t", decision: "allow" })).status, 403);
  assert.equal((await bare("GET", path, null)).status, 401);
});
