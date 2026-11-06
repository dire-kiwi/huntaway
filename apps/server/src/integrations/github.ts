// Port of server/src/integrations/github.rs.
/**
 * Adding a project from GitHub (the new project dialog's GitHub tab, API 55): the repositories
 * gh can reach on this host, and cloning one into the profile's clone folder (see
 * db::Profile::clone_dir). Both act as the profile's GitHub account (see gh_mcp::Account), or
 * as gh's active account when it has none.
 *
 * Rust's `Result<T, String>` functions (`clone`, `create`) throw an `Error` with that string as its message.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as worktree from "../git/worktree.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import { AsyncMutex } from "../state.ts";
import { err_str, remove_dir_all } from "../util.ts";

/**
 * How many pages of 100 of the repositories the account owns or collaborates on are listed, most
 * recently pushed first. Its organizations' are searched rather than listed (one can have tens of
 * thousands), but those it has contributed to are listed too.
 */
const PAGES = 3;

/**
 * The GraphQL query for the repositories the account has contributed to lately (commits, pull
 * requests and their reviews, issues), others' (organizations') only.
 */
const CONTRIBUTED =
  "query=query { viewer { repositoriesContributedTo(first: 100, includeUserRepositories: false, " +
  "contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, ISSUE, REPOSITORY]) { nodes { nameWithOwner name description isPrivate " +
  "isFork isArchived pushedAt url } } } }";

/** How many repositories a search finds at most. */
const SEARCH_RESULTS = 50;

/** How long an account's login and organizations are kept for its searches (ms). */
const OWNERS_TTL = 300_000;

/** How long a clone may take (ms). */
const CLONE_TIMEOUT = 3_600_000;

/** How long creating a repository and pushing a folder's commits to it may take (ms). */
const CREATE_TIMEOUT = 900_000;

type GhEnv = gh_mcp.GhEnv;

/** Removes `gh_env`'s config folder (Rust's `Drop for GhEnv`). */
function drop_env(gh_env: GhEnv | null) {
  try {
    gh_env?.drop();
  } catch {}
}

async function account_env(account: string | null): Promise<GhEnv | null> {
  try {
    return (await gh_mcp.account_env(account)) ?? null;
  } catch (e) {
    throw new Error(err_str(e));
  }
}

/**
 * The repositories `account` (gh's active one when null) can clone, for picking one:
 * `{account, repos: [{full_name, name, description, private, fork, archived, pushed_at, url}],
 * error}`, where `account` is who gh acts as. Without `query`, the ones it owns, collaborates on
 * or has contributed to, most recently pushed first. With one, those named like it among the ones
 * it owns and its organizations' (see `search_query`).
 */
export async function list(account: string | null, query: string | null): Promise<any> {
  const q = query?.trim() || null;
  try {
    const [login, repos] = await find(account, q);
    return { account: account ?? login, repos, error: null };
  } catch (e) {
    return { account, repos: [], error: err_str(e) };
  }
}

async function find(account: string | null, query: string | null): Promise<[string, any[]]> {
  const env = await account_env(account);
  try {
    if (query !== null) {
      const os = await owners(account, env);
      const q = search_query(query, os);
      if (q === null) return [os[0], []];
      const found = await gh_json(env, ["api", "-X", "GET", "search/repositories", "-f", `q=${q}`, "-f", `per_page=${SEARCH_RESULTS}`]);
      return [os[0], (Array.isArray(found?.items) ? found.items : []).map(repo).filter((r: any) => r !== null)];
    }
    const page = (n: number) => `user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=${n}`;
    const [user, first, contributed] = await Promise.allSettled([
      gh_json(env, ["api", "user"]),
      gh_json(env, ["api", page(1)]),
      gh_json(env, ["api", "graphql", "-f", CONTRIBUTED]),
    ]);
    if (user.status === "rejected") throw user.reason;
    const l = login(user.value);
    if (first.status === "rejected") throw first.reason;
    const all: any[] = Array.isArray(first.value) ? [...first.value] : [];
    for (let n = 2; n <= PAGES; n++) {
      if (all.length < (n - 1) * 100) break;
      const more = await gh_json(env, ["api", page(n)]);
      if (Array.isArray(more)) all.push(...more);
    }
    // Without them (an error about one of them, e.g. an organization's SSO), its own are still listed.
    const nodes = contributed.status === "fulfilled" ? contributed.value?.data?.viewer?.repositoriesContributedTo?.nodes : null;
    const theirs = (Array.isArray(nodes) ? nodes : []).map(graphql_repo).filter((r: any) => r !== null);
    return [l, latest_first([...all.map(repo).filter((r) => r !== null), ...theirs])];
  } finally {
    drop_env(env);
  }
}

/** `repos` without repeats, most recently pushed first. */
export function latest_first(repos: any[]): any[] {
  const seen = new Set<string>();
  const out = repos.filter((r) => {
    const k = (typeof r.full_name === "string" ? r.full_name : "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // ISO times, which sort as text; those never pushed to go last.
  const key = (r: any) => (typeof r.pushed_at === "string" ? r.pushed_at : null);
  out.sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? 1 : -1;
  });
  return out;
}

/** Each account's login and organizations, and when they were looked up. */
const KNOWN = new Map<string, [number, string[]]>();

/**
 * The login `account` acts as, then its organizations: the owners a search looks among. Kept a
 * while (see OWNERS_TTL), as each search would otherwise ask again.
 */
async function owners(account: string | null, env: GhEnv | null): Promise<string[]> {
  const key = account ?? "";
  const known = KNOWN.get(key);
  if (known && performance.now() - known[0] < OWNERS_TTL) return [...known[1]];
  const [user, orgs] = await Promise.allSettled([gh_json(env, ["api", "user"]), gh_json(env, ["api", "user/orgs?per_page=100"])]);
  if (user.status === "rejected") throw user.reason;
  const out = [login(user.value)];
  // Without them (a token that can't list them), it searches the account's own.
  if (orgs.status === "fulfilled" && Array.isArray(orgs.value)) for (const o of orgs.value) if (typeof o?.login === "string") out.push(o.login);
  KNOWN.set(key, [performance.now(), out]);
  return [...out];
}

/**
 * The search API's query for repositories whose names are like `text`, among `owners`', or
 * OWNER's for `OWNER/NAME` (all of them for `OWNER/`). None when there's nothing to search for.
 */
export function search_query(text: string, owners: string[]): string | null {
  // Only what logins and repository names are made of, so what's typed adds no qualifiers.
  const words = (s: string) => s.split(/[^A-Za-z0-9\-_.]/).filter((w) => w);
  let os: string[], name: string[];
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const owner = text.slice(0, slash), rest = text.slice(slash + 1);
    if (words(owner).length) [os, name] = [words(owner), words(rest)];
    else [os, name] = [[...owners], words(rest)];
  } else [os, name] = [[...owners], words(text)];
  if (!os.length || (!name.length && !text.includes("/"))) return null;
  return `${name.join(" ")} in:name fork:true ${os.map((o) => `user:${o}`).join(" ")}`.trim();
}

const str = (v: any): string | null => (typeof v === "string" ? v : null);
const bool = (v: any): boolean => (typeof v === "boolean" ? v : false);

/** What the dialog shows of a repository from GitHub's API. */
export function repo(r: any): any | null {
  const full_name = str(r?.full_name);
  if (full_name === null) return null;
  return {
    full_name,
    name: str(r.name) ?? full_name.split("/").pop()!,
    description: str(r.description),
    private: bool(r.private),
    fork: bool(r.fork),
    archived: bool(r.archived),
    pushed_at: str(r.pushed_at),
    url: str(r.html_url),
  };
}

/** `repo` for a repository from the GraphQL API. */
export function graphql_repo(r: any): any | null {
  return repo({
    full_name: r?.nameWithOwner,
    name: r?.name,
    description: r?.description,
    private: r?.isPrivate,
    fork: r?.isFork,
    archived: r?.isArchived,
    pushed_at: r?.pushedAt,
    html_url: r?.url,
  });
}

function login(user: any): string {
  const l = str(user?.login);
  if (l === null) throw new Error("gh didn't say which GitHub account it's signed in as");
  return l;
}

interface Output {
  /** The exit code (null if a signal ended it). */
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

const ok = (o: Output) => o.code === 0;

function spawn_error(e: any): string {
  return e?.code === "ENOENT" ? "gh isn't installed on this host" : `couldn't run gh: ${e?.message ?? e}`;
}

/**
 * Runs `program` with `args` and collects its output. Past `timeout` it's killed (with its process group when `group`,
 * so the git it started doesn't carry on) and this throws `on_timeout`; it throws spawn_error's message if it can't start.
 */
function run(program: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number; group: boolean; on_timeout: string }): Promise<Output> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: o.group });
    } catch (e) {
      return reject(new Error(spawn_error(e)));
    }
    const out: Buffer[] = [], err: Buffer[] = [];
    let timed_out = false;
    const kill = () => {
      try {
        if (o.group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timed_out = true;
      kill();
    }, o.timeout);
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(spawn_error(e)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timed_out) return reject(new Error(o.on_timeout));
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/** gh's environment for these calls: no prompts or update checks, as `gh_env`'s account if it has one. */
function gh_vars(gh_env: GhEnv | null, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", ...extra };
  gh_env?.apply(env);
  return env;
}

/** What gh prints as JSON, run as `env`'s account (gh's active one without it), or why it failed. */
async function gh_json(env: GhEnv | null, args: string[]): Promise<any> {
  const out = await run(gh_mcp.gh_program(), args, { env: gh_vars(env), timeout: 60_000, group: false, on_timeout: "gh took more than 60 seconds" });
  if (!ok(out)) throw new Error(gh_error(out.stderr));
  try {
    return JSON.parse(out.stdout.toString("utf8"));
  } catch (e: any) {
    throw new Error(`couldn't read what gh printed: ${e?.message ?? e}`);
  }
}

/**
 * Runs gh in a process group of its own, which is killed if it runs over `limit`, so the
 * git it started doesn't carry on: its output, or why it didn't finish.
 */
function run_in_group(gh: string, args: string[], env: NodeJS.ProcessEnv, limit: number, cwd?: string): Promise<Output> {
  return run(gh, args, { env, cwd, timeout: limit, group: true, on_timeout: `it was still running after ${Math.floor(limit / 60_000)} minutes, so it was stopped` });
}

/** What gh said when it failed: its last few lines, less git's "Cloning into …". */
export function gh_error(stderr: Buffer | string): string {
  const text = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("Cloning into"));
  return lines.length ? lines.slice(Math.max(0, lines.length - 6)).join(" ") : "gh failed";
}

const name_chars = (p: string) => p.length > 0 && p.length <= 100 && /^[A-Za-z0-9\-_.]+$/.test(p);

/**
 * `OWNER/REPO` (a trailing `.git` dropped), if `s` is one: logins and repository names are
 * letters, digits, `-`, `_` and `.`, and a login doesn't start with the last three, so it's no
 * option to gh.
 */
export function check_repo(s: string): string | null {
  s = s.trim();
  const base = s.endsWith(".git") ? s.slice(0, -4) : s;
  const i = base.indexOf("/");
  if (i < 0) return null;
  const owner = base.slice(0, i), name = base.slice(i + 1);
  const good = name_chars(owner) && !/^[-_.]/.test(owner) && name_chars(name) && name !== "." && name !== "..";
  return good ? `${owner}/${name}` : null;
}

/** Each folder's lock (see reserve). */
const FOLDERS = new Map<string, AsyncMutex>();

/**
 * Holds `dest` for a clone and the project it becomes, so a request for the same folder waits
 * until the one before it is done (and then finds its project): returns the release function. Folders' locks are kept,
 * a few bytes each.
 */
export async function reserve(dest: string): Promise<() => void> {
  const key = folder(dest);
  let lock = FOLDERS.get(key);
  if (!lock) FOLDERS.set(key, (lock = new AsyncMutex()));
  return lock.lock();
}

/**
 * The folder `path` (absolute) names, however it's written, as the filesystem would have it once
 * the folders in it that aren't there yet are made (as real folders, the way a clone makes them):
 * each part that's there is resolved (symlinks too), and `..` is the parent of what came before.
 * So it's the same before a clone makes them as after.
 */
export function folder(path: string): string {
  let out = path.startsWith("/") ? "/" : "";
  for (const name of path.split("/")) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      out = out === "/" || out === "" ? out : dirname(out) === "." ? "" : dirname(out);
      continue;
    }
    out = out === "" ? name : join(out, name);
    try {
      out = realpathSync(out);
    } catch {}
  }
  return out;
}

const exists = (p: string) => existsSync(p);
const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const canonical = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const io_msg = (e: any) => e?.message ?? String(e);

/**
 * Clones `repo` (`OWNER/REPO`) into `dest`, a new or empty folder, as `account` (gh's active one
 * when null) with `gh` (the gh to run), as `gh repo clone` does: over the protocol gh is set up
 * to use for the account's host, with a fork's parent as its `upstream` remote. A clone of `repo`
 * that's there already is kept as it is. Returns whether it cloned. A clone that fails is taken
 * away again, leaving the folder as it was. Hold the folder meanwhile (`reserve`).
 */
export async function clone(gh: string, account: string | null, repo: string, dest: string): Promise<boolean> {
  const host = (account !== null ? gh_mcp.Account_parse(account)?.host : null) ?? "github.com";
  const existed = exists(dest);
  if (existed) {
    if (await is_clone_of(dest, host, repo)) return false;
    let empty = false;
    try {
      empty = readdirSync(dest).length === 0;
    } catch {}
    if (!empty) throw new Error(`${dest} already exists`);
  } else {
    const parent = dirname(dest);
    try {
      mkdirSync(parent, { recursive: true });
    } catch (e) {
      throw new Error(`couldn't create ${parent}: ${io_msg(e)}`);
    }
  }
  const env = await account_env(account);
  try {
    // The account's own gh config (see GhEnv) clones over HTTPS, so SSH is asked for by URL when
    // that's what gh is set up to use.
    const target =
      env && (await git_protocol(host)) === "ssh" ? `git@${host}:${repo}.git` : host !== "github.com" ? `${host}/${repo}` : repo;
    let exited: boolean, failed: string;
    try {
      const out = await run_in_group(gh, ["repo", "clone", target, dest], gh_vars(env, { GIT_TERMINAL_PROMPT: "0" }), CLONE_TIMEOUT);
      if (ok(out)) return true;
      [exited, failed] = [true, gh_error(out.stderr)];
    } catch (e) {
      [exited, failed] = [false, err_str(e)];
    }
    const cloned = await is_clone_of(dest, host, repo);
    // gh adds a fork's parent as its `upstream` remote once it's cloned it, which can fail with the
    // clone whole. Git keeps a clone whose checkout failed (to look into), which isn't.
    if (cloned && exited && (await checked_out(dest))) return true;
    if (cloned) remove_clone(dest, existed);
    throw new Error(`couldn't clone ${repo}: ${failed}`);
  } finally {
    drop_env(env);
  }
}

/** What `create` made. */
export interface Created {
  /** `OWNER/REPO`. */
  full_name: string;
  /** Whether the folder's commits were pushed to it (a folder without commits has none to push). */
  pushed: boolean;
  /** Why they weren't, when the repository was made but the push failed. */
  push_error: string | null;
}

/** A repository name on GitHub: letters, digits, `-`, `_` and `.`, up to 100 of them. */
export function check_name(s: string): string | null {
  s = s.trim();
  return name_chars(s) && s !== "." && s !== ".." ? s : null;
}

/**
 * Creates the GitHub repository `name` (under `owner`, the account's own login by default) as
 * `account` (gh's active one when null) with `gh repo create`, `private` or public, from the
 * folder `dir`: it becomes the repository's `origin`, and the folder's commits are pushed. A
 * folder that isn't a git repository yet is made one (`git init`), and a new folder is made. A
 * failure leaves the folder as it was. Hold the folder meanwhile (`reserve`).
 */
export async function create(gh: string, account: string | null, given_dir: string, owner_in: string | null, name: string, priv: boolean): Promise<Created> {
  const parsed = account !== null ? gh_mcp.Account_parse(account) : null;
  const host: string = parsed?.host ?? "github.com";
  const owner: string | null = owner_in?.trim() || parsed?.login || null;
  if (owner !== null && check_repo(`${owner}/${name}`) === null) throw new Error(`${owner}/${name} isn't a GitHub repository name`);
  // The folder the path names, however it's written (`..`, symlinks), before anything's made or checked,
  // so what's rolled back is what this call made and nothing that was there.
  const dir = folder(given_dir);
  // The folders this call makes, the destination first and then the ones above it that weren't there. A failure takes the
  // destination away (all of it is this call's) and the others only while they're empty: another request can be making a
  // folder next to this one, in the same new folder.
  const created: string[] = [];
  for (let a = dir; !lexists(a); a = dirname(a)) {
    created.push(a);
    if (dirname(a) === a) break;
  }
  const undo = (inited: boolean) => {
    if (created.length) {
      remove_dir_all(created[0]);
      for (const f of created.slice(1)) {
        try {
          rmdirSync(f);
        } catch {
          break;
        }
      }
    } else if (inited) remove_dir_all(join(dir, ".git"));
  };
  const fail = (inited: boolean, msg: string): never => {
    undo(inited);
    throw new Error(msg);
  };
  if (created.length) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      fail(false, `couldn't create ${dir}: ${io_msg(e)}`);
    }
  }
  let probe;
  try {
    probe = await worktree.git(dir, ["rev-parse", "--show-toplevel"]);
  } catch (e) {
    return fail(false, err_str(e));
  }
  const top = probe.ok ? canonical(probe.stdout.trim()) : null;
  // Git metadata that's there but that git won't open (another owner's, damaged) isn't initialized over,
  // and isn't ours to take away if the repository can't be created.
  if (top === null && lexists(join(dir, ".git"))) {
    fail(false, `${dir} has a .git that git can't use, so no repository was created: ${probe.stderr.trim()}`);
  }
  const inited = top === null;
  if (top !== null) {
    if (top !== canonical(dir)) fail(false, `${dir} is inside the repository ${top}: pick its top folder`);
    let has_origin = false;
    try {
      has_origin = (await worktree.git(dir, ["remote", "get-url", "origin"])).ok;
    } catch {}
    if (has_origin) fail(false, `${dir} already has a remote called origin`);
  } else {
    let o;
    try {
      o = await worktree.git(dir, ["init", "-q"]);
    } catch (e) {
      return fail(false, err_str(e));
    }
    if (!o.ok) fail(false, `git init failed: ${o.stderr.trim()}`);
  }
  let env: GhEnv | null;
  try {
    env = await account_env(account);
  } catch (e) {
    return fail(inited, err_str(e));
  }
  try {
    let has_commits = false;
    try {
      has_commits = (await worktree.git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).ok;
    } catch {}
    let target = owner !== null ? `${owner}/${name}` : name;
    if (host !== "github.com") target = `${host}/${target}`;
    const args = ["repo", "create", target, priv ? "--private" : "--public", "--source", dir, "--remote", "origin"];
    if (has_commits) args.push("--push");
    let stdout = "", failed: string | null = null;
    try {
      const out = await run_in_group(gh, args, gh_vars(env, { GIT_TERMINAL_PROMPT: "0" }), CREATE_TIMEOUT, dir);
      if (ok(out)) stdout = out.stdout.toString("utf8");
      else failed = gh_error(out.stderr);
    } catch (e) {
      failed = err_str(e);
    }
    // gh makes the repository and adds the remote before it pushes, so a push that fails leaves both.
    let remote: string | null = null;
    try {
      const o = await worktree.git(dir, ["remote", "get-url", "origin"]);
      if (o.ok) remote = o.stdout.trim();
    } catch {}
    const from_remote = remote !== null ? (worktree.remote_repo(remote)?.[1] ?? null) : null;
    let printed: string | null = null;
    for (const l of stdout.split("\n").reverse()) {
      const r = worktree.remote_repo(l.trim());
      if (r) {
        printed = r[1];
        break;
      }
    }
    const full = printed ?? from_remote ?? (owner !== null ? `${owner}/${name}` : null);
    let full_name: string;
    if (failed === null && full !== null) full_name = full;
    else if (failed !== null && full !== null && remote !== null) full_name = full;
    else return fail(inited, `couldn't create ${target}: ${failed ?? "gh didn't say what it made"}`);
    // The account's own gh config (see GhEnv) adds an HTTPS remote, so SSH is asked for by URL when
    // that's what gh is set up to use.
    if (env && (await git_protocol(host)) === "ssh") {
      try {
        await worktree.git(dir, ["remote", "set-url", "origin", `git@${host}:${full_name}.git`]);
      } catch {}
    }
    return { full_name, pushed: has_commits && failed === null, push_error: failed !== null ? `couldn't push to ${target}: ${failed}` : null };
  } finally {
    drop_env(env);
  }
}

/**
 * Whether the clone in `dir` is checked out whole: HEAD is a commit, and the index and working
 * tree have all of it (a checkout that fails partway leaves files out of them).
 */
async function checked_out(dir: string): Promise<boolean> {
  try {
    if (!(await worktree.git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).ok) return false;
    const o = await worktree.git(dir, ["status", "--porcelain", "--untracked-files=no"]);
    return o.ok && o.stdout.trim() === "";
  } catch {
    return false;
  }
}

/** Takes away the clone a failed `gh repo clone` left in `dest`: the folder, or what's in it if it was there (empty) before. */
function remove_clone(dest: string, existed: boolean) {
  if (!existed) {
    remove_dir_all(dest);
    return;
  }
  let entries;
  try {
    entries = readdirSync(dest, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // A symlink goes itself, rather than what it points to.
    try {
      if (e.isDirectory()) remove_dir_all(join(dest, e.name));
      else rmSync(join(dest, e.name), { force: true });
    } catch {}
  }
}

/** The protocol gh is set up to clone from `host` with (`https` or `ssh`), in its own config. */
async function git_protocol(host: string): Promise<string | null> {
  try {
    const out = await run(gh_mcp.gh_program(), ["config", "get", "git_protocol", "--host", host], {
      env: process.env,
      timeout: 10_000,
      group: false,
      on_timeout: "gh took more than 10 seconds",
    });
    const p = out.stdout.toString("utf8").trim();
    return ok(out) && p ? p : null;
  } catch {
    return null;
  }
}

/** Whether `dir` is a clone of `repo` on `host`: the top of a git repository with a remote there. */
export async function is_clone_of(dir: string, host: string, repo: string): Promise<boolean> {
  let top: string | null = null;
  try {
    const o = await worktree.git(dir, ["rev-parse", "--show-toplevel"]);
    if (o.ok) top = canonical(o.stdout.trim());
  } catch {}
  if (top === null || top !== canonical(dir)) return false;
  let urls;
  try {
    urls = await worktree.git(dir, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  } catch {
    return false;
  }
  for (const l of urls.stdout.split("\n")) {
    const sp = l.indexOf(" ");
    if (sp < 0) continue;
    const r = worktree.remote_repo(l.slice(sp + 1).trim());
    if (!r) continue;
    const [h, name] = r;
    const host_ok = host === "github.com" ? worktree.is_github_com(h) : h === host;
    if (host_ok && name.toLowerCase() === repo.toLowerCase()) return true;
  }
  return false;
}
