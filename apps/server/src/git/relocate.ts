// Port of server/src/git/relocate.rs.
/**
 * Changing a project's repository folder: pointing the project at where its folder is now (after it was moved or renamed
 * outside the board), or moving the folder there. Either way the paths stored inside the folder (worktrees kept in it,
 * the worktrees folder) move along, the task worktrees are reconnected to the repository (`git worktree repair`), and
 * Claude conversations that ran in the old folders are copied to where Claude looks for them in the new ones, so those
 * tasks can still be resumed.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize as norm, relative as rel_path } from "node:path";
import * as db from "../db.ts";
import type { Project, Task } from "../db.ts";
import * as worktree from "./worktree.ts";
import * as worktree_files from "./worktree_files.ts";
import { ApiError } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, expand_tilde, is_git_root, path_str, sleep } from "../util.ts";
import { canonicalize, path_starts_with, same_path, strip_path_prefix } from "./worktree.ts";

/** The project's paths after its folder moved, to store. */
export interface Relocated {
  repo_path: string;
  /** The worktrees and scratch folders, when they were inside the repository folder. */
  worktrees_root: string | null;
  scratch_path: string | null;
  /** See Project.repo_root. */
  repo_root: string;
}

/** Paths inside the old folder (by the path stored or the one it really was at) and where they are now. */
class Mapping {
  from: string[];
  to: string;
  constructor(from: string[], to: string) {
    this.from = from;
    this.to = to;
  }
  map(p: string): string | null {
    for (const f of this.from) {
      const rest = strip_path_prefix(p, f);
      if (rest !== null) return rest === "" ? this.to : join(this.to, rest);
    }
    return null;
  }
}

/** Checks that `project`'s folder can change to `new_` (see change) without changing anything. */
export async function check(s: AppState, project: Project, new_: string, move_folder: boolean): Promise<void> {
  if (!isAbsolute(new_)) throw ApiError.bad(`the repository path must be absolute (got ${new_})`);
  const old = project.repo_path;
  const tasks = project_tasks(s, project.id);
  if (move_folder) return check_move(s, old, new_, tasks);
  if (!is_dir(new_)) throw ApiError.bad(`${new_} isn't a folder`);
  const n = canonical(new_);
  return check_same_repo(project, old, n, tasks, new Mapping(old_folders(old), n));
}

/** The paths `old` goes by: as stored, and where the folder really is, which is where Claude has kept the conversations run in it. */
function old_folders(old: string): string[] {
  const from = [old];
  const real = canonicalize(old);
  if (real !== null && !same_path(real, old)) from.push(real);
  return from;
}

/**
 * Changes `project`'s folder to `new_` (moving the folder there first when `move_folder`). Updates the tasks' worktree
 * paths, and returns the project's paths to store.
 */
export async function change(s: AppState, project: Project, new_: string, move_folder: boolean): Promise<Relocated> {
  await check(s, project, new_, move_folder);
  const old = project.repo_path;
  const from = old_folders(old);
  const tasks = project_tasks(s, project.id);
  if (move_folder) move_dir(old, new_);
  const n = canonical(new_);
  const mapping = new Mapping(from, n);
  // Worktrees kept inside the repository moved along with it.
  const moved: Array<[Task, string, string]> = [];
  for (const t of tasks) {
    const wt = t.worktree_path;
    if (wt == null) continue;
    const to = mapping.map(wt);
    if (to === null || same_path(to, wt)) continue;
    s.update_task(t.id, [["worktree_path", path_str(to)]]);
    moved.push([t, wt, to]);
  }
  if (is_git_root(n)) {
    // Points the worktrees' .git files at the repository's new place, and the repository at the worktrees that moved.
    const args = ["worktree", "repair", ...moved.map(([, , to]) => path_str(to))];
    try {
      const o = await worktree.git(n, args);
      if (!o.ok) console.warn(`git worktree repair in ${n}: ${o.stderr.trim()}`);
    } catch (e) {
      console.warn(`git worktree repair in ${n}: ${err_str(e)}`);
    }
    const worktrees = tasks.filter((t) => t.worktree_path != null).map((t) => mapping.map(t.worktree_path!) ?? t.worktree_path!);
    const common = (await common_dir(n)) ?? join(n, ".git");
    relink(common, mapping, worktrees);
    // The folders linked into them lead into the old folder.
    for (const wt of worktrees) await worktree_files.relink(wt, project.link_folders, (p) => mapping.map(p));
    await relink_submodules(n, common, mapping);
  }
  const inside = (p: string): string | null => {
    const to = mapping.map(p);
    return to !== null && path_str(to) !== p ? path_str(to) : null;
  };
  const scratch_path = inside(project.scratch_path);
  // Each thread's conversation, from the folder it ran in: the repository, or its worktree (a review thread's is the
  // task's it reviews).
  for (const t of tasks) {
    copy_session(s, t, mapping.from, n);
    const owner_id = t.kind === "review" ? t.parent_id : t.id;
    const owner = tasks.find((o) => owner_id != null && o.id === owner_id);
    const was = owner ? worktree_folder(project, owner) : null;
    if (was !== null) {
      const to = mapping.map(was);
      if (to !== null && !same_path(to, was)) copy_session(s, t, [was], to);
    }
  }
  // Scratch tasks that were the project's scratch chats work in its scratch folder.
  if (scratch_path !== null) {
    const chats = db.tasks_in_work_dir(s.db(), project.scratch_path);
    for (const t of chats) {
      copy_session(s, t, [project.scratch_path], scratch_path);
      s.update_task(t.id, [["work_dir", scratch_path]]);
    }
  }
  return {
    repo_path: path_str(n),
    worktrees_root: inside(project.worktrees_root),
    scratch_path,
    repo_root: await fingerprint(n),
  };
}

/** The git folder that `repo` and its worktrees share: its .git, or for a linked checkout, its main checkout's (which doesn't move with it). */
async function common_dir(repo: string): Promise<string | null> {
  try {
    const o = await worktree.git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return o.ok ? o.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** The entries of folder `dir` as paths, or none if it can't be read. */
function read_dir(dir: string): Array<{ path: string; is_dir: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ path: join(dir, e.name), is_dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * Points git's links between the worktrees and their git folder `common` (see common_dir) at where they are now when they
 * still name an old folder: older versions of `git worktree repair` leave a link alone while its old path still leads to
 * the right place (through a symlink, say).
 */
function relink(common: string, mapping: Mapping, worktrees: string[]) {
  const fix = (file: string, prefix: string) => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    const t = text.trimEnd();
    if (!t.startsWith(prefix)) return;
    const old = t.slice(prefix.length);
    const n = mapping.map(old);
    if (n === null || same_path(n, old)) return;
    try {
      writeFileSync(file, `${prefix}${n}\n`);
    } catch (e) {
      console.warn(`pointing ${file} at ${n}: ${err_str(e)}`);
    }
  };
  // Each worktree's .git file names its folder in the git folder's worktrees, and that folder's gitdir file names the
  // worktree's .git file (the project's own too, when it's a linked checkout).
  for (const wt of worktrees) fix(join(wt, ".git"), "gitdir: ");
  for (const d of read_dir(join(common, "worktrees"))) fix(join(d.path, "gitdir"), "");
}

/**
 * Reconnects the submodules checked out in the moved repository folder `repo` and its worktrees with their git folders,
 * in the git folder `common` (see common_dir). Git links the two with paths relative to each other, which no longer lead
 * there once only one of them has moved: a task worktree's submodules, whose git folders are in the repository's
 * .git/worktrees, or a linked checkout's, whose git folders stay in its main checkout's. Links that still lead to the
 * right place are left as they are.
 */
async function relink_submodules(repo: string, common: string, mapping: Mapping) {
  const modules: string[] = [];
  find_modules(join(common, "modules"), modules);
  for (const d of read_dir(join(common, "worktrees"))) find_modules(join(d.path, "modules"), modules);
  // Where the repository was, as git saw it.
  const old = mapping.from[mapping.from.length - 1];
  if (old === undefined) return;
  for (const module of modules) {
    const config = path_str(join(module, "config"));
    let wtree: string;
    try {
      const o = await worktree.git(repo, ["config", "-f", config, "--get", "core.worktree"]);
      if (!o.ok) continue;
      wtree = o.stdout.trim();
    } catch {
      continue;
    }
    // The checkout, from where the module's folder was (moved along if it's in the folder), and where it is now.
    const inside = strip_path_prefix(module, repo);
    const was = inside !== null ? join(old, inside) : module;
    let checkout = normalize(join(was, wtree));
    checkout = mapping.map(checkout) ?? checkout;
    const gitfile = join(checkout, ".git");
    let linked: string;
    try {
      const t = readFileSync(gitfile, "utf8").trimEnd();
      if (!t.startsWith("gitdir: ")) continue;
      linked = t.slice("gitdir: ".length);
    } catch {
      continue;
    }
    if (!same_path(normalize(isAbsolute(linked) ? linked : join(checkout, linked)), module)) {
      try {
        writeFileSync(gitfile, `gitdir: ${relative(checkout, module)}\n`);
      } catch (e) {
        console.warn(`pointing ${gitfile} at ${module}: ${err_str(e)}`);
      }
    }
    if (!same_path(normalize(isAbsolute(wtree) ? wtree : join(module, wtree)), checkout)) {
      const to = path_str(relative(module, checkout));
      try {
        const o = await worktree.git(repo, ["config", "-f", config, "core.worktree", to]);
        if (!o.ok) console.warn(`pointing ${module} at ${checkout}: ${o.stderr.trim()}`);
      } catch {}
    }
  }
}

/**
 * The submodules' git folders in `dir` (a .git/modules), theirs included, into `out`. A submodule's name may have
 * slashes in it, so a folder that isn't a git folder is looked in.
 */
function find_modules(dir: string, out: string[]) {
  for (const e of read_dir(dir)) {
    if (!e.is_dir) continue;
    if (is_file(join(e.path, "HEAD")) && is_file(join(e.path, "config"))) {
      find_modules(join(e.path, "modules"), out);
      out.push(e.path);
    } else find_modules(e.path, out);
  }
}

/** `path` without its `.` and `..` parts, worked out from the path alone. */
function normalize(path: string): string {
  const n = norm(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** The path to `to` from the folder `from` (both absolute and normalized). */
function relative(from: string, to: string): string {
  return rel_path(from, to);
}

/**
 * The folder a task's worktree is in, or was in before it was removed (once merged, say), which is where setting it up
 * again puts it back (see worktree.folder_name).
 */
function worktree_folder(project: Project, task: Task): string | null {
  if (task.worktree_path != null) return task.worktree_path;
  if (task.branch != null) return join(project.worktrees_root, worktree.folder_name(project, task));
  return null;
}

/** What the folder `dir` is (see Project.repo_root). */
export async function fingerprint(dir: string): Promise<string> {
  if (!is_git_root(dir)) return "";
  try {
    const o = await worktree.git(dir, ["rev-list", "--max-parents=0", "HEAD"]);
    if (o.ok && o.stdout.trim()) {
      const roots = o.stdout.split(/\s+/).filter((r) => r);
      roots.sort();
      return roots.join(" ");
    }
  } catch {}
  return "git";
}

/**
 * Whether a fingerprint is the commits a repository's history started from, which tell it apart from others (unlike
 * `git`, a repository without commits yet, or an empty one, a folder that wasn't a repository when it was looked at but
 * may be one now).
 */
export function is_history(fingerprint: string): boolean {
  return fingerprint !== "" && fingerprint !== "git";
}

/** Looks again, every hour, at what the projects' folders are (see record_fingerprints). */
export function start_recording(s: AppState) {
  const look = () => record_fingerprints(s).catch((e) => console.warn(`recording the projects' repositories: ${err_str(e)}`));
  look();
  setInterval(look, 3600 * 1000).unref();
}

/** Records `project`'s fingerprint if it doesn't have its history yet (e.g. once its folder has become a git repository, or has its first commit). */
export async function record_fingerprint(s: AppState, project: Project): Promise<void> {
  if (project.repo_root != null && is_history(project.repo_root)) return;
  if (!is_dir(project.repo_path)) return;
  const now = await fingerprint(project.repo_path);
  if (project.repo_root !== now) store_fingerprint(s, project.id, project.repo_path, now);
}

/** Records that project `id`'s folder `repo_path` is `fingerprint`, unless the project has moved to another folder meanwhile. */
function store_fingerprint(s: AppState, id: string, repo_path: string, fingerprint: string) {
  try {
    db.run(s.db(), "UPDATE projects SET repo_root=?1 WHERE id=?2 AND repo_path=?3", fingerprint, id, repo_path);
  } catch (e) {
    console.warn(`recording project ${id}'s repository: ${err_str(e)}`);
  }
}

/** Records what each project's folder is, for those whose history it doesn't have yet, while the folders are where the board expects them. */
export async function record_fingerprints(s: AppState): Promise<void> {
  let projects: Array<{ id: string; repo_path: string; repo_root: string | null }>;
  try {
    projects = db.all(s.db(), "SELECT id, repo_path, repo_root FROM projects WHERE repo_root IS NULL OR repo_root IN ('', 'git')");
  } catch {
    return;
  }
  for (const { id, repo_path, repo_root } of projects) {
    if (!is_dir(repo_path)) continue;
    const now = await fingerprint(repo_path);
    if (repo_root !== now) store_fingerprint(s, id, repo_path, now);
  }
}

/** The project's tasks and review threads. */
function project_tasks(s: AppState, project_id: string): Task[] {
  const c = s.db();
  return [...db.list_tasks_for_project(c, project_id, "task"), ...db.list_tasks_for_project(c, project_id, "review")];
}

function is_dir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function is_file(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Checks that the folder `old` can move to `new_`. */
function check_move(s: AppState, old: string, new_: string, tasks: Task[]) {
  let link = false;
  try {
    link = lstatSync(old).isSymbolicLink();
  } catch {}
  if (link) {
    const target = canonicalize(old) ?? "a missing folder";
    throw ApiError.bad(`${old} is a link to ${target}; set the repository path to the folder itself instead of moving the link`);
  }
  if (!is_dir(old)) {
    throw ApiError.bad(`${old} doesn't exist, so there's nothing to move; if the folder has already moved, set its new path without moving`);
  }
  if (existsSync(new_)) throw ApiError.bad(`${new_} already exists`);
  if (!is_dir(dirname(new_)) || same_path(dirname(new_), new_)) throw ApiError.bad(`${new_}'s parent folder doesn't exist`);
  if (path_starts_with(new_, old)) throw ApiError.bad(`${new_} is inside ${old}`);
  // Their agents are in the folder, or run git in it.
  const n = tasks.filter((t) => s.is_running(t.id)).length;
  if (n) {
    throw ApiError.conflict(`${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop ${n === 1 ? "it" : "them"} before moving its folder`);
  }
}

/** Moves the folder `old` to `new_` (see check_move). */
function move_dir(old: string, new_: string) {
  try {
    renameSync(old, new_);
  } catch (e) {
    const hint = e.code === "EXDEV" ? " (it's on another filesystem: move it yourself, then set the new path)" : "";
    throw ApiError.bad(`moving ${old} to ${new_}: ${e.message}${hint}`);
  }
}

/**
 * Checks that `new_` is the project's repository (after it was moved there, or by another path to it), so its tasks'
 * worktrees and branches are still there and its agents work on it.
 */
async function check_same_repo(project: Project, old: string, new_: string, tasks: Task[], mapping: Mapping): Promise<void> {
  if (same_dir(old, new_)) return;
  const not_it = (why: string) => ApiError.bad(`${new_} doesn't look like the project's repository: ${why}`);
  if (existsSync(old) && is_git_root(old)) {
    // The folder is still there, so it hasn't moved, and `new_` (which isn't it, or a link to it) is another folder, even
    // if it's a checkout of the same repository.
    throw ApiError.bad(`${new_} isn't the project's repository folder, which is still at ${project.repo_path}`);
  }
  // The folder has moved: the repository there has the project's worktrees (those kept inside it moved along, and it
  // still knows them by their old paths)…
  const worktrees = tasks
    .map((t) => t.worktree_path)
    .filter((wt): wt is string => wt != null)
    .filter((wt) => existsSync(wt) || (() => {
      const to = mapping.map(wt);
      return to !== null && existsSync(to);
    })());
  if (worktrees.length) {
    if (!is_git_root(new_)) throw not_it("it isn't a git repository");
    const listed = await worktree_list(new_);
    // By its old path, or its new one if it has been repaired already.
    const known = (wt: string) => {
      const to = mapping.map(wt);
      return listed.has(canonical(wt)) || listed.has(wt) || (to !== null && listed.has(canonical(to)));
    };
    const missing = worktrees.filter((wt) => !known(wt));
    if (!missing.length) return;
    const s = missing.length === 1 ? "" : "s";
    throw not_it(`it doesn't have the task worktree${s} ${missing.join(", ")}`);
  }
  // …or the history it started from…
  const roots = project.repo_root;
  if (roots != null && is_history(roots)) {
    if (!is_git_root(new_)) throw not_it("it isn't a git repository, and the project's was");
    const theirs = await fingerprint(new_);
    if (!is_history(theirs)) throw not_it("it has no commits, and the project's repository had");
    const ours = theirs.split(" ");
    if (roots.split(" ").some((r) => ours.includes(r))) return;
    // A shallow clone's history starts where it was cut off, which is no root once the rest is fetched: the commit is in
    // the history all the same.
    for (const r of roots.split(" ")) {
      try {
        if ((await worktree.git(new_, ["merge-base", "--is-ancestor", r, "HEAD"])).ok) return;
      } catch {}
    }
    throw not_it("it has none of the commits the project's history started from");
  }
  // …or, when the board doesn't know its history, its tasks' branches.
  const branches = [...new Set(tasks.map((t) => t.branch).filter((b): b is string => b != null))];
  if (!branches.length) {
    const fix = existsSync(old)
      ? "To move the project's folder, move it with the board to a path that doesn't exist yet; to use that folder, add it as a new project"
      : "Move the folder back and move it with the board instead, or add it as a new project";
    throw ApiError.bad(
      `can't tell whether ${new_} is the same folder as the project's (${project.repo_path}): the board has no record of its git history. ${fix}`,
    );
  }
  for (const b of branches) {
    try {
      if ((await worktree.git(new_, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).ok) return;
    } catch {}
  }
  throw not_it("it has none of its tasks' branches");
}

function canonical(p: string): string {
  return canonicalize(p) ?? p;
}

function same_dir(a: string, b: string): boolean {
  const x = canonicalize(a), y = canonicalize(b);
  return x !== null && y !== null && x === y;
}

/** The worktrees registered in `repo`. */
export async function worktree_list(repo: string): Promise<Set<string>> {
  let o;
  try {
    o = await worktree.git(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    return new Set();
  }
  return new Set(
    worktree
      .lines(o.stdout)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => canonical(l.slice("worktree ".length))),
  );
}

/**
 * Claude Code keeps a conversation under its config's `projects/<folder>`, named after the folder it ran in, and only
 * resumes it from there. Copies the thread's, if it ran in one of `from`, to `to`'s, leaving the original. A copy there
 * from before (the project was there before, and has since carried on elsewhere) is brought up to date.
 */
function copy_session(s: AppState, t: Task, from: string[], to: string) {
  const sid = t.session_id;
  if (sid == null) return;
  const c = s.db();
  let dir: string | null = null, codex = false;
  try {
    dir = db.task_config_dir(c, t) ?? null;
  } catch {}
  try {
    codex = db.task_is_codex(c, t);
  } catch {}
  if (codex) return;
  const projects = join(config_dir(dir), "projects");
  const dest = join(projects, claude_project_dir(to));
  for (const f of from) {
    const src = join(projects, claude_project_dir(f));
    if (src === dest || !existsSync(join(src, `${sid}.jsonl`))) continue;
    // The transcript, and its folder of subagents' transcripts and tool results.
    for (const name of [`${sid}.jsonl`, sid]) {
      const a = join(src, name), b = join(dest, name);
      if (!existsSync(a)) continue;
      try {
        copy_newer(a, b);
      } catch (e) {
        console.warn(`copying ${a} to ${b}: ${err_str(e)}`);
      }
    }
    return;
  }
}

function config_dir(dir: string | null): string {
  if (dir !== null) return expand_tilde(dir);
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env !== undefined ? expand_tilde(env) : expand_tilde("~/.claude");
}

/** The name of the folder Claude Code keeps the conversations run in `cwd` in. */
export function claude_project_dir(cwd: string): string {
  return [...path_str(cwd)].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c : "-")).join("");
}

/**
 * Copies the files in `from` that `to` doesn't have, or has an older copy of. Copies keep their original's time, so one
 * that hasn't changed on either side since isn't copied again.
 */
function copy_newer(from: string, to: string) {
  if (is_dir(from)) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) copy_newer(join(from, e), join(to, e));
    return;
  }
  const st = statSync(from);
  try {
    if (statSync(to).mtimeMs >= st.mtimeMs) return;
  } catch {}
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  utimesSync(to, statSync(to).atimeMs / 1000, st.mtimeMs / 1000);
}

/** The projects whose folders are moving, and those being worked in in ways that keep them where they are (see Holding). */
export class Relocations {
  moving = new Set<string>();
  holds = new Map<string, number>();
}

/**
 * Marks a project's folder as moving until it's dropped (`drop()`), while project_changes is held, so agents of the
 * project wait to start until the project says where it is now (see settled).
 */
export class Moving {
  s: AppState;
  project_id: string;
  private done = false;
  constructor(s: AppState, project_id: string) {
    this.s = s;
    this.project_id = project_id;
  }
  drop() {
    if (this.done) return;
    this.done = true;
    this.s.relocating.moving.delete(this.project_id);
  }
  [Symbol.dispose]() {
    this.drop();
  }
}

/** `Moving::new`: refused while a Holding keeps the folder where it is. */
export function Moving_new(s: AppState, project_id: string): Moving {
  const r = s.relocating;
  if ((r.holds.get(project_id) ?? 0) > 0) {
    throw ApiError.conflict("one of the project's task worktrees is being set up; move its folder once that's done");
  }
  r.moving.add(project_id);
  return new Moving(s, project_id);
}

/** Keeps a project's folder where it is until it's dropped (`drop()`): a task's worktree is being set up in it, and stored once it is. */
export class Holding {
  s: AppState;
  project_id: string;
  private done = false;
  constructor(s: AppState, project_id: string) {
    this.s = s;
    this.project_id = project_id;
  }
  drop() {
    if (this.done) return;
    this.done = true;
    const r = this.s.relocating;
    const n = r.holds.get(this.project_id);
    if (n !== undefined) {
      if (n <= 1) r.holds.delete(this.project_id);
      else r.holds.set(this.project_id, n - 1);
    }
  }
  [Symbol.dispose]() {
    this.drop();
  }
}

/** Holds project `project_id`'s folder where it is (see Holding), once a move under way is done. */
export async function hold(s: AppState, project_id: string): Promise<Holding> {
  for (;;) {
    await settled(s, project_id);
    const r = s.relocating;
    if (!r.moving.has(project_id)) {
      r.holds.set(project_id, (r.holds.get(project_id) ?? 0) + 1);
      return new Holding(s, project_id);
    }
    // Still moving (marked before project_changes was taken, say): not a busy loop on the event loop.
    await sleep(10);
  }
}

/**
 * Waits while project `project_id`'s folder is moving, so what's read of the project afterwards says where it is. An
 * agent that started before is running, so the folder won't move from under it (see check_move).
 */
export async function settled(s: AppState, project_id: string): Promise<void> {
  if (s.relocating.moving.has(project_id)) (await s.project_changes.lock())();
}
