// Port of server/src/git/git_view.rs.
//
// The Changes tab, a lazygit-style view of a task's repository (API 66): the working tree's files, the commits on the
// task's branch and the stashes, the diff of a file, commit or stash, and what can be done from there: staging and
// unstaging whole files or chosen lines (a patch the UI makes from a file's diff, applied to the index), discarding,
// committing, amending, stashing and resetting. Everything runs at the top of the folder `worktree::diff` shows: the
// task's worktree once it's ready, else its project's repository.
//
// A project's folder may be only part of a repository (a subfolder of a monorepo, or of a home folder kept as a
// dotfiles repository). Then the view is of that folder's files and the commits that touch them, staging and
// discarding is of its files only, and what would act on the whole repository (committing what's staged outside it,
// amending, stashing and resetting) is refused.
import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project, Task } from "../db.ts";
import * as worktree from "./worktree.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { context, err_str, path_str, truncate } from "../util.ts";

/** Past this a file's diff isn't sent, and only the whole file can be staged. */
const MAX_DIFF = 4 << 20;
/** Files listed at most (an untracked folder that should have been ignored can hold many). */
const MAX_FILES = 5000;
/** Commits listed on the branch, and from its base before it. */
const MAX_COMMITS = 300;
const BASE_COMMITS = 30;

/** What a git command did. Its output is decoded lossily, so `utf8` says whether it was text a patch can be made from. */
interface Out {
  ok: boolean;
  stdout: string;
  stderr: string;
  utf8: boolean;
}

/** Runs git in `dir` with paths unquoted and no editor, with `input` on its stdin. */
function run(dir: string, args: string[], input: string | null): Promise<Out> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      // Polling the status mustn't take the index lock an agent's git command may want.
      GIT_OPTIONAL_LOCKS: "0",
    };
    const child = spawn("git", ["-C", dir, "-c", "core.quotePath=false", ...args], {
      env,
      stdio: [input !== null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => reject(context("failed to run git", e)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out);
      resolve({ ok: code === 0, stdout: stdout.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), utf8: isUtf8(stdout) });
    });
    if (input !== null) {
      // Git may stop reading early (a bad patch); what it says about it is what matters.
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

/** Git's own message for a command that failed (a 409: the repository isn't in a state for it). */
function failed(o: Out): ApiError {
  const msg = [o.stderr.trim(), o.stdout.trim()].find((m) => m !== "") ?? "git failed";
  return ApiError.conflict(msg);
}

/** `run`, failing with git's own message when git does. */
async function run_ok(dir: string, args: string[], input: string | null): Promise<string> {
  const o = await run(dir, args, input);
  if (!o.ok) throw failed(o);
  return o.stdout;
}

/** Rust's `str::lines`. */
function lines(s: string): string[] {
  const ls = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  return ls;
}

/** Rust's `str::splitn`. */
function splitn(s: string, n: number, sep: string): string[] {
  const parts: string[] = [];
  let rest = s;
  while (parts.length < n - 1) {
    const k = rest.indexOf(sep);
    if (k < 0) break;
    parts.push(rest.slice(0, k));
    rest = rest.slice(k + sep.length);
  }
  parts.push(rest);
  return parts;
}

/** `str::parse::<i64>()`, or 0. */
function parse_int(s: string): number {
  return /^[+-]?\d+$/.test(s) ? Number(s) : 0;
}

/** The task's changes: the top of the working tree they're in, and the folder, task and project it's for. */
interface Repo {
  top: string;
  dir: string;
  /** Where `dir` is from `top` (`web/`, with its slash) when it isn't the top: the view is of it only. */
  folder: string | null;
  task: Task;
  project: Project;
}

/** Refuses what would act on the whole repository when the project's folder is only part of it. */
function whole_repo(repo: Repo, what: string) {
  if (repo.folder !== null) {
    throw ApiError.conflict(
      `${what} would act on the whole repository at ${repo.top}, and the project's folder is only its ${repo.folder} folder: do it in a terminal there`,
    );
  }
}

/** Checks paths from the top of the repository: in it, and in the project's folder. */
function check_paths(repo: Repo, paths: string[]) {
  for (const p of paths) {
    check_path(p);
    const f = repo.folder;
    if (f !== null && !(p.startsWith(f) || p === f.replace(/\/+$/, ""))) throw ApiError.bad(`${p} isn't in the project's folder (${f})`);
  }
}

/** The paths, or (none given) every file in the view. */
function or_all(repo: Repo, paths: string[]): string[] {
  return repo.folder !== null && paths.length === 0 ? [repo.folder] : [...paths];
}

/** The task's working tree, if it's in one. */
async function repo(s: AppState, task_id: string): Promise<Repo | null> {
  let found: [string, Task, Project];
  try {
    found = worktree.changes_dir(s, task_id);
  } catch (e) {
    throw new ApiError(404, err_str(e));
  }
  const [dir, task, project] = found;
  const o = await run(dir, ["rev-parse", "--show-toplevel", "--show-prefix"], null);
  if (!o.ok) return null;
  const ls = lines(o.stdout);
  const top = ls[0] ?? "";
  const folder = ls[1] ? ls[1] : null;
  return { top, dir, folder, task, project };
}

async function top(s: AppState, task_id: string): Promise<Repo> {
  const r = await repo(s, task_id);
  if (!r) throw ApiError.bad("not a git repository");
  return r;
}

/** A path in the repository, from its top: not absolute and not leaving it. */
export function check_path(p: string) {
  if (p === "" || p.startsWith("/") || p.split("/").some((c) => c === "..")) throw ApiError.bad(`not a path in the repository: ${p}`);
}

/** A commit given by its hash (so never taken for an option or a path). */
export function check_rev(rev: string) {
  if (rev.length < 4 || rev.length > 64 || !/^[0-9a-fA-F]+$/.test(rev)) throw ApiError.bad(`not a commit hash: ${rev}`);
}

export interface Status {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: any[];
  truncated: boolean;
}

/**
 * `git status --porcelain=v2 -z --branch`. Each file has its index (`x`) and working tree (`y`) state as
 * `git status --short` shows them: `M`, `A`, `D`, `R`, `C`, `T`, a space for unchanged, `??` for untracked, and the two
 * sides of a conflict (`UU`, `AA`, …).
 */
export function parse_status(out: string): Status {
  const st: Status = { head: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [], truncated: false };
  const recs = out.split("\0");
  const side = (c: string) => (c === "." ? " " : c);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.startsWith("# ")) {
      const h = rec.slice(2);
      const sp = h.indexOf(" ");
      const [k, v] = sp >= 0 ? [h.slice(0, sp), h.slice(sp + 1)] : [h, ""];
      if (k === "branch.oid" && v !== "(initial)") st.head = v;
      else if (k === "branch.head" && v !== "(detached)") st.branch = v;
      else if (k === "branch.upstream") st.upstream = v;
      else if (k === "branch.ab") {
        for (const n of v.split(" ")) {
          if (n.startsWith("+")) st.ahead = parse_u32(n.slice(1));
          else if (n.startsWith("-")) st.behind = parse_u32(n.slice(1));
        }
      }
      continue;
    }
    // Ordinary (1), renamed or copied (2, followed by the path it came from), unmerged (u), untracked (?).
    let xy: string,
      path: string,
      orig: string | null = null;
    const field = (n: number) => {
      const parts = splitn(rec, n, " ");
      return parts.length >= 3 ? [parts[1], parts[parts.length - 1]] : null;
    };
    const first = rec[0];
    if (first === "1" || first === "2" || first === "u") {
      const f = field(first === "1" ? 9 : first === "2" ? 10 : 11);
      if (!f) continue;
      [xy, path] = f;
      if (first === "2") orig = i + 1 < recs.length ? recs[++i] : null;
    } else if (first === "?") {
      [xy, path] = ["??", rec.slice(2)];
    } else continue;
    if (st.files.length >= MAX_FILES) {
      st.truncated = true;
      continue;
    }
    const c = Array.from(xy);
    st.files.push({ path, orig_path: orig, x: side(c[0] ?? " "), y: side(c[1] ?? " ") });
  }
  return st;
}

function parse_u32(s: string): number {
  return /^\+?\d+$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : 0;
}

function parse_log(out: string, on_branch: boolean, unpushed: Set<string>): any[] {
  const commits: any[] = [];
  for (const l of lines(out)) {
    const parts = splitn(l, 4, "\x1f");
    if (parts.length !== 4) continue;
    const [sha, author, time, subject] = parts;
    commits.push({ sha, author, time: parse_int(time), subject, on_branch, unpushed: unpushed.has(sha) });
  }
  return commits;
}

const LOG_FORMAT = "--format=%H%x1f%an%x1f%at%x1f%s";

/** The commits on the branch since `merge_base`, then a few from before it; without one, the latest. */
async function commits(dir: string, merge_base: string | null, upstream: boolean, folder: string | null): Promise<any[]> {
  const max = String(MAX_COMMITS);
  const unpushed_out = upstream ? (await run(dir, ["rev-list", "-n", max, "@{upstream}..HEAD"], null)).stdout : "";
  const unpushed = new Set(lines(unpushed_out));
  const log = async (range: string, n: number) => {
    const args = ["--literal-pathspecs", "log", "--no-show-signature", LOG_FORMAT, "-n", String(n), range, "--"];
    if (folder !== null) args.push(folder);
    const o = await run(dir, args, null);
    return o.ok ? o.stdout : "";
  };
  if (merge_base !== null) {
    const all = parse_log(await log(`${merge_base}..HEAD`, MAX_COMMITS), true, unpushed);
    all.push(...parse_log(await log(merge_base, BASE_COMMITS), false, unpushed));
    return all;
  }
  return parse_log(await log("HEAD", MAX_COMMITS), false, unpushed);
}

async function stashes(dir: string): Promise<any[]> {
  const out = (await run(dir, ["stash", "list", "--no-show-signature", "--format=%H%x1f%ct%x1f%gs"], null)).stdout;
  const list: any[] = [];
  lines(out).forEach((l, index) => {
    const parts = splitn(l, 3, "\x1f");
    if (parts.length !== 3) return;
    const [sha, time, subject] = parts;
    list.push({ index, sha, time: parse_int(time), subject });
  });
  return list;
}

/** What the repository is in the middle of, if anything. */
async function repo_state(dir: string): Promise<string | null> {
  let o: Out;
  try {
    o = await run(dir, ["rev-parse", "--absolute-git-dir"], null);
  } catch {
    return null;
  }
  if (!o.ok) return null;
  const git_dir = o.stdout.trim();
  const states: Array<[string, string]> = [
    ["rebase-merge", "rebasing"],
    ["rebase-apply", "rebasing"],
    ["MERGE_HEAD", "merging"],
    ["CHERRY_PICK_HEAD", "cherry-picking"],
    ["REVERT_HEAD", "reverting"],
  ];
  return states.find(([f]) => existsSync(join(git_dir, f)))?.[1] ?? null;
}

// ---------- request parsing (axum's Query and Json extractors) ----------

/** A query string's bool (serde's: `true` or `false`), with its default. */
function query_bool(q: Record<string, string>, key: string): boolean {
  const v = q[key];
  if (v === undefined) return false;
  if (v === "true") return true;
  if (v === "false") return false;
  throw ApiError.bad(`Failed to deserialize query string: ${key}: provided string was not \`true\` or \`false\``);
}

function query_str(q: Record<string, string>, key: string): string {
  const v = q[key];
  if (v === undefined) throw ApiError.bad(`Failed to deserialize query string: missing field \`${key}\``);
  return v;
}

/** The JSON body, as an object. */
function body(r: Req): any {
  if (r.body === null || typeof r.body !== "object" || Array.isArray(r.body)) {
    throw new ApiError(422, "Failed to deserialize the JSON body into the target type: invalid type: expected a struct");
  }
  return r.body;
}

function missing(field: string): ApiError {
  return new ApiError(422, `Failed to deserialize the JSON body into the target type: missing field \`${field}\``);
}

function invalid(field: string, expected: string): ApiError {
  return new ApiError(422, `Failed to deserialize the JSON body into the target type: ${field}: invalid type: expected ${expected}`);
}

/** A body field: `undefined` when it's missing (and `def` is given), else checked to be of its type. */
function field<T>(b: any, key: string, kind: "string" | "boolean" | "number" | "array", def?: T): T {
  const v = b[key];
  if (v === undefined || (v === null && def !== undefined && kind !== "string")) {
    if (def === undefined) throw missing(key);
    return def;
  }
  const ok = kind === "array" ? Array.isArray(v) && v.every((p: any) => typeof p === "string") : typeof v === kind;
  if (!ok) throw invalid(key, kind === "array" ? "a sequence of strings" : `a ${kind}`);
  return v;
}

/** `GET /tasks/{id}/git`: the files with changes, the branch, its commits and the stashes. */
export async function status(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  const found = await repo(s, id);
  if (!found) return { available: false, reason: "not a git repository" };
  const { top, dir, folder, task, project } = found;
  const args = ["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--"];
  if (folder !== null) args.push(folder);
  const out = await run_ok(top, args, null);
  const st = parse_status(out);
  const [base_branch, merge_base] = await worktree.changes_base(s, dir, task, project);
  const list = st.head !== null ? await commits(top, merge_base, st.upstream !== null, folder) : [];
  // The repository's stashes aren't the folder's, and can't be used from here.
  const stash_list = folder !== null ? [] : await stashes(top);
  return {
    available: true,
    dir: path_str(top),
    folder,
    head: st.head,
    branch: st.branch,
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
    base: base_branch,
    merge_base,
    state: await repo_state(top),
    files: st.files,
    truncated: st.truncated,
    commits: list,
    stashes: stash_list,
  };
}

const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * `GET /tasks/{id}/git/diff?path=&staged=&untracked=`: a file's (or folder's) unstaged or staged changes, without
 * rename detection, for the UI to make patches of chosen lines from. A diff that isn't UTF-8 (a file in another
 * encoding) comes as a `preview` with `not_utf8` and no `patch`: a patch made from it would have U+FFFD where its other
 * bytes were, and `git apply` would write those into the file wherever they're in added lines, so such a file is only
 * staged or discarded whole.
 *
 * `staged`: the index against HEAD, rather than the working tree against the index. `untracked`: an untracked file, as
 * if it were added.
 */
export async function diff(s: AppState, r: Req): Promise<any> {
  const path = query_str(r.query, "path");
  const staged = query_bool(r.query, "staged");
  const untracked = query_bool(r.query, "untracked");
  const rp = await top(s, r.params.id);
  check_paths(rp, [path]);
  const t = rp.top;
  const args = ["--literal-pathspecs", "diff", ...DIFF_ARGS];
  let o: Out;
  if (untracked) {
    args.push("--no-index", "--", "/dev/null", path);
    o = await run(t, args, null);
  } else {
    args.push("--no-renames");
    if (staged) args.push("--cached");
    args.push("--", path);
    o = await run(t, args, null);
  }
  // `--no-index` exits 1 when there's a difference.
  if (!o.ok && !(untracked && o.stdout !== "")) throw failed(o);
  if (Buffer.byteLength(o.stdout) > MAX_DIFF) return { patch: "", too_large: true };
  if (!o.utf8) return { patch: "", not_utf8: true, preview: o.stdout };
  return { patch: o.stdout };
}

/** `GET /tasks/{id}/git/show?rev=&stash=`: a commit's message and changes (a merge's against its first parent), or a stash's (with its untracked files). */
export async function show(s: AppState, r: Req): Promise<any> {
  const rev = query_str(r.query, "rev");
  const stash = query_bool(r.query, "stash");
  check_rev(rev);
  const t = (await top(s, r.params.id)).top;
  if (stash) {
    let args = ["stash", "show", "-p", "--include-untracked", ...DIFF_ARGS, rev];
    let o = await run(t, args, null);
    // `--include-untracked` is git 2.32's.
    if (!o.ok) {
      args = args.filter((a) => a !== "--include-untracked");
      o = await run(t, args, null);
    }
    if (!o.ok) throw ApiError.conflict(o.stderr.trim());
    return { patch: truncate(o.stdout, MAX_DIFF) };
  }
  const meta = await run_ok(t, ["show", "-s", "--no-show-signature", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", rev, "--"], null);
  const parts = splitn(meta, 5, "\x1f");
  if (parts.length !== 5) throw ApiError.conflict(`can't read commit ${rev}`);
  const [sha, author, email, time, message] = parts;
  const patch = await run_ok(t, ["show", "--format=", "--no-show-signature", "-M", "-m", "--first-parent", ...DIFF_ARGS, rev, "--"], null);
  return { sha, author, email, time: parse_int(time), message: message.trimEnd(), patch: truncate(patch, MAX_DIFF) };
}

/**
 * A git command on `paths`, taken literally (not for commands that run others, as `stash`'s `git clean -- :/` would be
 * taken literally too).
 */
function with_paths(args: string[], paths: string[]): string[] {
  for (const p of paths) check_path(p);
  return ["--literal-pathspecs", ...args, "--", ...paths];
}

/** `POST /tasks/{id}/git/stage {paths}`: stages the files as they are (removed ones too), or everything (no paths). */
export async function stage(s: AppState, r: Req): Promise<any> {
  const paths = field<string[]>(body(r), "paths", "array", []);
  const rp = await top(s, r.params.id);
  check_paths(rp, paths);
  await run_ok(rp.top, with_paths(["add", "-A"], or_all(rp, paths)), null);
  return { ok: true };
}

async function has_head(dir: string): Promise<boolean> {
  return (await run(dir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], null)).ok;
}

/** `POST /tasks/{id}/git/unstage {paths}`: puts the files (or everything) in the index back as they are in HEAD. */
export async function unstage(s: AppState, r: Req): Promise<any> {
  const given = field<string[]>(body(r), "paths", "array", []);
  const rp = await top(s, r.params.id);
  check_paths(rp, given);
  const [t, paths] = [rp.top, or_all(rp, given)];
  if (await has_head(t)) {
    await run_ok(t, with_paths(["reset", "-q", "HEAD"], paths), null);
  } else {
    // Before the first commit, there's nothing to go back to: they're taken out of the index.
    await run_ok(t, with_paths(["rm", "-r", "-q", "--cached", "--ignore-unmatch"], paths.length === 0 ? ["."] : paths), null);
  }
  return { ok: true };
}

/** Which of `paths` are in `out`, a NUL-separated list of paths. */
function listed(out: string, paths: string[]): string[] {
  const have = new Set(out.split("\0"));
  return paths.filter((p) => have.has(p));
}

/**
 * `POST /tasks/{id}/git/discard {paths, staged}`: throws away the files' changes, deleting untracked ones (and, with
 * `staged`, ones that are only in the index). With `staged`, staged changes go too, back to HEAD; otherwise just what
 * isn't staged, back to the index.
 */
export async function discard(s: AppState, r: Req): Promise<any> {
  const b = body(r);
  const paths = field<string[]>(b, "paths", "array");
  const staged = field<boolean>(b, "staged", "boolean", false);
  if (paths.length === 0) throw ApiError.bad("no files to discard");
  const rp = await top(s, r.params.id);
  check_paths(rp, paths);
  const t = rp.top;
  const in_index = listed(await run_ok(t, with_paths(["ls-files", "-z"], paths), null), paths);
  const in_head = staged && (await has_head(t)) ? listed(await run_ok(t, with_paths(["ls-tree", "-r", "-z", "--name-only", "HEAD"], paths), null), paths) : [];
  const untracked = paths.filter((p) => !in_index.includes(p) && !in_head.includes(p));
  if (staged) {
    const added = in_index.filter((p) => !in_head.includes(p));
    if (in_head.length) await run_ok(t, with_paths(["restore", "--source=HEAD", "--staged", "--worktree"], in_head), null);
    if (added.length) await run_ok(t, with_paths(["rm", "-q", "-f"], added), null);
  } else if (in_index.length) {
    await run_ok(t, with_paths(["restore", "--worktree"], in_index), null);
  }
  if (untracked.length) await run_ok(t, with_paths(["clean", "-f", "-q"], untracked), null);
  return { ok: true };
}

/**
 * `POST /tasks/{id}/git/apply {patch, cached, reverse}`: applies a patch of chosen lines, to the index (`cached`:
 * staging or unstaging lines) or the working tree (discarding them).
 */
export async function apply(s: AppState, r: Req): Promise<any> {
  const b = body(r);
  const patch = field<string>(b, "patch", "string");
  const cached = field<boolean>(b, "cached", "boolean", false);
  const reverse = field<boolean>(b, "reverse", "boolean", false);
  const rp = await top(s, r.params.id);
  const t = rp.top;
  if (rp.folder !== null) {
    // The files the patch is of, without applying it.
    const files = await run_ok(t, ["apply", "--numstat", "-z", "-"], patch);
    check_paths(rp, numstat_paths(files));
  }
  const args = ["apply", "--whitespace=nowarn"];
  if (cached) args.push("--cached");
  if (reverse) args.push("-R");
  args.push("-");
  await run_ok(t, args, patch);
  return { ok: true };
}

/** The paths in `git apply --numstat -z`: `added\tdeleted\tpath`, or for a rename an empty path followed by where it's from and to. */
export function numstat_paths(out: string): string[] {
  const paths: string[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const p = splitn(records[i], 3, "\t")[2];
    if (p === "") {
      paths.push(...records.slice(i + 1, i + 3));
      i += Math.min(2, records.length - i - 1);
    } else if (p !== undefined) paths.push(p);
  }
  return paths;
}

/**
 * `POST /tasks/{id}/git/commit {message, amend, reword}`: commits what's staged. `amend`: into the last commit, with its
 * message unless one is given. `reword`: just the last commit's message, leaving out what's staged.
 */
export async function commit(s: AppState, r: Req): Promise<any> {
  const b = body(r);
  const given = field<string>(b, "message", "string", "");
  const amend = field<boolean>(b, "amend", "boolean", false);
  const reword = field<boolean>(b, "reword", "boolean", false);
  const rp = await top(s, r.params.id);
  const t = rp.top;
  if (amend || reword) whole_repo(rp, "Changing the last commit");
  // What's staged outside the project's folder would go in the commit too.
  if (rp.folder !== null) {
    const f = rp.folder;
    const exclude = `:(exclude,top,literal)${f}`;
    const outside = await run_ok(t, ["diff", "--cached", "--name-only", "-z", "--", ":(top)", exclude], null);
    const file = outside.split("\0").find((p) => p !== "");
    if (file !== undefined) {
      throw ApiError.conflict(
        `${file} is staged too, and isn't in the project's folder (${f}): unstage what's outside it in a terminal at ${t}, or commit it there`,
      );
    }
  }
  const message = given.trim();
  if (message === "" && !(amend && !reword)) throw ApiError.bad("the commit needs a message");
  const args = ["commit", "-q"];
  if (reword) args.push("--amend", "--only", "--allow-empty");
  else if (amend) args.push("--amend");
  if (message === "") args.push("--no-edit");
  else args.push("-F", "-");
  await run_ok(t, args, message !== "" ? message : null);
  const head = await run_ok(t, ["rev-parse", "HEAD"], null);
  return { ok: true, head: head.trim() };
}

/**
 * `POST /tasks/{id}/git/stash {action, …}`: stashes changes, or applies, pops or drops a stash. `action` is `push`,
 * `apply`, `pop` or `drop`. For `push`, `mode` is `all` (untracked files too), `staged`, or `unstaged` (all but what's
 * staged, which stays). For the others, `index` and `sha` say which stash, and its commit, so that a list that changed
 * since doesn't pick another.
 */
export async function stash(s: AppState, r: Req): Promise<any> {
  const b = body(r);
  const action = field<string>(b, "action", "string");
  const mode = b.mode == null ? null : field<string>(b, "mode", "string");
  const given = field<string>(b, "message", "string", "");
  const index = b.index == null ? null : field<number>(b, "index", "number");
  if (index !== null && (!Number.isInteger(index) || index < 0)) throw invalid("index", "usize");
  const sha = b.sha == null ? null : field<string>(b, "sha", "string");
  const rp = await top(s, r.params.id);
  whole_repo(rp, "Stashing");
  const t = rp.top;
  const message = given.trim();
  let out: string;
  if (action === "push") {
    const args = ["stash", "push"];
    const m = mode ?? "all";
    if (m === "all") args.push("--include-untracked");
    else if (m === "staged") args.push("--staged");
    else if (m === "unstaged") args.push("--keep-index", "--include-untracked");
    else throw ApiError.bad(`unknown stash mode: ${m}`);
    if (message !== "") args.push("-m", message);
    out = await run_ok(t, args, null);
  } else {
    if (!["apply", "pop", "drop"].includes(action)) throw ApiError.bad(`unknown stash action: ${action}`);
    if (index === null || sha === null) throw ApiError.bad("which stash?");
    const name = `stash@{${index}}`;
    const at = (await run(t, ["rev-parse", "-q", "--verify", name], null)).stdout;
    if (at.trim() !== sha) throw ApiError.conflict("the stashes have changed: refresh and try again");
    out = await run_ok(t, ["stash", action, "-q", name], null);
  }
  return { ok: true, output: out.trim() };
}

/** `POST /tasks/{id}/git/reset {rev, mode}`: moves the branch to a commit. `mode` is `soft`, `mixed` or `hard`. */
export async function reset(s: AppState, r: Req): Promise<any> {
  const b = body(r);
  const rev = field<string>(b, "rev", "string");
  const mode = field<string>(b, "mode", "string");
  check_rev(rev);
  if (!["soft", "mixed", "hard"].includes(mode)) throw ApiError.bad(`unknown reset mode: ${mode}`);
  const rp = await top(s, r.params.id);
  whole_repo(rp, "Resetting");
  await run_ok(rp.top, ["reset", "-q", `--${mode}`, `${rev}^{commit}`], null);
  return { ok: true };
}
