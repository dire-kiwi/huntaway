// Port of server/src/disk.rs.
/**
 * Disk usage analytics: how much space each project's repository, task worktrees, scratch folders and agents' runs take
 * up on this host, and the database.
 *
 * Sizes are what the files take on disk (allocated blocks, like `du`), each hard-linked file counted once per folder.
 * Nothing is cached: the folders are walked when the report is asked for. (The Rust server walks several at a time on
 * threads; this walks them one after another, synchronously, in a worker thread.)
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, type Stats } from "node:fs";
import { join, normalize } from "node:path";
import * as db from "./db.ts";
import type { Conn, Project } from "./db.ts";
import type { Req } from "./http.ts";
import type { AppState } from "./state.ts";
import { path_str } from "./util.ts";
import * as runs from "./agent/runs.ts";
import { in_worker } from "./worker.ts";
import { backup_dir } from "./backup.ts";

export interface Size {
  bytes: number;
  files: number;
}

const Size_default = (): Size => ({ bytes: 0, files: 0 });
const add = (a: Size, b: Size): Size => ({ bytes: a.bytes + b.bytes, files: a.files + b.files });

export interface Worktree {
  /** Null for a worktree of the project's repository in its worktrees folder that no task or project on the host has (left behind by a failed teardown, say). */
  task_id: string | null;
  kind: string | null;
  number: number | null;
  title: string | null;
  status: string | null;
  path: string;
  size: Size;
}

export interface ProjectUsage {
  id: string;
  name: string;
  key: string;
  repo_path: string;
  /** The repository folder, worktrees and the data dir inside it aside. Null when it's gone. */
  repo: Size | null;
  /** The part of `repo` in its `.git` folder. */
  git: Size | null;
  /** Biggest first. */
  worktrees: Worktree[];
  /** The project's scratch folder and the rest of its folder in the data dir. */
  other: Size;
  /** The folders of its tasks' runs (see agent/runs.ts), kept `runs.KEEP_DAYS` after they finish (API 59). */
  runs: Size;
}

export interface Filesystem {
  total: number;
  free: number;
}

export interface Report {
  projects: ProjectUsage[];
  /** The profile's own scratch folder (scratch chats and group tasks). */
  scratch: Size;
  /** The folders of the runs of the profile's tasks in no project (API 59). */
  runs: Size;
  /** How many days a finished run's folder is kept (API 59). */
  runs_kept_days: number;
  /** What the host's database takes up, all profiles' data together (API 59). */
  database: number | null;
  /** What the database's backups take up (`<data dir>/backups`, see backup.ts), null when there are none (HA-184). */
  backups: Size | null;
  /** The disk the data dir (and so, usually, the worktrees) is on. */
  filesystem: Filesystem | null;
  elapsed_ms: number;
}

/**
 * `GET /profiles/{id}/disk-usage`: the profile's projects' disk usage on this host. The folders are walked on a thread of
 * their own (see worker.ts), as that takes seconds on a big board (HA-183: 6 s on the live board's), and would hold up
 * every other request meanwhile.
 */
export async function get(s: AppState, r: Req): Promise<any> {
  const rows = read(s.db(), r.params.id);
  return await in_worker<Report>(new URL(import.meta.url), "report", [rows, s.data_dir]);
}

/** The report for `rows`: `plan` and `measure` them (run by `get` in a worker). */
export function report(rows: Rows, data_dir: string): Report {
  return measure(plan(rows, data_dir), data_dir);
}

/** A folder to measure, leaving out the folders under it that are measured on their own. */
interface Walk {
  root: string;
  skip: string[];
}

const walk_key = (w: Walk) => JSON.stringify([w.root, w.skip]);

interface TaskRow {
  id: string;
  kind: string;
  number: number;
  title: string;
  status: string;
  path: string;
}

interface ProjectPlan {
  project: Project;
  repo: Walk;
  git: Walk;
  tasks: TaskRow[];
  /** Worktrees of the repository in the worktrees folder that nothing on the host has. */
  stray: string[];
  other: Walk[];
  runs: string[];
}

/** What `plan` needs from the database. */
export interface Rows {
  /** The worktrees of all tasks on the host, and all projects' repositories. */
  owned: string[];
  /** The profile's runs, with their tasks' projects. */
  runs: Array<[string, string | null]>;
  /** The profile's projects, in the order analytics lists them, with their tasks that have worktrees. */
  projects: Array<[Project, TaskRow[]]>;
  profile_id: string;
  /** The main database's file (blank in memory). */
  database: string;
}

export interface Plan {
  projects: ProjectPlan[];
  scratch: Walk;
  /** The runs of the profile's tasks in no project. */
  runs: string[];
  /** The database's files. */
  database: string[];
}

/** A path as Rust's `PathBuf` compares it: `.` parts, doubled and trailing slashes don't count. */
function clean(p: string): string {
  const n = normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const i = clean(inner), o = clean(outer);
  return i === o || i.startsWith(o === "/" ? "/" : `${o}/`);
}

/** The folders under `root` (not `root` itself) among `others`. */
function nested(root: string, others: string[]): string[] {
  const v = others.filter((o) => within(o, root) && clean(o) !== clean(root)).map(clean);
  return [...new Set(v)].sort();
}

/** Reads what `plan` needs from the database. */
export function read(c: Conn, profile_id: string): Rows {
  // Folders a task or project on this host has, whatever its profile: the worktrees folder is a setting, so projects can
  // share one (or point it at the folder their repos are in).
  const owned = db
    .all(c, "SELECT worktree_path AS p FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path<>'' UNION SELECT repo_path FROM projects")
    .map((r) => r.p as string);
  const run_rows = db
    .all(c, "SELECT r.id, t.project_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.profile_id=?1", profile_id)
    .map((r) => [r.id, r.project_id ?? null] as [string, string | null]);
  const list = db.list_projects(c, profile_id);
  // In the order analytics lists them, which the UI's colours follow.
  list.sort((a: Project, b: Project) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const projects: Array<[Project, TaskRow[]]> = list.map((p: Project) => {
    const tasks = db
      .all(
        c,
        `SELECT id, kind, number, title, status, worktree_path FROM tasks
         WHERE project_id=?1 AND worktree_path IS NOT NULL AND worktree_path<>'' ORDER BY number`,
        p.id,
      )
      .map((r) => ({ id: r.id, kind: r.kind, number: r.number, title: r.title, status: r.status, path: r.worktree_path }));
    return [p, tasks] as [Project, TaskRow[]];
  });
  const database = db.value<string>(c, "SELECT file FROM pragma_database_list WHERE name='main'") ?? "";
  return { owned, runs: run_rows, projects, profile_id, database };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Works out what to walk, from what's in the database and the worktrees folders' listings. */
export function plan(rows: Rows, data_dir: string): Plan {
  const owned = new Set(rows.owned.map(canonical));
  // Each run's folder, by its task's project.
  const by_project = new Map<string | null, string[]>();
  for (const [id, project] of rows.runs) {
    const dir = join(data_dir, "runs", id);
    if (isDir(dir)) {
      if (!by_project.has(project)) by_project.set(project, []);
      by_project.get(project)!.push(dir);
    }
  }
  const take = (k: string | null) => {
    const v = by_project.get(k) ?? [];
    by_project.delete(k);
    return v;
  };
  const projects: ProjectPlan[] = [];
  for (const [p, all_tasks] of rows.projects) {
    const tasks = all_tasks.filter((t) => isDir(t.path));
    const worktrees_root = p.worktrees_root;
    const repo = p.repo_path;
    const common = git_common_dir(repo);
    let stray: string[] = [];
    if (common !== null) {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(worktrees_root, { withFileTypes: true });
      } catch {}
      stray = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(worktrees_root, e.name))
        .filter((d) => !owned.has(canonical(d)) && is_linked_worktree_of(d, common));
    }
    stray.sort();

    const project_dir = join(data_dir, "projects", p.id);
    const scratch = p.scratch_path;
    const wt_paths = [...tasks.map((t) => t.path), ...stray];
    // Everything measured on its own, so the folders that hold them leave them out.
    const separate = [...wt_paths, worktrees_root, data_dir, project_dir, scratch];
    const git_dir = join(repo, ".git");
    const repo_skip = nested(repo, separate);
    repo_skip.push(clean(git_dir));
    const in_project_dir = [...wt_paths, worktrees_root];
    const other: Walk[] = [{ root: project_dir, skip: nested(project_dir, in_project_dir) }];
    if (!within(scratch, project_dir)) other.push({ root: scratch, skip: nested(scratch, wt_paths) });
    projects.push({
      repo: { root: repo, skip: repo_skip },
      git: { root: git_dir, skip: nested(git_dir, separate) },
      tasks,
      stray,
      other,
      runs: take(p.id),
      project: p,
    });
  }
  const scratch = join(data_dir, "profiles", rows.profile_id, "scratch");
  // The main database's file (none in memory), and its write-ahead log.
  const file = rows.database;
  const database = file === "" ? [] : [file, `${file}-wal`];
  return { projects, scratch: { root: scratch, skip: [] }, runs: take(null), database };
}

/** The path with symlinks resolved, or as given when it can't be. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return clean(p);
  }
}

/** The git dir of the checkout at `dir`: its `.git` folder, or where its `.git` file points. */
function git_dir(dir: string): string | null {
  const dot_git = join(dir, ".git");
  let meta: Stats;
  try {
    meta = lstatSync(dot_git);
  } catch {
    return null;
  }
  try {
    if (meta.isDirectory()) return realpathSync(dot_git);
    const text = readFileSync(dot_git, "utf8");
    const line = text.split("\n").find((l) => l.replace(/\r$/, "").startsWith("gitdir:"));
    if (line === undefined) return null;
    const target = line.replace(/\r$/, "").slice(7).trim();
    return realpathSync(target.startsWith("/") ? target : join(dir, target));
  } catch {
    return null;
  }
}

/** The repository's own git dir (the one its linked worktrees share), from a checkout's git dir. */
function common_dir(git_dir: string): string {
  try {
    const c = readFileSync(join(git_dir, "commondir"), "utf8").trim();
    return canonical(c.startsWith("/") ? c : join(git_dir, c));
  } catch {
    return git_dir;
  }
}

function git_common_dir(repo: string): string | null {
  const d = git_dir(repo);
  return d === null ? null : common_dir(d);
}

/** `dir` is a linked worktree (not a main checkout) of the repository whose git dir is `common`. */
function is_linked_worktree_of(dir: string, common: string): boolean {
  const g = git_dir(dir);
  return g !== null && within(g, join(common, "worktrees")) && common_dir(g) === common;
}

/** Walks every folder in the plan. */
export function measure(plan: Plan, data_dir: string): Report {
  const started = Date.now();
  const leaf = (root: string): Walk => ({ root, skip: [] });
  const walks: Walk[] = [plan.scratch];
  for (const p of plan.projects) {
    walks.push(p.repo, p.git, ...p.tasks.map((t) => leaf(t.path)), ...p.stray.map(leaf), ...p.other, ...p.runs.map(leaf));
  }
  walks.push(...plan.runs.map(leaf));
  const sizes = walk_all(walks);
  const size = (w: Walk) => sizes.get(walk_key(w)) ?? null;
  const runs_size = (dirs: string[]) => dirs.map((d) => size(leaf(d))).filter((s): s is Size => s !== null).reduce(add, Size_default());

  const projects: ProjectUsage[] = plan.projects.map((p) => {
    const git = size(p.git);
    const worktrees: Worktree[] = [
      ...p.tasks.map((t) => ({
        task_id: t.id,
        kind: t.kind,
        number: t.number,
        title: t.title,
        status: t.status,
        path: path_str(t.path),
        size: size(leaf(t.path)) ?? Size_default(),
      })),
      ...p.stray.map((s) => ({ task_id: null, kind: null, number: null, title: null, status: null, path: path_str(s), size: size(leaf(s)) ?? Size_default() })),
    ];
    worktrees.sort((a, b) => b.size.bytes - a.size.bytes);
    const repo = size(p.repo);
    return {
      id: p.project.id,
      name: p.project.name,
      key: p.project.key,
      repo_path: p.project.repo_path,
      repo: repo !== null ? add(repo, git ?? Size_default()) : null,
      git,
      worktrees,
      other: p.other.map(size).filter((s): s is Size => s !== null).reduce(add, Size_default()),
      runs: runs_size(p.runs),
    };
  });
  let database: number | null = null;
  if (plan.database.length) {
    database = 0;
    for (const f of plan.database) {
      try {
        database += allocated(statSync(f));
      } catch {}
    }
  }
  return {
    projects,
    scratch: size(plan.scratch) ?? Size_default(),
    runs: runs_size(plan.runs),
    runs_kept_days: runs.KEEP_DAYS,
    database,
    backups: dir_size(backup_dir(data_dir), []),
    filesystem: filesystem(data_dir),
    elapsed_ms: Date.now() - started,
  };
}

/** Sizes of each distinct walk (by `walk_key`), null for a folder that isn't there. */
function walk_all(walks: Walk[]): Map<string, Size | null> {
  const out = new Map<string, Size | null>();
  for (const w of walks) {
    const k = walk_key(w);
    if (!out.has(k)) out.set(k, dir_size(w.root, w.skip));
  }
  return out;
}

/** What `root` takes up on disk, leaving out `skip` (and what's under it). Symlinks aren't followed; unreadable folders count as empty. */
export function dir_size(root: string, skip: string[]): Size | null {
  try {
    if (!lstatSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const skipped = new Set(skip.map(clean));
  const seen = new Set<string>();
  const total = Size_default();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      let m: Stats;
      try {
        m = lstatSync(p);
      } catch {
        continue;
      }
      if (m.isDirectory()) {
        if (!skipped.has(clean(p))) stack.push(p);
        total.bytes += allocated(m);
        continue;
      }
      // A hard link to a file already counted isn't counted again.
      if (m.nlink > 1) {
        const id = `${m.dev}:${m.ino}`;
        if (seen.has(id)) continue;
        seen.add(id);
      }
      total.bytes += allocated(m);
      total.files += 1;
    }
  }
  return total;
}

function allocated(m: Stats): number {
  return m.blocks * 512;
}

function filesystem(dir: string): Filesystem | null {
  try {
    const st = statfsSync(dir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}
