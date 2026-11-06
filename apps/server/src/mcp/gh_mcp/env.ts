// Port of server/src/mcp/gh_mcp/env.rs: running gh as one account and no other (`GhEnv`), `huntaway gh-run`,
// authenticated git fetches, and the accounts gh is signed in to.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { constants as os_constants } from "node:os";
import { delimiter, join } from "node:path";
import { context, new_id, path_str } from "../../util.ts";
import { ACCOUNT_ENV, refuse } from "../gh_mcp.ts";
import { Account } from "./account.ts";

/** A test hook, as Rust's thread-local cells: `.set(v)` and `.get()`. */
export class Cell<T> {
  private v: T;
  constructor(v: T) {
    this.v = v;
  }
  set(v: T) {
    this.v = v;
  }
  get(): T {
    return this.v;
  }
}

/** The gh tests run instead of `gh` (Rust's `TEST_GH_PROGRAM`). Null outside tests. */
export const TEST_GH_PROGRAM = new Cell<string | null>(null);
/** The board's `BOARD_ENV` for tests, in place of the environment's. */
export const TEST_BOARD = new Cell<[string, string, string] | null>(null);

/** The gh to run: `IA_GH_BIN` (for `gh-run`, which is `gh` on its commands' PATH), or else `gh`. */
export function gh_program(): string {
  const test = TEST_GH_PROGRAM.get();
  if (test !== null) return test;
  return process.env.IA_GH_BIN || "gh";
}

/** The host of a URL (`https://`, `ssh://`, …). */
export function url_host(s: string): string | null {
  s = ascii_lower(s.trim());
  const i = s.indexOf("://");
  if (i < 0) return null;
  const scheme = s.slice(0, i),
    rest = s.slice(i + 3);
  if (!scheme || !/^[a-z0-9+.\-]+$/i.test(scheme)) return null;
  const authority = rest.split(/[/?#]/)[0];
  const at = authority.split("@");
  return at[at.length - 1].split(":")[0];
}

export function ascii_lower(s: string): string {
  return s.replace(/[A-Z]+/g, (c) => c.toLowerCase());
}

/** What a command printed, and how it ended. */
export interface CmdOutput {
  /** The exit code, or null if a signal ended it. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  /** It ran over its time and was killed. */
  timed_out: boolean;
}

/**
 * Run `program` with `args` (stdin empty) and collect its output, as tokio's `Command::output()` under a timeout
 * (with `kill_on_drop`). Rejects if it couldn't be started.
 */
export function command_output(program: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<CmdOutput> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let done = false;
    const timer = opts.timeout
      ? setTimeout(() => {
          if (done) return;
          done = true;
          child.kill("SIGKILL");
          resolve({ code: null, signal: "SIGKILL", stdout: Buffer.concat(out), stderr: Buffer.concat(err), timed_out: true });
        }, opts.timeout)
      : null;
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timed_out: false });
    });
  });
}

/** How Rust shows an `ExitStatus`. */
export function exit_status(o: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (o.code !== null) return `exit status: ${o.code}`;
  const n = o.signal ? ((os_constants.signals as any)[o.signal] ?? 0) : 0;
  return `signal: ${n} (${o.signal ?? "unknown"})`;
}

/**
 * Every URL `remote` (a remote's name) pushes to in `dir`, with git's URL rewrites (`pushInsteadOf`, `insteadOf`)
 * applied. Null if there's no such remote.
 */
export async function push_urls(dir: string | null, remote: string): Promise<string[] | null> {
  let out;
  try {
    out = await command_output("git", ["remote", "get-url", "--push", "--all", "--", remote], { cwd: dir ?? undefined });
  } catch {
    return null;
  }
  const urls = out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);
  return out.code === 0 && urls.length ? urls : null;
}

/**
 * git's `-c` options that empty every `http.extraHeader` (generic, and scoped to a URL or path) configured where `dir`
 * pushes from, so no `Authorization` header pushes as another account instead of the credential helper's (see
 * `Account.git_config`). An empty value clears the headers set before it for its own key only, so each key that's set
 * is cleared.
 */
export async function extra_header_resets(dir: string | null): Promise<string[]> {
  let text = "";
  try {
    text = (await command_output("git", ["config", "--get-regexp", "^http\\..*extraheader$"], { cwd: dir ?? undefined })).stdout.toString();
  } catch {}
  const keys = text
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split(" ")[0])
    .filter((k) => k);
  keys.push("http.extraheader");
  const sorted = [...new Set(keys)].sort();
  return sorted.flatMap((k) => ["-c", `${k}=`]);
}

/** Where gh (and the GitHub tools it follows) may find tokens in the environment. */
export const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** Removes a GhEnv's folder if it's garbage collected without `drop()` (Rust drops it when it goes). */
const leftovers = new FinalizationRegistry<string>((dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

/**
 * The environment for gh to act as one account and no other. gh's config is a folder of its own (GH_CONFIG_DIR, removed
 * by `drop()`) with a login for the account's host only, so gh has no token for any other host, whatever a command
 * names: unlike GH_ENTERPRISE_TOKEN, which gh sends to every host but github.com. There are no tokens in the
 * environment, the keyring is out of reach on Linux (gh looks there for hosts it has no login for: the Secret Service,
 * over the session bus), and GH_HOST is the account's host, so calls that don't name a host go there and gh refuses a
 * repository whose remotes are elsewhere.
 *
 * Rust removes the folder when the value is dropped: call `drop()` (or hold it with `using`) once gh is done with it.
 */
export class GhEnv {
  account: Account;
  dir: string;
  private dropped = false;
  constructor(account: Account, dir: string) {
    this.account = account;
    this.dir = dir;
    leftovers.register(this, dir, this);
  }

  /** Remove its folder (Rust's `Drop`). */
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    leftovers.unregister(this);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  }

  [Symbol.dispose]() {
    this.drop();
  }

  /**
   * Set up `env`, a gh command's environment, to run as the account: removed variables are set to `undefined` (which
   * spawn leaves out, and which overrides the inherited ones when `env` is merged over `process.env`). Check its targets
   * first (`check`), and set GH_REPO after this if it has one (an inherited one is removed).
   */
  apply(env: NodeJS.ProcessEnv) {
    for (const v of [...TOKEN_VARS, "GH_REPO"]) env[v] = undefined;
    env.GH_CONFIG_DIR = this.dir;
    env.GH_HOST = this.account.host;
    if (process.platform === "linux") env.DBUS_SESSION_BUS_ADDRESS = "disabled:";
  }

  /** Fails if gh with these arguments (and `GH_REPO`) would reach another host than the account's (see `Account.check_targets`). */
  check(args: string[], repo: string | null) {
    this.account.check_targets(args, repo);
  }

  /**
   * The environment for a shell command (a wait's) whose gh calls act as the account. The shell doesn't get the token:
   * `gh` on its PATH is a script in `shim_dir` that runs `exe gh-run`, which checks each call's targets as the gh tools
   * do and runs gh with the token.
   */
  shell_env(exe: string, shim_dir: string): Array<[string, string]> {
    const path = process.env.PATH ?? "";
    const dirs = path.split(delimiter).filter((d) => d !== shim_dir);
    const real = dirs.map((d) => join(d, "gh")).find((g) => is_file(g));
    if (!real) throw new Error("gh isn't installed");
    mkdirSync(shim_dir, { recursive: true });
    const shim = join(shim_dir, "gh");
    const script = `#!/bin/sh\nexec '${path_str(exe).replaceAll("'", "'\\''")}' gh-run "$@"\n`;
    let current: string | null = null;
    try {
      current = readFileSync(shim, "utf8");
    } catch {}
    if (current !== script) {
      // Written aside and renamed, so a command running it never sees half of it.
      const tmp = join(shim_dir, `.gh-${new_id()}`);
      writeFileSync(tmp, script);
      chmodSync(tmp, 0o755);
      renameSync(tmp, shim);
    }
    return [
      ["PATH", [shim_dir, ...path.split(delimiter).filter((d) => d !== shim_dir)].join(delimiter)],
      [ACCOUNT_ENV, this.account.toString()],
      ["IA_GH_BIN", real],
    ];
  }
}

function is_file(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `huntaway gh-run <args>`: gh in a wait's command, for a task with a GitHub account (see `GhEnv.shell_env`). Refuses
 * calls that would reach another host, and runs the rest with the account's token. Returns gh's exit code.
 */
export async function gh_run(args: string[]): Promise<number> {
  const account = Account.from_env();
  if (!account) throw new Error(`${ACCOUNT_ENV} isn't set`);
  const repo = process.env.GH_REPO || null;
  refuse(args);
  account.check_targets(args, repo);
  const ghenv = account.env(await account.token());
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    ghenv.apply(env);
    if (repo) env.GH_REPO = repo;
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(gh_program(), args, { env, stdio: "inherit" });
      child.on("error", (e) => reject(context("couldn't run gh", e)));
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    ghenv.drop();
  }
}

/**
 * The environment that makes gh act as `account` (a profile's or project's, see `Account`), for the host's own gh
 * calls. Fails when that account isn't signed in to gh. The caller drops it (`drop()`) once gh is done with it.
 */
export async function account_env(account: string | null | undefined): Promise<GhEnv | null> {
  const a = account ? Account.parse(account) : null;
  if (!a) return null;
  return a.env(await a.token());
}

/** A command being built (tokio's `Command`): `authenticate_fetch` adds to its arguments and environment. */
export interface Cmd {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Give a host-side fetch the selected account's credentials for HTTPS on its host. Resolve insteadOf rewrites first;
 * SSH, local repositories and other hosts keep git's usual auth. No repository or global config is written, and a
 * missing login never falls back to another. Adds `-c` options to `cmd.args` (so call it before adding the git
 * command's own arguments) and the token to `cmd.env`.
 */
export async function authenticate_fetch(cmd: Cmd, repo: string, remote: string, account: string | null | undefined): Promise<void> {
  const a = account ? Account.parse(account) : null;
  if (!a) return;
  const worktree = await import("../../git/worktree.ts");
  const out = await worktree.git(repo, ["remote", "get-url", "--", remote]);
  if (!out.ok) throw new Error(`couldn't read the fetch URL for ${remote}: ${out.stderr.trim()}`);
  const url = out.stdout.trim();
  if (!ascii_lower(url).startsWith("https://") || url_host(url) !== a.host) return;
  a.check_git_urls([url]);
  const token = await a.token();
  cmd.args.push(...(await extra_header_resets(repo)), ...a.git_config());
  cmd.env.IA_GH_GIT_TOKEN = token;
}

/**
 * The accounts gh is signed in to on this host, for picking one: `{accounts: [{account, host, login, active, ok}],
 * error}`. `account` is what a profile or project saves.
 */
export async function accounts(): Promise<any> {
  let out;
  try {
    out = await command_output(gh_program(), ["auth", "status", "--json=hosts"], { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 30_000 });
  } catch (e: any) {
    return { accounts: [], error: `couldn't run gh: ${io_error(e)}` };
  }
  if (out.timed_out) return { accounts: [], error: "gh auth status timed out" };
  let v: any;
  try {
    v = JSON.parse(out.stdout.toString());
  } catch {
    v = undefined;
  }
  if (v !== undefined && out.code === 0) return { accounts: accounts_from_status(v), error: null };
  return { accounts: [], error: `gh auth status failed: ${out.stderr.toString().trim()}` };
}

/** An I/O error as Rust's `io::Error` shows it (`No such file or directory (os error 2)`). */
export function io_error(e: any): string {
  if (e?.code === "ENOENT") return "No such file or directory (os error 2)";
  if (e?.code === "EACCES") return "Permission denied (os error 13)";
  return e?.message ?? String(e);
}

export function accounts_from_status(v: any): any[] {
  const out: any[] = [];
  const hosts = v?.hosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return out;
  // serde_json's maps are sorted by key.
  for (const host of Object.keys(hosts).sort()) {
    const list = hosts[host];
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const login = a?.login;
      const account = typeof login === "string" ? Account.parse(`${host}/${login}`) : null;
      if (!account) continue;
      out.push({ account: account.toString(), host: account.host, login: account.login, active: a.active === true, ok: a.state === "success" });
    }
  }
  return out;
}
