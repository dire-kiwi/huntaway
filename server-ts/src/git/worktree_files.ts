// Port of server/src/git/worktree_files.rs.
/**
 * The repository's ignored files a project brings into each new task worktree (API 82), before its setup script runs, so
 * the script and the agent can rely on them: `.env` files, local config, credentials, big caches.
 *
 * - `copy_files` (and the repository's `.worktreeinclude`, as Claude Code and Orca read it) are .gitignore-style patterns
 *   (`.env` at any depth, `/.env` only at the top, `config/*.local.json`, `!` to leave one out). Each untracked file of
 *   the repository folder they match is copied when git ignores it, both there and on the task's branch; a file the
 *   worktree already has is never overwritten.
 * - `link_folders` are folders, relative to the repository, symlinked into the worktree instead (a model cache, say).
 *   Each must be ignored by git with nothing tracked in it. A link isn't a folder to git, so a `node_modules/` pattern
 *   doesn't ignore it: when nothing else does, it's added to the repository's `info/exclude`, so the link isn't
 *   committed, doesn't show as untracked, and doesn't keep the worktree from being removed. Removing the worktree removes
 *   the link, not what it points to.
 *
 * Nothing is read through a symlink in the repository (one could lead out of it, to its `.git`, or to tracked files under
 * an ignored name), nor from outside it (no `..`, no absolute paths), and nothing is written through a symlink in the
 * worktree. The links made in each worktree are kept in its git folder (`huntaway-links`), so they're pointed at the
 * repository's new place if it moves, whatever the setting says by then.
 *
 * File names are taken as UTF-8 here (git's NUL-separated lists are decoded as such), unlike Rust's byte paths.
 */
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "../db.ts";
import { ApiError } from "../http.ts";
import { context, err_str } from "../util.ts";
import { canonicalize, git_env, output, path_starts_with, same_path, strip_path_prefix, type RawOutput } from "./worktree.ts";

/** The repository's own list of files to copy, as other tools read it. */
export const INCLUDE_FILE = ".worktreeinclude";

/** What `bring_in` did, for the task's log. */
export interface Report {
  copied: string[];
  linked: string[];
  /** Already in the worktree (checked out, or from an earlier setup), so left as they are. */
  existing: string[];
  /** What was asked for but not brought in, and why. */
  skipped: string[];
  /** Whether the repository's `.worktreeinclude` was read. */
  include_file: boolean;
}

export function Report_default(): Report {
  return { copied: [], linked: [], existing: [], skipped: [], include_file: false };
}

/** The event for the task's log (level, text, detail), or None when nothing was asked for. */
export function event(r: Report): [string, string, string] | null {
  const c = r.copied.length, l = r.linked.length, e = r.existing.length, s = r.skipped.length;
  if (c + l + e + s === 0 && !r.include_file) return null;
  const parts: string[] = [];
  if (c > 0 || l === 0) parts.push(`Copied ${c} file${plural(c)}`);
  if (l > 0) parts.push(`linked ${l} folder${plural(l)}`);
  let text = `${sentence(parts.join(" and "))} from the repository`;
  if (s > 0) text += ` (${s} left out)`;
  const detail: string[] = [];
  if (r.include_file) detail.push(`Read ${INCLUDE_FILE}`);
  detail.push(...r.copied.map((p) => `copied ${p}`));
  detail.push(...r.linked.map((p) => `linked ${p}`));
  detail.push(...r.existing.map((p) => `already there: ${p}`));
  detail.push(...r.skipped.map((p) => `left out: ${p}`));
  return [s > 0 ? "warn" : "info", text, detail.join("\n")];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function sentence(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** The lines of a list that count: trimmed, without blank lines and `#` comments. */
export function entries(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Why a `copy_files` pattern can't be used, if it can't (null if it can): it mustn't climb out with `..`. */
export function check_pattern(p: string): string | null {
  const q = p.startsWith("!") ? p.slice(1) : p;
  if (q.split("/").some((c) => c === "..")) return `${q}: patterns are relative to the repository, without ..`;
  return null;
}

/** A `link_folders` entry as a path relative to the repository, or why it isn't one (`{err}`). */
export function link_path(p: string): { ok: string } | { err: string } {
  const path = p.replace(/\/+$/, "");
  if (path.startsWith("/") || p.startsWith("~")) return { err: `${p}: folders are relative to the repository` };
  const out: string[] = [];
  for (const c of path.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === ".." || c === ".git") return { err: `${p}: folders are relative to the repository, inside it, without .. or .git` };
    out.push(c);
  }
  if (!out.length) return { err: `${p}: name a folder inside the repository` };
  return { ok: out.join("/") };
}

/**
 * Checks a `copy_files` or `link_folders` value, as the API stores it. Throws `ApiError.bad` with why it can't be (Rust's
 * `Err(String)`, which its caller makes a 400).
 */
export function check(field: string, text: string): void {
  const lines = entries(text);
  if (lines.length > 200) throw ApiError.bad(`${field} can have at most 200 entries`);
  for (const l of lines) {
    let e: string | null;
    if (field === "link_folders") {
      const r = link_path(l);
      e = "err" in r ? r.err : null;
    } else e = check_pattern(l);
    if (e !== null) throw ApiError.bad(`${field}: ${e}`);
  }
}

/** Copy and link `project`'s files into its task worktree `wt` (see the module's comment). */
export async function bring_in(project: Project, wt: string): Promise<Report> {
  const report = Report_default();
  const top = (await git_text(project.repo_path, ["rev-parse", "--show-toplevel"])).trim();
  const canon_top = canonicalize(top);
  if (canon_top === null) throw context(`resolving ${top}`, new Error("No such file or directory (os error 2)"));
  const links: string[] = [];
  for (const l of entries(project.link_folders)) {
    const r = link_path(l);
    if ("ok" in r) links.push(r.ok);
    else report.skipped.push(r.err);
  }
  let patterns = entries(project.copy_files);
  const inc = include_file(top);
  if ("ok" in inc) {
    if (inc.ok !== null) {
      report.include_file = true;
      patterns.push(...entries(inc.ok));
    }
  } else report.skipped.push(`${INCLUDE_FILE}: ${inc.err}, not read`);
  patterns = patterns.filter((p) => {
    const e = check_pattern(p);
    if (e !== null) report.skipped.push(e);
    return e === null;
  });
  if (patterns.some((p) => !p.startsWith("!"))) {
    const worktrees = canonicalize(project.worktrees_root);
    await copy(report, top, canon_top, worktrees, wt, patterns, links);
  }
  for (const rel of links) {
    const r = await link(top, canon_top, wt, rel);
    if ("err" in r) report.skipped.push(`${rel}: ${r.err}`);
    else if (r.ok === null) report.existing.push(rel);
    else report.linked.push(`${rel} -> ${r.ok}`);
  }
  return report;
}

/** An io error as Rust displays it, near enough: its message. */
function io_str(e: any): string {
  return e?.message ?? String(e);
}

/**
 * The repository's `.worktreeinclude`, if it has one: a file of its own, not a symlink (which could lead anywhere, and
 * its lines end up in the task's log).
 */
function include_file(top: string): { ok: string | null } | { err: string } {
  const path = join(top, INCLUDE_FILE);
  let meta;
  try {
    meta = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: null };
    return { err: `can't read it (${io_str(e)})` };
  }
  if (meta.isSymbolicLink()) return { err: "a symbolic link" };
  if (!meta.isFile()) return { err: "not a file" };
  if (meta.size > 64 * 1024) return { err: "bigger than 64 KiB" };
  try {
    return { ok: readFileSync(path, "utf8") };
  } catch (e) {
    return { err: `can't read it (${io_str(e)})` };
  }
}

/**
 * Copies the files `patterns` match (see the module's comment), except those under `links` (which are linked instead)
 * and the project's worktrees folder `worktrees`.
 */
async function copy(report: Report, top: string, canon_top: string, worktrees: string | null, wt: string, patterns: string[], links: string[]) {
  const args = ["ls-files", "-z", "--others", "--ignored"];
  for (const p of patterns) args.push("-x", p);
  const out = await git_bytes(top, args, null);
  const found = out
    .toString()
    .split("\0")
    // A nested repository (a worktree kept in the repository, say) is listed as a folder.
    .filter((p) => p && !p.endsWith("/"));
  for (const p of patterns.filter(is_literal)) {
    if (!found.some((f) => literal_matches(p, f))) {
      const why = existsSync(join(top, p.replace(/^\/+/, ""))) ? "tracked by git, not copied" : "not in the repository";
      report.skipped.push(`${p}: ${why}`);
    }
  }
  let wanted = found
    // What's in a folder that's linked comes with it.
    .filter((f) => !links.some((l) => path_starts_with(f, l) && is_dir(join(top, l))))
    .filter((f) => !(worktrees !== null && path_starts_with(join(canon_top, f), worktrees)));
  // Not into the worktree through a symlink (which git can't say it ignores, either).
  wanted = wanted.filter((f) => {
    const why = not_a_folder(wt, f);
    if (why !== null) report.skipped.push(`${f}: ${why}`);
    return why === null;
  });
  const in_repo = await ignored(top, wanted);
  const in_wt = await ignored(wt, wanted);
  const not_ignored: string[] = [];
  const todo: string[] = [];
  for (const f of wanted) {
    if (!in_repo.has(f)) not_ignored.push(f);
    else if (!in_wt.has(f)) report.skipped.push(`${f}: not ignored by git on the task's branch`);
    else todo.push(f);
  }
  if (not_ignored.length) {
    const n = not_ignored.length;
    const more = n > 10 ? ` and ${n - 10} more` : "";
    report.skipped.push(`${n} matching file${plural(n)} git doesn't ignore (only ignored files are copied): ${not_ignored.slice(0, 10).join(", ")}${more}`);
  }
  for (const f of todo) {
    const r = copy_one(top, canon_top, wt, f);
    if ("err" in r) report.skipped.push(`${f}: ${r.err}`);
    else if (r.ok) report.copied.push(f);
    else report.existing.push(f);
  }
}

/** `Path::is_dir`: whether `p` is a folder, through symlinks. */
function is_dir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a pattern names a path rather than matching several (no wildcards, not a negation). */
function is_literal(p: string): boolean {
  return !p.startsWith("!") && !/[*?[\\]/.test(p);
}

/** The components of a relative path. */
function components(p: string): string[] {
  return p.split("/").filter((c) => c && c !== ".");
}

/**
 * Whether file `f` is (or is in) what literal pattern `p` names, as git would match it: a pattern with a slash before its
 * end is anchored at the top, one without matches at any depth.
 */
export function literal_matches(p: string, f: string): boolean {
  const name = p.replace(/\/+$/, "");
  const anchored = name.includes("/");
  const want = components(name.replace(/^\/+/, ""));
  const fc = components(f);
  const starts = (from: number) => want.length <= fc.length - from && want.every((c, i) => fc[from + i] === c);
  if (anchored) return starts(0);
  for (let skip = 0; skip < fc.length; skip++) if (starts(skip)) return true;
  return false;
}

/** Copies `rel` from the repository at `top` into the worktree `wt`: true if copied, false if the worktree has it already, or why it can't be. */
function copy_one(top: string, canon_top: string, wt: string, rel: string): { ok: boolean } | { err: string } {
  const sym = symlink_in(top, rel);
  if (sym !== null) return { err: sym };
  const src = join(top, rel);
  let meta;
  try {
    meta = lstatSync(src);
  } catch (e) {
    return { err: `can't read it (${io_str(e)})` };
  }
  if (!meta.isFile()) return { err: "not a file" };
  const real = canonicalize(src);
  if (real === null || !path_starts_with(real, canon_top)) return { err: "not in the repository" };
  const dest = join(wt, rel);
  if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) return { ok: false };
  const made = make_parents(wt, rel);
  if (made !== null) return { err: made };
  try {
    copyFileSync(src, dest);
  } catch (e) {
    return { err: `copying it failed (${io_str(e)})` };
  }
  return { ok: true };
}

/**
 * Refuses `rel` of the repository at `top` if it, or a folder it's in, is a symlink: the git checks that it's ignored and
 * untracked are of its own path, not of where a link leads. Null when it isn't one.
 */
function symlink_in(top: string, rel: string): string | null {
  let path = top;
  const cs = components(rel);
  for (let i = 0; i < cs.length; i++) {
    path = join(path, cs[i]);
    let m;
    try {
      m = lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      return `can't read it (${io_str(e)})`;
    }
    if (m.isSymbolicLink()) return i + 1 === cs.length ? "a symbolic link" : `${strip_path_prefix(path, top) ?? path} is a symbolic link`;
  }
  return null;
}

/** Why `rel` can't go in the worktree `wt`, if it can't: one of the folders it's in there is a symlink, or something else that isn't a folder. */
function not_a_folder(wt: string, rel: string): string | null {
  let dir = wt;
  const cs = components(rel);
  for (const c of cs.slice(0, -1)) {
    dir = join(dir, c);
    const m = lstatSync(dir, { throwIfNoEntry: false });
    if (m === undefined) return null;
    if (!m.isDirectory()) return `${strip_path_prefix(dir, wt) ?? dir} in the worktree isn't a folder`;
  }
  return null;
}

/** Creates the folders `rel` is in inside the worktree `wt`, refusing to go through a symlink (or anything else that isn't a folder) on the way. */
function make_parents(wt: string, rel: string): string | null {
  let dir = wt;
  for (const c of components(rel).slice(0, -1)) {
    dir = join(dir, c);
    let m;
    try {
      m = lstatSync(dir);
    } catch (e) {
      if (e.code === "ENOENT") {
        try {
          mkdirSync(dir);
        } catch (e) {
          return `creating ${dir} failed (${io_str(e)})`;
        }
        continue;
      }
      return `checking ${dir} failed (${io_str(e)})`;
    }
    if (!m.isDirectory()) return `${strip_path_prefix(dir, wt) ?? dir} in the worktree isn't a folder`;
  }
  return null;
}

/** Links folder `rel` of the repository at `top` into the worktree `wt`: what it links to (`ok`), null `ok` if the worktree has something there already, or why it can't. */
async function link(top: string, canon_top: string, wt: string, rel: string): Promise<{ ok: string | null } | { err: string }> {
  const sym = symlink_in(top, rel);
  if (sym !== null) return { err: sym };
  const src = join(top, rel);
  let m;
  try {
    m = lstatSync(src);
  } catch (e) {
    if (e.code === "ENOENT") return { err: "not in the repository" };
    return { err: `can't read it (${io_str(e)})` };
  }
  if (!m.isDirectory()) return { err: "not a folder" };
  const real = canonicalize(src);
  if (real === null) return { err: "can't read it" };
  if (!path_starts_with(real, canon_top) || same_path(real, canon_top)) return { err: "not in the repository" };
  const w = canonicalize(wt);
  if (w !== null && path_starts_with(w, real)) return { err: "the worktree is inside it" };
  let tracked: Buffer;
  try {
    tracked = await git_bytes(top, ["ls-files", "-z", "--", `:(literal)${rel}`], null);
  } catch (e) {
    return { err: err_str(e) };
  }
  if (tracked.length) return { err: "git tracks files in it" };
  if (!(await is_ignored(top, rel))) return { err: "not ignored by git" };
  const dest = join(wt, rel);
  if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) return { ok: null };
  const made = make_parents(wt, rel);
  if (made !== null) return { err: made };
  try {
    symlinkSync(src, dest);
  } catch (e) {
    return { err: `linking it failed (${io_str(e)})` };
  }
  if (!(await is_ignored(wt, rel))) {
    let excluded: Error | null = null;
    try {
      await exclude(wt, rel);
    } catch (e) {
      excluded = e;
    }
    if (excluded !== null || !(await is_ignored(wt, rel))) {
      try {
        unlinkSync(dest);
      } catch {}
      const why = excluded !== null ? err_str(excluded) : "the repository's .gitignore files say not to ignore it";
      return { err: `the link would be an untracked file in the worktree (${why})` };
    }
  }
  try {
    await record(wt, rel);
  } catch (e) {
    console.warn(`recording the link ${rel} in ${wt}: ${err_str(e)}`);
  }
  return { ok: src };
}

/** Whether git ignores `rel` in the checkout at `dir`. */
async function is_ignored(dir: string, rel: string): Promise<boolean> {
  try {
    return (await git_output(dir, ["check-ignore", "-q", "--", rel], null)).success;
  } catch {
    return false;
  }
}

/** Which of `files` git ignores in the checkout at `dir` (tracked files aren't). */
async function ignored(dir: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const input = Buffer.from(files.map((f) => f + "\0").join(""));
  const out = await git_output(dir, ["check-ignore", "-z", "--stdin"], input);
  // 1 is none of them.
  if (!out.success && out.code !== 1) throw new Error(`git check-ignore failed: ${out.stderr.toString().trim()}`);
  return new Set(
    out.stdout
      .toString()
      .split("\0")
      .filter((p) => p),
  );
}

const EXCLUDE_HEADER =
  "# Folders Huntaway links into task worktrees (a project's Folders to link). Git doesn't take a\n" +
  "# symbolic link for a folder, so a `name/` pattern doesn't ignore the link.\n";

/** Adds `/<rel>` to the `info/exclude` of the repository that worktree `wt` is of (shared by all its worktrees), once. */
async function exclude(wt: string, rel: string): Promise<void> {
  const file = (await git_text(wt, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
  let line = "/";
  for (const ch of rel) line += "\\*?[".includes(ch) ? `\\${ch}` : ch;
  if (line.endsWith(" ")) line = line.slice(0, -1) + "\\ ";
  // Read and added to without awaiting in between, so links set up at once don't lose each other's lines.
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw context(`reading ${file}`, e);
    text = "";
  }
  if (text.split("\n").some((l) => l === line)) return;
  let add = "";
  if (text && !text.endsWith("\n")) add += "\n";
  if (!text.includes(EXCLUDE_HEADER)) add += EXCLUDE_HEADER;
  add += line + "\n";
  mkdirSync(dirname(file), { recursive: true });
  try {
    appendFileSync(file, add);
  } catch (e) {
    throw context(`adding to ${file}`, e);
  }
}

/** The file in a worktree's git folder that lists the links made in it, one path per line. It goes with the worktree when git removes it. */
const RECORD = "huntaway-links";

async function record_file(wt: string): Promise<string> {
  return join((await git_text(wt, ["rev-parse", "--absolute-git-dir"])).trim(), RECORD);
}

/** Adds `rel` to the links recorded for worktree `wt`. */
async function record(wt: string, rel: string): Promise<void> {
  const file = await record_file(wt);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  if (text.split("\n").some((l) => l === rel)) return;
  try {
    appendFileSync(file, rel + "\n");
  } catch (e) {
    throw context(`opening ${file}`, e);
  }
}

/** The links recorded for worktree `wt`, as paths inside it. */
async function recorded(wt: string): Promise<string[]> {
  let file: string;
  try {
    file = await record_file(wt);
  } catch {
    return [];
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  return text.split("\n").filter((p) => p && !p.startsWith("/") && p.split("/").every((c) => c !== "" && c !== "." && c !== ".." && c !== ".git"));
}

/**
 * Points the folder links in worktree `wt` that lead into the repository's old folder at its new one, after the
 * repository moved and the worktree was repaired (`map` gives a path's new place, see git/relocate.ts): those recorded
 * for it, and those the project's `link_folders` name.
 */
export async function relink(wt: string, link_folders: string, map: (p: string) => string | null): Promise<void> {
  const links = await recorded(wt);
  for (const l of entries(link_folders)) {
    const r = link_path(l);
    if ("ok" in r) links.push(r.ok);
  }
  const unique = [...new Set(links)].sort();
  for (const rel of unique) {
    // Not through a symlink in the worktree.
    if (not_a_folder(wt, rel) !== null) continue;
    const dest = join(wt, rel);
    let old: string;
    try {
      old = readlinkSync(dest);
    } catch {
      continue;
    }
    const neu = map(old);
    if (neu === null || same_path(neu, old)) continue;
    try {
      unlinkSync(dest);
      symlinkSync(neu, dest);
    } catch (e) {
      console.warn(`pointing ${dest} at ${neu}: ${io_str(e)}`);
    }
  }
}

async function git_output(dir: string, args: string[], input: Buffer | null): Promise<RawOutput> {
  try {
    return await output("git", ["-C", dir, ...args], { env: git_env(), input: input ?? undefined });
  } catch (e) {
    throw context("failed to run git", e);
  }
}

async function git_bytes(dir: string, args: string[], input: Buffer | null): Promise<Buffer> {
  const out = await git_output(dir, args, input);
  if (!out.success) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  return out.stdout;
}

async function git_text(dir: string, args: string[]): Promise<string> {
  return (await git_bytes(dir, args, null)).toString();
}
