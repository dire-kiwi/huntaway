// Port of server/src/agent/agent_tools/sources.rs.
/**
 * Skill sources: git repositories whose skills the host offers, as `npx skills add owner/repo` does.
 *
 * Adding a source clones the repository (shallow) into `<data>/skill-sources/<id>/` and looks for skills in it: any
 * folder with a `SKILL.md` (the repository's root included). Each becomes a global skill with `source_id` set, so
 * profiles and projects switch it on like any other global skill; it starts off everywhere. Updating a source clones it
 * again and brings the skills up to date: ones that are new appear (off), ones that went are removed, and the rest keep
 * their switches. Before a run, an enabled skill's whole folder is copied to the project's skills folder (see
 * `sync_skills`), so its scripts and references come with it.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Conn } from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import { AsyncMutex, type AppState, type Shared } from "../../state.ts";
import { err_str, new_id, now, remove_dir_all } from "../../util.ts";
import { check_skill, forget_board_skill, Skill_from_row, type Skill } from "../agent_tools.ts";

/** One source operation at a time: they clone, swap folders and write skills, and two at once for the same source would race. (Runs only read the clones.) */
let BUSY: AsyncMutex | null = null;
const busy = () => (BUSY ??= new AsyncMutex());

/** How long a clone may take, in seconds. */
const CLONE_TIMEOUT = 180;
/** How deep in a repository to look for skills, and how many to take from one. */
const MAX_DEPTH = 6;
const MAX_SKILLS = 200;
/** The most a skill's folder may hold, and the most a `SKILL.md` may be. */
const MAX_SKILL_BYTES = 25 << 20;
const MAX_SKILL_MD = 256 << 10;

export interface SkillSource {
  id: string;
  url: string;
  /** The branch or tag cloned; null for the repository's default branch. (Rust's `git_ref`.) */
  ref: string | null;
  /** Shown in the lists: the repository's name. */
  name: string;
  /** The commit the clone is at. */
  commit: string | null;
  synced_at: string | null;
  /** Why the last update failed, if it did. The skills from the update before stay. */
  error: string | null;
  /** Things in the repository that were left out: skills that aren't valid, or whose name is taken. */
  notes: string[];
  created_at: string;
}

export function SkillSource_from_row(r: any): SkillSource {
  let notes: string[] = [];
  try {
    const v = JSON.parse(r.notes);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) notes = v;
  } catch {}
  return {
    id: r.id,
    url: r.url,
    ref: r.git_ref ?? null,
    name: r.name,
    commit: r.commit_sha ?? null,
    synced_at: r.synced_at ?? null,
    error: r.error ?? null,
    notes,
    created_at: r.created_at,
  };
}

export function list_sources(c: Conn): SkillSource[] {
  return db.all(c, "SELECT * FROM skill_sources ORDER BY name, created_at").map(SkillSource_from_row);
}

export function get_source(c: Conn, id: string): SkillSource | null {
  const r = db.one(c, "SELECT * FROM skill_sources WHERE id=?1", id);
  return r ? SkillSource_from_row(r) : null;
}

/** Where the sources are cloned, a folder for each. */
export function sources_root(state: Shared): string {
  return join(state.data_dir, "skill-sources");
}

// ---------- what to clone ----------

const word = (s: string) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/.test(s);

/**
 * The repository to clone from what was typed: a URL (https, http, ssh, git or file), an scp-style `git@host:owner/repo`,
 * a local path, or `owner/repo` for GitHub, as `npx skills add` takes. Anything that git could take as an option or
 * another transport (`ext::`) is refused.
 */
export function normalize_url(input: string): string {
  const url = input.trim();
  if (url === "") throw ApiError.bad("the repository is needed: a git URL, or owner/repo for GitHub");
  if (url.startsWith("-") || /[\s\p{Cc}]/u.test(url)) throw ApiError.bad("that isn't a git repository URL");
  const sep = url.indexOf("://");
  const scheme = sep >= 0 ? url.slice(0, sep).toLowerCase() : null;
  const github = (): string | null => {
    const parts = url.split("/");
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (!word(owner) || !word(repo)) return null;
    let r = repo;
    while (r.endsWith(".git")) r = r.slice(0, -4);
    return `https://github.com/${owner}/${r}`;
  };
  if (scheme !== null) {
    if (["https", "http", "ssh", "git", "file"].includes(scheme)) return url;
    throw ApiError.bad(`${scheme}:// repositories aren't supported: use https, ssh or git`);
  }
  if (url.startsWith("/")) return url;
  // `git@github.com:owner/repo`; a `::` is git's `ext::` and similar transports.
  const colon = url.indexOf(":");
  if (!url.includes("::") && colon >= 0) {
    const host = url.slice(0, colon), path = url.slice(colon + 1);
    if (host.includes("@") && !host.includes("/") && path !== "") return url;
  }
  const g = github();
  if (g === null) throw ApiError.bad("that isn't a git repository: use a URL, git@host:owner/repo, a path or owner/repo");
  return g;
}

/** A branch or tag to clone, if one is given. */
export function check_ref(r: string | null | undefined): string | null {
  const t = r?.trim() ?? "";
  if (t === "") return null;
  const ok = !t.startsWith("-") && !t.startsWith("/") && !t.includes("..") && t.length <= 200 && /^[A-Za-z0-9._\-/+@]+$/.test(t);
  if (!ok) throw ApiError.bad("the branch or tag has characters a git ref can't have");
  return t;
}

/** The repository's name for lists: the last part of its path, less `.git`. */
export function source_name(url: string): string {
  const path = url.replace(/\/+$/, "");
  const last = path.split(/[/:]/).pop() ?? path;
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  return name === "" ? "skills" : [...name].slice(0, 80).join("");
}

// ---------- cloning ----------

interface GitOut {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

function git(args: string[], env: NodeJS.ProcessEnv, timeout_s: number | null): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { env, timeout: timeout_s !== null ? timeout_s * 1000 : undefined, maxBuffer: 64 << 20, encoding: "utf8" }, (err: any, stdout, stderr) => {
      if (err && typeof err.code === "string") return reject(err);
      const timed_out = !!err?.killed && timeout_s !== null && err.signal != null;
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timed_out });
    });
    child.stdin?.end();
  });
}

/** Shallow-clones `url` into `dest` (which mustn't exist), and returns the commit it's at. */
async function clone(url: string, git_ref: string | null, dest: string): Promise<string> {
  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet"];
  if (git_ref !== null) args.push("--branch", git_ref);
  args.push("--", url, dest);
  // Never wait for a password, and only the transports we accept (not `ext::`, which runs commands).
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file" };
  if (process.env.GIT_SSH_COMMAND === undefined && process.env.GIT_SSH === undefined) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  let out: GitOut;
  try {
    out = await git(args, env, CLONE_TIMEOUT);
  } catch (e) {
    throw new Error(`couldn't run git: ${err_str(e)}`);
  }
  if (out.timed_out) throw new Error(`cloning ${url} took more than ${CLONE_TIMEOUT} seconds`);
  if (out.code !== 0) {
    const why = out.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-3).join(" ");
    // GitHub answers for a repository that isn't there as it does for a private one.
    const hint = why.includes("terminal prompts disabled") ? " (the repository may not exist, or it's private and this host has no git credentials for it)" : "";
    throw new Error(`couldn't clone ${url}${git_ref !== null ? ` at ${git_ref}` : ""}: ${why}${hint}`);
  }
  const head = await git(["-C", dest, "rev-parse", "HEAD"], process.env, null);
  return head.stdout.trim();
}

// ---------- finding skills ----------

/** A skill in a clone. */
export interface Found {
  /** Its folder relative to the clone's root, with `/`s ("" for the root). */
  path: string;
  name: string;
  content: string;
}

/**
 * The skills in a clone, and what was left out. A folder with a `SKILL.md` is a skill and its folders belong to it;
 * other folders are looked into, to `MAX_DEPTH` (not `.git`, `node_modules` or hidden folders other than `.claude`,
 * `.agents` and `.codex`). When a name turns up twice the first is taken, with visible folders ahead of hidden ones.
 */
export function discover(root: string): [Found[], string[]] {
  const found: Found[] = [];
  const notes: string[] = [];
  walk(root, "", 0, found, notes);
  return [found, notes];
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function walk(dir: string, rel: string, depth: number, found: Found[], notes: string[]): void {
  const label = rel === "" ? "the repository's root" : rel;
  const skill_md = join(dir, "SKILL.md");
  let is_file = false;
  try {
    is_file = lstatSync(skill_md).isFile();
  } catch {}
  if (is_file) {
    if (found.length >= MAX_SKILLS) {
      const note = `only the first ${MAX_SKILLS} skills are taken`;
      if (!notes.includes(note)) notes.push(note);
      return;
    }
    let checked: { name: string; content: string } | { why: string };
    try {
      const size = statSync(skill_md).size;
      if (size > MAX_SKILL_MD) throw { why: "its SKILL.md is too big" };
      let content: string;
      try {
        content = utf8.decode(readFileSync(skill_md));
      } catch {
        throw { why: "its SKILL.md isn't text" };
      }
      let name: string;
      try {
        name = check_skill(content).name;
      } catch (e: any) {
        throw { why: e instanceof ApiError ? e.message : err_str(e) };
      }
      if (folder_size(dir) > MAX_SKILL_BYTES) throw { why: `its folder is bigger than ${MAX_SKILL_BYTES >> 20} MB` };
      checked = { name, content };
    } catch (e: any) {
      checked = { why: typeof e?.why === "string" ? e.why : err_str(e) };
    }
    if ("why" in checked) notes.push(`${label}: ${checked.why}`);
    else if (found.some((f) => f.name === checked.name)) notes.push(`${label}: another skill is named ${checked.name}`);
    else found.push({ path: rel, name: checked.name, content: checked.content });
    return;
  }
  if (depth >= MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {}
  const subs: Array<[boolean, string]> = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => n !== ".git" && n !== "node_modules" && (!n.startsWith(".") || [".claude", ".agents", ".codex"].includes(n)))
    .map((n) => [n.startsWith("."), n] as [boolean, string]);
  subs.sort((a, b) => (a[0] !== b[0] ? (a[0] ? 1 : -1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [, name] of subs) walk(join(dir, name), rel === "" ? name : `${rel}/${name}`, depth + 1, found, notes);
}

/** The size of the files in a folder, not following links. */
function folder_size(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (e.isDirectory() && e.name !== ".git") total += folder_size(join(dir, e.name));
    else if (e.isFile()) {
      try {
        total += lstatSync(join(dir, e.name)).size;
      } catch {}
    }
    if (total > MAX_SKILL_BYTES) break;
  }
  return total;
}

// ---------- copying a skill to a run's folder ----------

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const read = (p: string): Buffer | null => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

/**
 * Makes `to` hold the same files as the skill folder `from`, leaving files that are already right alone (other agents
 * may be reading them). Links are skipped, so a repository can't make a run's folder show files from elsewhere, and so
 * is `.git`.
 */
export function copy_skill(from: string, to: string): void {
  const t = lstat(to);
  if (t && !t.isDirectory()) unlinkSync(to);
  mkdirSync(to, { recursive: true });
  const wanted = (name: string) => {
    if (name === ".git") return false;
    const m = lstat(join(from, name));
    return !!m && (m.isDirectory() || m.isFile());
  };
  for (const e of readdirSync(to, { withFileTypes: true })) {
    if (!wanted(e.name)) {
      const path = join(to, e.name);
      if (e.isDirectory()) rmSync(path, { recursive: true });
      else unlinkSync(path);
    }
  }
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (!wanted(e.name)) continue;
    const src = join(from, e.name), dst = join(to, e.name);
    if (e.isDirectory()) {
      copy_skill(src, dst);
      continue;
    }
    const d = lstat(dst);
    if (d && !d.isFile()) rmSync(dst, { recursive: true, force: true });
    let same = false;
    try {
      same = statSync(dst).size === statSync(src).size && (read(dst)?.equals(read(src) ?? Buffer.alloc(0)) ?? false);
    } catch {}
    if (!same) {
      copyFileSync(src, dst);
      chmodSync(dst, statSync(src).mode & 0o7777);
    } else {
      // A commit may only make a script executable (or not): the copy follows.
      const want = statSync(src).mode;
      if ((statSync(dst).mode & 0o777) !== (want & 0o777)) chmodSync(dst, want & 0o7777);
    }
  }
}

// ---------- the API ----------

export interface AddSource {
  url?: string | null;
  /** Rust's `git_ref`. */
  ref?: string | null;
}

/** A fresh clone of a source and the skills in it, in a folder beside where it will go. */
interface Fetched {
  dir: string;
  commit: string;
  found: Found[];
  notes: string[];
}

async function fetch(state: Shared, id: string, url: string, git_ref: string | null): Promise<Fetched> {
  const root = sources_root(state);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${id}.new`);
  remove_dir_all(dir);
  try {
    const commit = await clone(url, git_ref, dir);
    const [found, notes] = discover(dir);
    return { dir, commit, found, notes };
  } catch (e) {
    remove_dir_all(dir);
    throw e;
  }
}

/** Puts a fetched clone where the source's is, in place of the one before. */
function install(state: Shared, id: string, fetched: Fetched): void {
  const live = join(sources_root(state), id), old = join(sources_root(state), `${id}.old`);
  remove_dir_all(old);
  if (existsSync(live)) renameSync(live, old);
  try {
    renameSync(fetched.dir, live);
  } catch (e) {
    try {
      renameSync(old, live);
    } catch {}
    throw e;
  }
  remove_dir_all(old);
}

/**
 * Brings a source's skills in line with a fresh clone: adds new ones (off everywhere), updates the ones that stay and
 * removes the ones that went. Returns what was left out. All or nothing.
 */
function apply(c: Conn, id: string, fetched: Fetched): string[] {
  c.exec("SAVEPOINT apply_source");
  try {
    const notes = apply_in(c, id, fetched);
    c.exec("RELEASE apply_source");
    return notes;
  } catch (e) {
    try {
      c.exec("ROLLBACK TO apply_source; RELEASE apply_source");
    } catch {}
    throw e;
  }
}

function apply_in(c: Conn, id: string, fetched: Fetched): string[] {
  const notes = [...fetched.notes];
  const existing: Skill[] = db.all(c, "SELECT * FROM agent_skills WHERE source_id=?1", id).map(Skill_from_row);
  const at = now();
  const found = fetched.found;
  // Which existing skill each found one is: the one at its path, else (the folder was moved) the one with its name that
  // no found skill is at the path of, so it keeps its id and switches.
  const at_path = (f: Found) => existing.find((s) => s.source_path === f.path);
  const matched: Array<Skill | null> = found.map(
    (f) => at_path(f) ?? existing.find((s) => s.name === f.name && !found.some((o) => s.source_path === o.path)) ?? null,
  );
  // A name is taken only by a skill that isn't from this source: its own skills give theirs up as they're renamed,
  // moved or removed. (The found ones have names of their own, see `discover`.)
  const keep = found.map(() => true);
  found.forEach((f, i) => {
    const taken = db.value<number>(
      c,
      "SELECT COUNT(*) > 0 FROM agent_skills WHERE project_id IS NULL AND name=?1 AND (source_id IS NULL OR source_id != ?2)",
      f.name,
      id,
    );
    if (taken) {
      notes.push(`${f.path === "" ? "the repository's root" : f.path}: a skill named ${f.name} is already on this host`);
      keep[i] = false;
    }
  });
  // The ones that are gone, or left out, are removed.
  const used = (s: Skill) => found.some((_, i) => keep[i] && matched[i]?.id === s.id);
  const gone = existing.filter((s) => !used(s));
  for (const s of gone) db.run(c, "DELETE FROM agent_skills WHERE id=?1", s.id);
  keep.forEach((k, i) => {
    if (!k) matched[i] = null;
  });
  // Renames in two steps, so that skills can swap names or pass them along.
  const renamed: Array<[Found, Skill]> = [];
  found.forEach((f, i) => {
    const m = matched[i];
    if (keep[i] && m && f.name !== m.name) renamed.push([f, m]);
  });
  for (const [, s] of renamed) db.run(c, "UPDATE agent_skills SET name=?1 WHERE id=?2", `\u0000renaming ${s.id}`, s.id);
  found.forEach((f, i) => {
    if (!keep[i]) return;
    const before = matched[i];
    if (before) {
      db.run(c, "UPDATE agent_skills SET name=?1, content=?2, source_path=?3, updated_at=?4 WHERE id=?5", f.name, f.content, f.path, at, before.id);
    } else {
      db.run(
        c,
        "INSERT INTO agent_skills (id, project_id, name, content, enabled, source_id, source_path, created_at, updated_at) VALUES (?1,NULL,?2,?3,1,?4,?5,?6,?6)",
        new_id(),
        f.name,
        f.content,
        id,
        f.path,
        at,
      );
    }
  });
  // What runs reported under the names that went (see forget_board_skill) is forgotten once all are settled.
  for (const name of [...gone.map((s) => s.name), ...renamed.map(([, s]) => s.name)]) forget_board_skill(c, null, name);
  return notes;
}

/**
 * `POST /agent-tools/skill-sources` (API 104): clones a repository and adds its skills, off for every profile and
 * project until they're switched on.
 */
export async function add_source(s: AppState, r: Req): Promise<any> {
  const b = r.body ?? {};
  const url = normalize_url(typeof b.url === "string" ? b.url : "");
  const git_ref = check_ref(typeof b.ref === "string" ? b.ref : null);
  const release = await busy().lock();
  try {
    if (list_sources(s.db()).some((o) => o.url === url && o.ref === git_ref)) {
      throw ApiError.conflict("that repository is already added: update it instead");
    }
    const id = new_id();
    let fetched: Fetched;
    try {
      fetched = await fetch(s, id, url, git_ref);
    } catch (e) {
      throw new ApiError(502, err_str(e));
    }
    install(s, id, fetched);
    const c = s.db();
    db.run(
      c,
      "INSERT INTO skill_sources (id, url, git_ref, name, commit_sha, synced_at, notes, created_at) VALUES (?1,?2,?3,?4,?5,?6,'[]',?6)",
      id,
      url,
      git_ref,
      source_name(url),
      fetched.commit,
      now(),
    );
    const notes = apply(c, id, fetched);
    if (skills_of(c, id).length === 0) {
      // Nothing in it could be added: it isn't a source.
      db.run(c, "DELETE FROM skill_sources WHERE id=?1", id);
      remove_dir_all(join(sources_root(s), id));
      const why = notes.length ? ` (${notes.join("; ")})` : "";
      throw ApiError.bad(`no skills found in ${url}: a skill is a folder with a SKILL.md${why}`);
    }
    db.run(c, "UPDATE skill_sources SET notes=?1 WHERE id=?2", JSON.stringify(notes), id);
    const source = get_source(c, id);
    if (!source) throw ApiError.not_found("skill source");
    return { source, skills: skills_of(c, id) };
  } finally {
    release();
  }
}

/**
 * `POST /agent-tools/skill-sources/{id}/update`: clones the repository again and brings its skills up to date. If that
 * fails the skills stay as they were, and the source says why.
 */
export async function update_source(s: AppState, r: Req): Promise<any> {
  const id = r.params.source;
  const release = await busy().lock();
  try {
    const source = get_source(s.db(), id);
    if (!source) throw ApiError.not_found("skill source");
    let fetched: Fetched;
    try {
      fetched = await fetch(s, id, source.url, source.ref);
    } catch (e) {
      const why = err_str(e);
      db.run(s.db(), "UPDATE skill_sources SET error=?1 WHERE id=?2", why, id);
      throw new ApiError(502, why);
    }
    install(s, id, fetched);
    const c = s.db();
    const notes = apply(c, id, fetched);
    db.run(c, "UPDATE skill_sources SET commit_sha=?1, synced_at=?2, error=NULL, notes=?3 WHERE id=?4", fetched.commit, now(), JSON.stringify(notes), id);
    const updated = get_source(c, id);
    if (!updated) throw ApiError.not_found("skill source");
    return { source: updated, skills: skills_of(c, id) };
  } finally {
    release();
  }
}

/** `DELETE /agent-tools/skill-sources/{id}`: forgets the repository, its clone and its skills. */
export async function delete_source(s: AppState, r: Req): Promise<any> {
  const id = r.params.source;
  const release = await busy().lock();
  try {
    const c = s.db();
    if (!get_source(c, id)) throw ApiError.not_found("skill source");
    const skills = skills_of(c, id);
    db.run(c, "DELETE FROM agent_skills WHERE source_id=?1", id);
    db.run(c, "DELETE FROM skill_sources WHERE id=?1", id);
    for (const skill of skills) forget_board_skill(c, null, skill.name);
    remove_dir_all(join(sources_root(s), id));
    return { ok: true };
  } finally {
    release();
  }
}

export function skills_of(c: Conn, source_id: string): Skill[] {
  return db.all(c, "SELECT * FROM agent_skills WHERE source_id=?1 ORDER BY name", source_id).map(Skill_from_row);
}
