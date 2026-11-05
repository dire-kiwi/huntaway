// Port of server/src/agent/agent_tools/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Conn, NewProject, NewTask, Project, Task } from "../../db.ts";
import * as testing from "../../testing.ts";
import { path_str } from "../../util.ts";
import * as runner from "../runner.ts";
import * as documents from "../documents.ts";
import {
  MAX_DESCRIPTION,
  board_skills_off,
  check_disabled_skills,
  check_server_config,
  check_server_name,
  check_skill,
  claude_skills,
  create_skill_in,
  delete_in,
  effective,
  effective_with,
  frontmatter,
  get_overrides,
  last_run_skills,
  record_seen,
  reported_skills,
  set_overrides,
  skill_places,
  switches,
  sync_skills,
  tool_prefix,
  update_skill_in,
  valid_other_skill,
  with_board_skills,
  type Skill,
  type TaskSkill,
} from "../agent_tools.ts";

const throws = (f: () => unknown) => assert.throws(f);

function skill_of(name: string, content: string, description = ""): Skill {
  const s: any = { id: name, project_id: "p", name, description, content, enabled: true, source_id: null, created_at: "", updated_at: "" };
  Object.defineProperty(s, "source_path", { value: null, enumerable: false, writable: true });
  return s;
}

test("reads_skill_frontmatter", () => {
  assert.deepEqual(frontmatter("---\nname: deploy\ndescription: \"Deploy the app\"\nallowed-tools: Bash\n---\n\nBody\n"), {
    name: "deploy",
    description: "Deploy the app",
    user_invocable: true,
  });
  assert.deepEqual(frontmatter("---\nname: 'x'\ndescription: >\n  Folded\n  text\nother: 1\nuser-invocable: false\n---\n"), {
    name: "x",
    description: "Folded text",
    user_invocable: false,
  });
  // As Claude Code reads it.
  const invocable = (v: string) => frontmatter(`---\nname: x\nuser-invocable: ${v}\n---\n`)!.user_invocable;
  for (const v of ["true", "TRUE", "Yes", "on", "1", "true # x", '"true"', "'yes' # x"]) assert.ok(invocable(v), v);
  for (const v of ["false", "FALSE", "no", "off", "0", "false # Only the model", "'false'", '"true # x"', "", "# x", "maybe", "true maybe"]) {
    assert.ok(!invocable(v), v);
  }
  assert.ok(frontmatter("---\nname: x\n---\n")!.user_invocable);
  assert.equal(frontmatter("no frontmatter"), null);
  assert.equal(frontmatter("---\nname: unterminated\n"), null);
});

test("checks_skills", () => {
  check_skill("---\nname: ok-1\ndescription: d\n---\n");
  throws(() => check_skill("---\nname: Bad Name\ndescription: d\n---\n"));
  throws(() => check_skill("---\nname: ok\n---\n"));
  throws(() => check_skill("# just markdown"));
  const long = (n: number) => `---\nname: ok\ndescription: ${"é".repeat(n)}\n---\n`;
  check_skill(long(MAX_DESCRIPTION));
  throws(() => check_skill(long(MAX_DESCRIPTION + 1)));
  assert.ok(valid_other_skill("pdf") && valid_other_skill("my-plugin:do_it") && valid_other_skill("Legacy.Command"));
  assert.ok(!valid_other_skill("two words") && !valid_other_skill("x)") && !valid_other_skill("a,b") && !valid_other_skill(""));
});

test("saved_bad_skill_names_dont_block_toggles", () => {
  const saved = ["old one", "other bad", "pdf"];
  // Toggling another skill keeps the saved bad names instead of failing, and switching one back on still works while
  // the other is sent.
  assert.deepEqual(check_disabled_skills(saved, ["docx", "old one", "other bad", "pdf"]), ["docx", "old one", "other bad", "pdf"]);
  assert.deepEqual(check_disabled_skills(saved, ["other bad"]), ["other bad"]);
  // New bad names are still refused.
  throws(() => check_disabled_skills(saved, ["new bad", "pdf"]));
});

test("checks_server_configs", () => {
  assert.equal(check_server_config({ url: "https://x" }).type, "http");
  assert.equal(check_server_config({ command: "npx", args: ["-y", "pkg"] }).type, "stdio");
  throws(() => check_server_config({ type: "stdio" }));
  throws(() => check_server_config({ command: "x", args: "-y" }));
  throws(() => check_server_config({ url: "https://x", headers: { a: 1 } }));
  throws(() => check_server_config({ type: "ws", url: "x" }));
  throws(() => check_server_name(runner.MCP_SERVER_NAME));
  throws(() => check_server_name("has space"));
});

test("names_server_tools_like_claude_code", () => {
  assert.equal(tool_prefix("claude.ai Google Drive"), "mcp__claude_ai_Google_Drive");
  assert.equal(tool_prefix("my-server_2"), "mcp__my-server_2");
});

test("syncs_the_skills_dir", () => {
  const dir = join(testing.temp_dir(), "skills");
  const [a, b] = [skill_of("a", "A"), skill_of("b", "B")];
  sync_skills(dir, [a, b], dir);
  assert.equal(readFileSync(join(dir, "b/SKILL.md"), "utf8"), "B");
  sync_skills(dir, [skill_of("a", "A2")], dir);
  assert.equal(readFileSync(join(dir, "a/SKILL.md"), "utf8"), "A2");
  assert.ok(!existsSync(join(dir, "b")));
  rmSync(dir, { recursive: true });
});

test("lists_a_claude_tasks_skills", () => {
  const root = testing.temp_dir();
  const config = join(root, "config"), repo = join(root, "repo");
  const skill = (dir: string, name: string, description: string, extra: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`);
  };
  const personal = join(config, "skills"), project = join(repo, ".claude/skills");
  skill(join(personal, "mine"), "mine", "My own", "");
  skill(join(project, "repo-skill"), "repo-skill", "From the repository", "");
  skill(join(project, "user-only"), "user-only", "User only", "disable-model-invocation: true\n");
  // Changed since the last run so that only the model can call it.
  skill(join(project, "hidden"), "hidden", "Hidden", "user-invocable: false\n");
  // A frontmatter name that's another skill's folder doesn't hide or describe that skill, whether it sorts before it,
  // can be called or is in another folder.
  skill(join(project, "aaa-draft"), "deploy", "Draft", "");
  skill(join(project, "deploy"), "deploy", "Deploy", "");
  skill(join(project, "aab-hidden"), "deploy2", "Hidden draft", "user-invocable: false\n");
  skill(join(project, "deploy2"), "deploy2", "Deploy 2", "");
  skill(join(personal, "x"), "review", "Personal x", "");
  skill(join(project, "review"), "review", "Review", "");
  // Plugins' skills are read from the versions installed, not older ones in the cache.
  const cache = join(config, "plugins/cache/market");
  skill(join(cache, "plug/1.0.0/skills/lint"), "lint", "Old lints", "user-invocable: false\n");
  skill(join(cache, "plug/2.0.0/skills/lint"), "lint", "Lints", "");
  skill(join(cache, "upgraded/1.0.0/skills/review"), "review", "Old review", "");
  skill(join(cache, "upgraded/2.0.0/skills/review"), "review", "Review", "user-invocable: false\n");
  skill(join(cache, "upgraded/1.0.0/skills/fixed"), "fixed", "Old fixed", "user-invocable: false\n");
  skill(join(cache, "upgraded/2.0.0/skills/fixed"), "fixed", "Fixed", "");
  const install = (v: string) => [{ scope: "user", installPath: path_str(join(cache, v)) }];
  const main = join(root, "main");
  const scoped_of = (v: string, scope: string, project: string) => ({ scope, projectPath: path_str(project), installPath: path_str(join(cache, v)) });
  const scoped = [
    scoped_of("scoped/2.0.0", "project", main),
    scoped_of("scoped/1.0.0", "project", join(root, "elsewhere")),
    { scope: "user", installPath: path_str(join(cache, "scoped/0.9.0")) },
  ];
  const installed = { version: 2, plugins: { "plug@market": install("plug/2.0.0"), "upgraded@market": install("upgraded/2.0.0"), "scoped@market": scoped } };
  writeFileSync(join(config, "plugins/installed_plugins.json"), JSON.stringify(installed));
  // Hidden since the last run, which reported them by their frontmatter names.
  skill(join(project, "source"), "alias-hidden", "Hidden", "user-invocable: false\n");
  skill(join(cache, "plug/2.0.0/skills/source-qualified"), "plug:alias-qualified", "Hidden", "user-invocable: false\n");
  skill(join(cache, "plug/2.0.0/skills/psrc"), "alias-plugin", "Hidden", "user-invocable: no\n");
  // A plugin installed for this project is read from that installation, not another project's or the user's.
  skill(join(cache, "scoped/0.9.0/skills/review"), "review", "User's", "user-invocable: false\n");
  skill(join(cache, "scoped/1.0.0/skills/review"), "review", "Elsewhere", "user-invocable: false\n");
  skill(join(cache, "scoped/2.0.0/skills/review"), "review", "Here", "");
  skill(join(cache, "scoped/1.0.0/skills/hidden"), "hidden", "Elsewhere", "");
  skill(join(cache, "scoped/2.0.0/skills/hidden"), "hidden", "Here", "user-invocable: false\n");
  skill(join(personal, "synced/bucket/pdf"), "pdf", "PDFs", "");
  mkdirSync(join(personal, "not-a-skill"), { recursive: true });
  const last_run = [
    "code-review", "anthropic-skills:pdf", "plug:lint", "upgraded:review", "upgraded:fixed", "hidden", "user-only", "deploy", "alias-hidden",
    "plug:alias-qualified", "plug:alias-plugin", "scoped:review", "scoped:hidden",
  ];
  // The task works in `repo` (a worktree, say) of the project checked out at `main`.
  const got = claude_skills(config, [repo], main, last_run).map((s) => [s.name, s.description]);
  assert.deepEqual(got, [
    ["aaa-draft", "Draft"],
    ["anthropic-skills:pdf", "PDFs"],
    ["code-review", ""],
    ["deploy", "Deploy"],
    ["deploy2", "Deploy 2"],
    ["mine", "My own"],
    ["plug:lint", "Lints"],
    ["repo-skill", "From the repository"],
    ["review", "Review"],
    ["scoped:review", "Here"],
    ["upgraded:fixed", "Fixed"],
    ["user-only", "User only"],
    ["x", "Personal x"],
  ]);
  // Before any run has reported them, the folders' skills are still there.
  assert.deepEqual(claude_skills(config, [], null, []), [
    { name: "mine", description: "My own" },
    { name: "x", description: "Personal x" },
  ]);
  rmSync(root, { recursive: true });
});

const project_of = (profile_id: string, id: string, repo_path = "/x", use_worktrees = false): NewProject => ({
  id,
  profile_id,
  name: id,
  key: "X",
  repo_path,
  scratch_path: "/s",
  worktrees_root: "/w",
  base_branch: null,
  use_worktrees,
});

test("finds_skills_where_the_agent_runs", () => {
  const state = testing.state();
  const c = state.db();
  const p = db.insert_profile(c, "p", [], null);
  const project = db.insert_project(c, { ...project_of(p.id, "pr", "/main", true), name: "x" });
  const new_task = (project_id: string | null, kind: string): NewTask => ({
    profile_id: p.id,
    project_id,
    kind,
    title: "t",
    description: "",
    status: "todo",
    use_worktree: kind === "task" && project_id !== null,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const places = (t: Task): [string, string[]] => {
    const [cwd, add] = skill_places(state, c, t, t.project_id !== null ? project : null);
    return [cwd ?? "", add];
  };
  let task = db.insert_task(c, new_task("pr", "task"));
  let review = db.insert_task(c, new_task("pr", "review"));
  review = db.update_task(c, review.id, [["parent_id", task.id]])!;
  // Before the worktree is set up, both run in the main checkout; then in the task's worktree.
  assert.deepEqual(places(review), ["/main", []]);
  task = db.update_task(c, task.id, [["worktree_path", "/w/1"], ["worktree_state", "ready"]])!;
  assert.deepEqual(places(task), ["/w/1", []]);
  assert.deepEqual(places(review), ["/w/1", []]);
  // A plan task from before labels works in its own folder, reading the project's checkout.
  let plan = db.insert_task(c, new_task("pr", "task"));
  plan = db.update_task(c, plan.id, [["labels", ["plan"]], ["work_dir", `documents/${plan.id}`]])!;
  const doc = path_str(documents.work_dir(state, plan)!);
  assert.deepEqual(places(plan), [doc, ["/main"]]);
  // A scratch task in no project works in its own folder (or its chat's), one without a type in the profile's.
  let scratch = db.insert_task(c, new_task(null, "task"));
  assert.equal(places(scratch)[0], path_str(state.profile_scratch_dir(p.id)));
  scratch = db.update_task(c, scratch.id, [["task_type", "scratch"], ["work_dir", "/chat"]])!;
  assert.deepEqual(places(scratch), ["/chat", []]);
});

const md = (name: string) => `---\nname: ${name}\ndescription: d\n---\n`;

function setup(): { c: Conn; a: Project; profile_id: string; skill: (project: string | null, name: string, enabled?: boolean | null) => Skill } {
  const c = db.open(":memory:");
  const profile = db.insert_profile(c, "p", [], null);
  const a = db.insert_project(c, project_of(profile.id, "a"));
  const skill = (project: string | null, name: string, enabled: boolean | null = null) => create_skill_in(c, project, { content: md(name), enabled });
  return { c, a, profile_id: profile.id, skill };
}

test("leaves_out_board_skills_turned_off_since", () => {
  const { c, a, skill } = setup();
  const own = skill("a", "own");
  const global = skill(null, "global");
  skill(null, "never-on");
  const set = (item: string, v: boolean) => db.run(c, "INSERT OR REPLACE INTO agent_tool_switches VALUES ('project','a',?1,?2)", item, v);
  set(global.id, true);
  const off = () => board_skills_off(c, a, effective(c, a)[0]);
  assert.deepEqual(off(), ["never-on"]);
  // Turned off after a run had them: the project's own one, and a global one switched off for the project.
  update_skill_in(c, "a", own.id, { content: null, enabled: false });
  set(global.id, false);
  assert.deepEqual(off().sort(), ["global", "never-on", "own"]);
});

test("leaves_out_board_skills_deleted_or_renamed_since", () => {
  const { c, a, skill } = setup();
  const [own, renamed, disabled, global] = [skill("a", "own"), skill("a", "renamed"), skill("a", "disabled"), skill(null, "global")];
  db.run(c, "INSERT INTO agent_tool_switches VALUES ('project','a',?1,1)", global.id);
  record_seen(c, "a", null, { skills: ["own", "renamed", "disabled", "global", "external"] });
  const reported = () => {
    const on = effective(c, a)[0];
    const off = board_skills_off(c, a, on);
    return reported_skills(get_overrides(c, "a").seen[""] ?? null, on, off);
  };
  assert.deepEqual(reported(), ["disabled", "external", "global", "own", "renamed"]);
  update_skill_in(c, "a", disabled.id, { content: null, enabled: false });
  update_skill_in(c, "a", renamed.id, { content: md("new-name"), enabled: null });
  assert.deepEqual(reported(), ["external", "global", "own"]);
  // Deleted, after being turned off or not; a run's own skill of the same name would still be found in its folder.
  for (const id of [own.id, disabled.id, global.id]) db.run(c, "DELETE FROM agent_skills WHERE id=?1", id);
  assert.deepEqual(reported(), ["external"]);
});

test("forgets_board_skills_deleted_or_renamed_from_runs_recorded_before", () => {
  const { c, a, profile_id, skill } = setup();
  const b = db.insert_project(c, project_of(profile_id, "b"));
  const [own, renamed, disabled, global] = [skill("a", "own"), skill("a", "renamed"), skill("a", "disabled"), skill(null, "global")];
  // Project b has its own skill named like the global one, which stays.
  skill("b", "global");
  for (const p of ["a", "b"]) db.run(c, "INSERT INTO agent_tool_switches VALUES ('project',?1,?2,1)", p, global.id);
  // Saved as runs recorded them before the board noted which skills were its own.
  const at = "2026-10-01T00:00:00.000Z";
  const names = ["disabled", "external", "global", "own", "renamed"];
  for (const p of ["a", "b"]) {
    const o = get_overrides(c, p);
    o.seen.cfg = { skills: names.map((n) => ({ name: n, at })), mcp_servers: [], at };
    set_overrides(c, p, o);
  }
  const reported = (p: Project) => {
    const on = effective(c, p)[0];
    const off = board_skills_off(c, p, on);
    return reported_skills(get_overrides(c, p.id).seen.cfg ?? null, on, off);
  };
  assert.deepEqual(reported(a), names);
  update_skill_in(c, "a", disabled.id, { content: null, enabled: false });
  update_skill_in(c, "a", renamed.id, { content: md("new-name"), enabled: null });
  assert.deepEqual(reported(a), ["external", "global", "own"]);
  // Deleted, the disabled one too.
  for (const [project, id] of [["a", own.id], ["a", disabled.id], [null, global.id]] as Array<[string | null, string]>) {
    assert.equal(delete_in(c, "agent_skills", project, id).ok, true);
  }
  assert.deepEqual(reported(a), ["external"]);
  assert.deepEqual(reported(b), ["disabled", "external", "global", "own", "renamed"]);
});

test("lists_the_skills_the_last_run_reported", () => {
  const c = db.open(":memory:");
  c.exec("PRAGMA foreign_keys=OFF;");
  record_seen(c, "p", "cfg", { skills: ["kept", "hidden-later"] });
  // An earlier run's, which Claude Code stopped reporting once a user couldn't call it.
  const o = get_overrides(c, "p");
  for (const s of o.seen.cfg.skills) s.at = "2000-01-01T00:00:00.000Z";
  set_overrides(c, "p", o);
  record_seen(c, "p", "cfg", { skills: ["kept"] });
  const o2 = get_overrides(c, "p");
  assert.deepEqual(last_run_skills(o2.seen.cfg), ["kept"]);
  assert.deepEqual(last_run_skills(o2.seen.other ?? null), []);
});

test("adds_the_boards_skills_a_user_can_call", () => {
  const skill = (name: string, extra: string) => skill_of(name, `---\nname: ${name}\ndescription: d\n${extra}---\n`, `${name} (board)`);
  const found = (names: string[]): TaskSkill[] => names.map((n) => ({ name: n, description: "" }));
  const board = () => [
    skill("deploy", ""),
    skill("hidden", "user-invocable: false # Only the model\n"),
    skill("no", "user-invocable: No\n"),
    skill("user-only", "disable-model-invocation: true\n"),
  ];
  const names = (s: TaskSkill[]) => s.map((x) => x.name);
  // Claude Code won't run `/hidden`, even if a run reported a skill by that name.
  const got = with_board_skills(found(["zeta", "hidden", "deploy"]), board(), false, ["zeta"]);
  assert.deepEqual(got[0], { name: "deploy", description: "deploy (board)" });
  assert.deepEqual(names(got), ["deploy", "user-only"]);
  // Codex has no such setting.
  assert.deepEqual(names(with_board_skills([], board(), true, [])), ["deploy", "hidden", "no", "user-only"]);
});

test("global_ones_follow_the_profile_unless_the_project_overrides", () => {
  const { c, a, profile_id, skill } = setup();
  const b = db.insert_project(c, project_of(profile_id, "b"));
  const [on, off] = [skill(null, "on"), skill(null, "off")];
  skill("a", "own");
  const set = (scope: string, scope_id: string, item: string, v: boolean) =>
    db.run(c, "INSERT OR REPLACE INTO agent_tool_switches VALUES (?1,?2,?3,?4)", scope, scope_id, item, v);
  set("profile", profile_id, on.id, true);
  set("project", "b", on.id, false);
  set("project", "b", off.id, true);
  const names = (p: Project) => effective(c, p)[0].map((s) => s.name);
  assert.deepEqual(names(a), ["own", "on"]);
  assert.deepEqual(names(b), ["off"]);
  // A project's own one takes the name while it's on, and the global one is used while it's off.
  const mine = skill("a", "on");
  const owners = (p: Project) => effective(c, p)[0].map((s) => s.project_id);
  assert.deepEqual(owners(a), ["a", "a"]);
  update_skill_in(c, "a", mine.id, { content: null, enabled: false });
  assert.deepEqual(names(a), ["own", "on"]);
  assert.deepEqual(owners(a), ["a", null]);
  // Deleting a global skill drops its switches.
  db.run(c, "DELETE FROM agent_skills WHERE id=?1", off.id);
  assert.equal(switches(c, "project", "b")[off.id], undefined);
});

test("a_thread_can_have_board_skills_the_project_doesnt", () => {
  const { c, a, skill } = setup();
  skill(null, "global", true);
  skill(null, "dead", false);
  skill("a", "own", true);
  skill("a", "local-off", false);
  skill("a", "dup", true);
  skill(null, "dup", true);
  const on = (extra: string[]) => effective_with(c, a, extra)[0].map((s) => [s.name, s.project_id] as [string, string | null]);
  // Global skills aren't on for the project unless switched on, and it has its own.
  assert.deepEqual(on([]).map((s) => s[0]), ["dup", "own"]);
  const got = on(["global", "dead", "missing", "dup", "own", "local-off"]);
  assert.deepEqual(got.map((s) => s[0]), ["dup", "own", "global", "local-off"]);
  // A project's own skill that's off for its runs can still be picked for a thread, and is off for the others.
  assert.ok(!on([]).some((s) => s[0] === "local-off"));
  // The project's own skill of a name wins over a global one, as it does for the project.
  assert.equal(got[0][1], "a");
  // A project's skill that's off for the project, and a global one of the same name that's on for it: picking the name
  // for a thread gives the project's, not the global one that's already there.
  const own = skill("a", "thread-audit", false);
  const global = skill(null, "thread-audit", true);
  db.run(c, "INSERT INTO agent_tool_switches VALUES ('project', 'a', ?1, 1)", global.id);
  const owner = (extra: string[]) => effective_with(c, a, extra)[0].find((s) => s.name === "thread-audit")?.id ?? null;
  assert.equal(owner([]), global.id);
  assert.equal(owner(["thread-audit"]), own.id);
});

test("records_what_runs_had", () => {
  const c = db.open(":memory:");
  c.exec("PRAGMA foreign_keys=OFF;");
  const init = {
    skills: ["zeta", "alpha"],
    mcp_servers: [
      { name: runner.MCP_SERVER_NAME, status: "connected" },
      { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
    ],
  };
  record_seen(c, "p", "cfg", init);
  const names = (key: string): string[] => get_overrides(c, "p").seen.cfg[key].map((v: any) => v.name);
  assert.deepEqual(names("skills"), ["alpha", "zeta"]);
  assert.deepEqual(names("mcp_servers"), ["claude.ai Gmail"]);
  // A later run that doesn't report everything keeps what earlier ones had...
  record_seen(c, "p", "cfg", { skills: ["beta"], mcp_servers: [] });
  assert.deepEqual(names("skills"), ["alpha", "beta", "zeta"]);
  assert.deepEqual(names("mcp_servers"), ["claude.ai Gmail"]);
  // ...until it's old.
  const o = get_overrides(c, "p");
  o.seen.cfg.skills[0].at = "2000-01-01T00:00:00.000Z";
  set_overrides(c, "p", o);
  record_seen(c, "p", "cfg", { skills: ["beta"] });
  assert.deepEqual(names("skills"), ["beta", "zeta"]);
});
