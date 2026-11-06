// Port of server/src/agent/agent_tools/sources/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "../../../db.ts";
import { ApiError, type Req } from "../../../http.ts";
import type { AppState } from "../../../state.ts";
import * as testing from "../../../testing.ts";
import { path_str } from "../../../util.ts";
import {
  add_source,
  check_ref,
  copy_skill,
  create_skill_in,
  delete_in,
  delete_source,
  discover,
  for_run,
  get_source,
  list_skills,
  list_sources,
  normalize_url,
  set_switch,
  skills_of,
  source_name,
  switches,
  update_skill_in,
  update_source,
} from "../../agent_tools.ts";

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill_md(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`;
}

/** A repository with a skill of its own (with a script) at its root, like asd-ste100-skill. */
function root_skill_repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  write(join(dir, "SKILL.md"), skill_md("ste-writer", "Writes in STE"));
  write(join(dir, "scripts/lint.py"), "print('lint')\n");
  write(join(dir, "references/rules.md"), "rules\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function req(params: Record<string, string>, body: any = {}): Req {
  return { method: "POST", path: "", params, query: {}, query_string: "", headers: {}, body, raw: Buffer.alloc(0) };
}

/** The status a handler fails with. */
async function status(p: Promise<any>): Promise<number> {
  try {
    await p;
  } catch (e) {
    return e instanceof ApiError ? e.status : 500;
  }
  throw new Error("expected an error");
}

const add = (s: AppState, url: string, ref: string | null = null) => add_source(s, req({}, { url, ref }));

test("normalizes_what_to_clone", () => {
  assert.equal(normalize_url("danyuchn/asd-ste100-skill"), "https://github.com/danyuchn/asd-ste100-skill");
  assert.equal(normalize_url(" owner/repo.git "), "https://github.com/owner/repo");
  assert.equal(normalize_url("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(normalize_url("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(normalize_url("ssh://git@host/o/r"), "ssh://git@host/o/r");
  assert.equal(normalize_url("/srv/repo"), "/srv/repo");
  for (const bad of [
    "",
    "  ",
    "--upload-pack=x",
    "-c",
    "ext::sh -c id",
    "ext::sh%20-c%20id",
    "fd::3",
    "ftp://x/y",
    "a/b/c",
    "../x",
    "owner",
    "https://x y",
    "a/b\nc",
    "./rel/path",
  ]) {
    assert.throws(() => normalize_url(bad), JSON.stringify(bad));
  }
  assert.equal(check_ref(null), null);
  assert.equal(check_ref("  "), null);
  assert.equal(check_ref("v1.2/x"), "v1.2/x");
  for (const bad of ["--foo", "a b", "a..b", "/x", "a;b"]) assert.throws(() => check_ref(bad), bad);
  assert.equal(source_name("https://github.com/o/my-skills.git"), "my-skills");
  assert.equal(source_name("git@host:o/r"), "r");
  assert.equal(source_name("/srv/repos/skills/"), "skills");
});

test("finds_the_skills_in_a_repository", () => {
  const root = testing.temp_dir();
  write(join(root, "skills/alpha/SKILL.md"), skill_md("alpha", "A"));
  // Inside a skill: part of it.
  write(join(root, "skills/alpha/nested/SKILL.md"), skill_md("inside-alpha", "Belongs to alpha"));
  write(join(root, "skills/beta/SKILL.md"), skill_md("beta", "B"));
  // The same skill mirrored for another agent: the visible folder wins.
  write(join(root, ".claude/skills/alpha/SKILL.md"), skill_md("alpha", "A again"));
  write(join(root, ".claude/skills/gamma/SKILL.md"), skill_md("gamma", "G"));
  write(join(root, "skills/bad/SKILL.md"), "no frontmatter");
  write(join(root, "skills/Upper/SKILL.md"), skill_md("Upper Case", "x"));
  write(join(root, "node_modules/pkg/SKILL.md"), skill_md("from-node-modules", "x"));
  write(join(root, ".git/hooks/SKILL.md"), skill_md("from-git", "x"));
  write(join(root, ".hidden/SKILL.md"), skill_md("from-hidden", "x"));
  const [found, notes] = discover(root);
  assert.deepEqual(
    found.map((f) => [f.path, f.name]),
    [
      ["skills/alpha", "alpha"],
      ["skills/beta", "beta"],
      [".claude/skills/gamma", "gamma"],
    ],
  );
  assert.equal(found[0].content, skill_md("alpha", "A"));
  assert.ok(
    notes.some((n) => n.startsWith("skills/bad:")),
    String(notes),
  );
  assert.ok(
    notes.some((n) => n.startsWith("skills/Upper:")),
    String(notes),
  );
  assert.ok(
    notes.some((n) => n.startsWith(".claude/skills/alpha:") && n.includes("another skill is named alpha")),
    String(notes),
  );
  assert.equal(notes.length, 3);

  // A skill at the root owns the whole repository.
  const single = testing.temp_dir();
  root_skill_repo(single);
  const [found2, notes2] = discover(single);
  assert.equal(found2.length, 1);
  assert.deepEqual([found2[0].path, found2[0].name], ["", "ste-writer"]);
  assert.deepEqual(notes2, []);

  // A link to a SKILL.md elsewhere isn't a skill.
  const linked = testing.temp_dir();
  mkdirSync(join(linked, "s"), { recursive: true });
  write(join(linked, "elsewhere/SKILL.md"), skill_md("linked", "x"));
  symlinkSync(join(linked, "elsewhere/SKILL.md"), join(linked, "s/SKILL.md"));
  symlinkSync(join(linked, "elsewhere"), join(linked, "dir-link"));
  assert.deepEqual(
    discover(linked)[0].map((f) => f.path),
    ["elsewhere"],
  );
});

test("copies_a_skill_folder_and_keeps_to_it", async () => {
  const root = testing.temp_dir();
  const from = join(root, "from"),
    to = join(root, "to");
  write(join(from, "SKILL.md"), "skill");
  write(join(from, "scripts/run.sh"), "#!/bin/sh\n");
  write(join(from, ".git/config"), "secret");
  symlinkSync("/etc/hostname", join(from, "link"));
  symlinkSync("/etc", join(from, "linked-dir"));
  // What an earlier copy left: a file that has gone, a file where there's a folder now.
  write(join(to, "gone.txt"), "x");
  write(join(to, "scripts"), "was a file");
  copy_skill(from, to);
  assert.equal(readFileSync(join(to, "SKILL.md"), "utf8"), "skill");
  assert.equal(readFileSync(join(to, "scripts/run.sh"), "utf8"), "#!/bin/sh\n");
  for (const gone of ["gone.txt", ".git", "link", "linked-dir"]) assert.throws(() => lstatSync(join(to, gone)), gone);
  // Files that are right aren't rewritten.
  const before = statSync(join(to, "SKILL.md")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  copy_skill(from, to);
  assert.equal(statSync(join(to, "SKILL.md")).mtimeMs, before);
  write(join(from, "SKILL.md"), "skill 2");
  copy_skill(from, to);
  assert.equal(readFileSync(join(to, "SKILL.md"), "utf8"), "skill 2");

  // A change that's only to a script's permissions reaches the copy, both ways.
  const script = join(from, "scripts/run.sh"),
    copy = join(to, "scripts/run.sh");
  const mode = (p: string) => statSync(p).mode & 0o777;
  chmodSync(script, 0o644);
  copy_skill(from, to);
  assert.equal(mode(copy), 0o644);
  chmodSync(script, 0o755);
  copy_skill(from, to);
  assert.equal(mode(copy), 0o755);
});

test("adds_updates_and_removes_a_skill_source", async () => {
  const state = testing.state();
  const repo = join(testing.temp_dir(), "repo");
  root_skill_repo(repo);
  const url = path_str(repo);
  const clones = join(state.data_dir, "skill-sources");

  // Added, its skill is off everywhere.
  let v = await add(state, url);
  const source_id: string = v.source.id,
    skill_id: string = v.skills[0].id;
  assert.equal(v.source.name, "repo");
  assert.equal(v.skills[0].name, "ste-writer");
  assert.equal(v.skills[0].source_id, source_id);
  assert.equal(v.skills[0].description, "Writes in STE");
  assert.ok(statSync(join(clones, source_id, "scripts/lint.py")).isFile());
  assert.ok(!existsSync(join(clones, `${source_id}.new`)));
  // Not twice, not with a ref that isn't there, and not with something that isn't a repository.
  assert.equal(await status(add(state, url)), 409);
  assert.equal(await status(add(state, url, "nope")), 502);
  assert.equal(await status(add(state, "ext::sh -c id")), 400);
  assert.equal(await status(add(state, path_str(testing.temp_dir()))), 502);
  assert.equal(list_sources(state.db()).length, 1);

  // A project of a profile switched on for it runs with the skill's whole folder.
  const c = state.db();
  const profile = db.insert_profile(c, "p", [], null);
  const project = db.insert_project(c, {
    id: "pr",
    profile_id: profile.id,
    name: "x",
    key: "X",
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
  });
  const skills_dir = join(state.data_dir, "projects/pr/agent/.claude/skills/ste-writer");
  assert.equal(for_run(state, "pr", null).skills_dir, null);
  const on = (scope: string, scope_id: string, source: string | null, item: string | null, enabled: boolean | null) =>
    set_switch(state, req({}, { scope, scope_id, item_id: item, source_id: source, enabled }));
  await on("profile", profile.id, source_id, null, true);
  assert.equal(switches(state.db(), "profile", profile.id)[skill_id], true);
  assert.notEqual(for_run(state, "pr", null).skills_dir, null);
  assert.equal(readFileSync(join(skills_dir, "scripts/lint.py"), "utf8"), "print('lint')\n");
  assert.equal(readFileSync(join(skills_dir, "references/rules.md"), "utf8"), "rules\n");
  assert.ok(!existsSync(join(skills_dir, ".git")));
  // The project can turn it off.
  await on("project", project.id, null, skill_id, false);
  assert.equal(for_run(state, "pr", null).skills_dir, null);
  await on("project", project.id, null, skill_id, null);
  await assert.rejects(on("profile", profile.id, null, null, true));
  await assert.rejects(on("profile", profile.id, "missing", null, true));

  // A source's skill is changed in its repository, not by itself.
  const edit = { content: skill_md("ste-writer", "mine"), enabled: null };
  assert.throws(
    () => update_skill_in(state.db(), null, skill_id, edit),
    (e: any) => e.status === 400,
  );
  assert.throws(
    () => delete_in(state.db(), "agent_skills", null, skill_id),
    (e: any) => e.status === 400,
  );
  assert.throws(
    () => create_skill_in(state.db(), null, { content: skill_md("ste-writer", "x"), enabled: null }),
    (e: any) => e.status === 409,
  );

  // The repository changes: a changed script and skill, and a file less.
  write(join(repo, "scripts/lint.py"), "print('lint 2')\n");
  unlinkSync(join(repo, "references/rules.md"));
  write(join(repo, "SKILL.md"), skill_md("ste-writer", "Writes better"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "more"]);
  const update = () => update_source(state, req({ source: source_id }));
  v = await update();
  assert.equal(v.skills.length, 1);
  assert.equal(v.skills[0].id, skill_id, "the skill keeps its id, and so its switches");
  assert.equal(v.skills[0].description, "Writes better");
  assert.equal(v.source.error, null);
  for_run(state, "pr", null);
  assert.equal(readFileSync(join(skills_dir, "scripts/lint.py"), "utf8"), "print('lint 2')\n");
  assert.ok(!existsSync(join(skills_dir, "references/rules.md")));

  // The repository goes away: the update fails, and what was there stays.
  const moved = join(dirname(repo), "moved");
  renameSync(repo, moved);
  assert.equal(await status(update()), 502);
  const source = get_source(state.db(), source_id)!;
  assert.ok(source.error?.includes("couldn't clone"), String(source.error));
  assert.equal(skills_of(state.db(), source_id).length, 1);
  assert.ok(statSync(join(clones, source_id, "scripts/lint.py")).isFile());
  assert.ok(!existsSync(join(clones, `${source_id}.new`)));
  renameSync(moved, repo);

  // The skill's folder moves, as it does once a repository has a second skill: the same skill, with its switches.
  mkdirSync(join(repo, "skills/ste-writer"), { recursive: true });
  for (const entry of ["SKILL.md", "scripts"]) git(repo, ["mv", entry, `skills/ste-writer/${entry}`]);
  git(repo, ["commit", "-q", "-m", "move"]);
  v = await update();
  assert.equal(v.skills.length, 1, JSON.stringify(v));
  assert.equal(v.skills[0].id, skill_id);
  assert.deepEqual(v.source.notes, []);
  assert.equal(switches(state.db(), "profile", profile.id)[skill_id], true);
  assert.notEqual(for_run(state, "pr", null).skills_dir, null);
  assert.equal(readFileSync(join(skills_dir, "scripts/lint.py"), "utf8"), "print('lint 2')\n");
  git(repo, ["mv", "skills/ste-writer/SKILL.md", "SKILL.md"]);
  git(repo, ["mv", "skills/ste-writer/scripts", "scripts"]);
  git(repo, ["commit", "-q", "-m", "move back"]);
  v = await update();
  assert.equal(v.skills[0].id, skill_id);

  // The skill goes from the repository and a new one comes: the old one is removed with its switches.
  unlinkSync(join(repo, "SKILL.md"));
  write(join(repo, "skills/fresh/SKILL.md"), skill_md("fresh", "New"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "restructure"]);
  v = await update();
  assert.deepEqual(
    v.skills.map((s: any) => s.name),
    ["fresh"],
  );
  assert.equal(v.source.error, null);
  assert.deepEqual(switches(state.db(), "profile", profile.id), {});
  assert.equal(for_run(state, "pr", null).skills_dir, null);
  assert.ok(!existsSync(skills_dir));

  // Removing the source takes its skills and clone.
  await delete_source(state, req({ source: source_id }));
  assert.deepEqual(list_sources(state.db()), []);
  assert.deepEqual(list_skills(state.db(), null), []);
  assert.ok(!existsSync(join(clones, source_id)));
  assert.equal(await status(delete_source(state, req({ source: source_id }))), 404);
});

test("a_source_whose_skills_names_are_taken_isnt_added", async () => {
  const state = testing.state();
  create_skill_in(state.db(), null, { content: skill_md("ste-writer", "mine"), enabled: null });
  const repo = join(testing.temp_dir(), "repo");
  root_skill_repo(repo);
  await assert.rejects(add(state, path_str(repo)), (e: any) => {
    assert.equal(e.status, 400);
    assert.ok(e.message.includes("no skills found") && e.message.includes("already on this host"), e.message);
    return true;
  });
  assert.deepEqual(list_sources(state.db()), []);
  const clones = join(state.data_dir, "skill-sources");
  assert.ok(!existsSync(clones) || readdirSync(clones).length === 0);
});

/** A source's skills trade names, or pass them along, in one commit: they stay the same skills, with their switches. */
test("a_source_whose_skills_swap_or_pass_on_names_keeps_them", async () => {
  const state = testing.state();
  const repo = join(testing.temp_dir(), "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  for (const name of ["alpha", "beta", "gamma"]) write(join(repo, `skills/${name}/SKILL.md`), skill_md(name, name));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  let v = await add(state, path_str(repo));
  const source_id: string = v.source.id;
  const ids = (v: any): Array<[string, string]> => v.skills.map((s: any) => [s.name, s.id]);
  const before = ids(v);
  const id_of = (name: string) => before.find(([n]) => n === name)![1];
  const profile = db.insert_profile(state.db(), "p", [], null);
  await set_switch(state, req({}, { scope: "profile", scope_id: profile.id, item_id: null, source_id, enabled: true }));
  const update = () => update_source(state, req({ source: source_id }));

  // alpha → beta, beta → gamma (a chain), and gamma → alpha: a cycle.
  const rename = (dir: string, name: string) => write(join(repo, `skills/${dir}/SKILL.md`), skill_md(name, "renamed"));
  rename("alpha", "beta");
  rename("beta", "gamma");
  rename("gamma", "alpha");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "rotate"]);
  v = await update();
  assert.deepEqual(v.source.notes, [], JSON.stringify(v));
  // Each folder's skill keeps its id (matched by folder) under its new name.
  assert.deepEqual(ids(v), [
    ["alpha", id_of("gamma")],
    ["beta", id_of("alpha")],
    ["gamma", id_of("beta")],
  ]);
  const on = switches(state.db(), "profile", profile.id);
  assert.ok(before.every(([, id]) => on[id] === true));

  // A swap of two: the folders of alpha and gamma (named beta and alpha now) trade names.
  rename("alpha", "alpha");
  rename("gamma", "beta");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "swap"]);
  v = await update();
  assert.deepEqual(v.source.notes, [], JSON.stringify(v));
  assert.equal(v.skills.length, 3);
  assert.equal(Object.keys(switches(state.db(), "profile", profile.id)).length, 3);

  // A name another global skill has still leaves out the one that wants it, and only that one.
  create_skill_in(state.db(), null, { content: skill_md("delta", "mine"), enabled: null });
  rename("alpha", "delta");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "clash"]);
  v = await update();
  assert.equal(v.skills.length, 2);
  assert.ok(v.source.notes[0].includes("already on this host"));
});
