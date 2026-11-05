// Port of server/src/git/worktree/upstream.rs.
/** The branch a base branch follows, fetching it, and where a new task branch starts from it (`start_point`, `compare_ref`). */
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import { context, err_str } from "../../util.ts";
import { checked_out_in, commit, git, git_env, git_ok, is_ancestor, lines, output, plural } from "../worktree.ts";

/** The branch a base branch follows. */
export interface Upstream {
  remote: string;
  /** Its ref on the remote (`refs/heads/master`). */
  merge: string;
  /** Where it's fetched to (`refs/remotes/origin/master`), or a local branch for an upstream in the repository itself (remote `.`). */
  tracking: string;
}

/** Its short name, e.g. `origin/master`. */
export function upstream_name(up: Upstream): string {
  if (up.tracking.startsWith("refs/remotes/")) return up.tracking.slice("refs/remotes/".length);
  if (up.tracking.startsWith("refs/heads/")) return up.tracking.slice("refs/heads/".length);
  return up.tracking;
}

/**
 * The branch base branch `base` follows: its upstream or, for one without (pushed without `-u`, say, or only on the
 * remote), the branch of the same name on `origin` (or the only remote), if that was fetched before or there's no local
 * branch. A remote's branch named with it (`upstream/feature`, with no local branch of that name) is that branch on that
 * remote, fetched or not. None for a tag, a commit or `HEAD`.
 */
export async function upstream(repo: string, base: string): Promise<Upstream | null> {
  const local = `refs/heads/${base}`;
  const has_local = (await commit(repo, local)) !== null;
  if (!has_local) {
    const rb = await remote_branch(repo, base);
    if (rb) {
      const [remote, name] = rb;
      return { tracking: `refs/remotes/${base}`, remote, merge: `refs/heads/${name}` };
    }
  }
  if (has_local) {
    const config = async (key: string) => {
      try {
        return (await git(repo, ["config", `branch.${base}.${key}`])).stdout.trim();
      } catch {
        return "";
      }
    };
    const remote = await config("remote"), merge = await config("merge");
    if (remote && merge) {
      let tracking: string;
      try {
        tracking = (await git_ok(repo, ["for-each-ref", "--format=%(upstream)", local])).trim();
      } catch {
        return null;
      }
      return tracking ? { remote, merge, tracking } : null;
    }
  } else if (base === "HEAD" || (await commit(repo, base)) !== null) {
    return null;
  }
  let listed: string;
  try {
    listed = await git_ok(repo, ["remote"]);
  } catch {
    return null;
  }
  const remotes = lines(listed).map((r) => r.trim()).filter((r) => r);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (remote === null) return null;
  const tracking = `refs/remotes/${remote}/${base}`;
  if (has_local && (await commit(repo, tracking)) === null) return null;
  return { remote, merge: local, tracking };
}

/** The remote and branch `name` stands for when it's a remote's name, a slash and a branch. */
export async function remote_branch(repo: string, name: string): Promise<[string, string] | null> {
  const i = name.indexOf("/");
  if (i <= 0 || i === name.length - 1) return null;
  const remote = name.slice(0, i), rest = name.slice(i + 1);
  let remotes: string;
  try {
    remotes = await git_ok(repo, ["remote"]);
  } catch {
    return null;
  }
  return lines(remotes).some((l) => l.trim() === remote) ? [remote, rest] : null;
}

/** A git command being put together, for `gh_mcp.authenticate_fetch` to add its arguments and environment to. */
export interface GitCmd {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Run `git -C repo <cmd.args> <args>` (with `cmd.env`), stopped after `limit_ms`; throws `timed_out` if it runs over. */
export async function run_fetch(cmd: GitCmd, repo: string, args: string[], limit_ms: number, failed: (stderr: string) => string, timed_out: string) {
  const out = await output("git", ["-C", repo, ...cmd.args, ...args], { env: cmd.env, timeout: limit_ms }).catch((e) => {
    throw context("failed to run git fetch", e);
  });
  if (out.code === null && !out.success) throw new Error(timed_out);
  if (!out.success) throw new Error(failed(out.stderr.toString().trim()));
}

/** Fetch `up` (unless it's in the repository itself). */
export async function fetch(repo: string, up: Upstream, account: string | null): Promise<void> {
  if (up.remote === ".") return;
  const refspec = `+${up.merge}:${up.tracking}`;
  const cmd: GitCmd = { args: [], env: git_env() };
  const started = Date.now();
  await gh_mcp.authenticate_fetch(cmd, repo, up.remote, account);
  const left = Math.max(1, 60_000 - (Date.now() - started));
  await run_fetch(cmd, repo, ["fetch", "--quiet", "--no-tags", up.remote, refspec], left, (e) => `git fetch ${up.remote} failed: ${e}`, `git fetch ${up.remote} timed out`);
}

/** Fetch base branch `base`'s upstream (see `upstream`), returning its name (e.g. `origin/master`), or None when it has none. */
export async function fetch_upstream(repo: string, base: string, account: string | null): Promise<string | null> {
  const up = await upstream(repo, base);
  if (!up) return null;
  await fetch(repo, up, account);
  return upstream_name(up);
}

/**
 * What a task branched from base branch `base` is compared with to find its own work: the newer of the local branch and
 * its upstream as last fetched, as `start_point` picks (the upstream when they've diverged), without fetching. The
 * upstream when there's no local branch, and `base` as is when it has no upstream or that was never fetched.
 */
export async function compare_ref(repo: string, base: string): Promise<string> {
  const up = await upstream(repo, base);
  if (!up) return base;
  const theirs = await commit(repo, up.tracking);
  if (theirs === null) return base;
  const ours = await commit(repo, `refs/heads/${base}`);
  if (ours !== null && (await is_ancestor(repo, theirs, ours))) return base;
  return upstream_name(up);
}

/** Where a new task branch starts. */
export interface Start {
  /** The commit, or `base` as given when it has no upstream. */
  rev: string;
  /** What it is, for the task log: `master` or `origin/master`. */
  from: string;
  /** Events for the task log: level, text and detail. */
  notes: Array<[string, string, string | null]>;
}

/**
 * Where a task branch from base branch `base` starts: the newer of the local branch and its upstream (fetched first), so
 * it starts from the latest commit even when the local branch is behind and can't be fast-forwarded (it's checked out
 * with changes in the way, say). The local branch is fast-forwarded when it can be. When the two have diverged it's the
 * upstream, which is where the task's pull request goes; when the local branch is ahead (with commits that aren't
 * pushed), it's the local branch. If the fetch fails, it goes by the last one.
 */
export async function start_point(repo: string, base: string, account: string | null): Promise<Start> {
  const start: Start = { rev: base, from: base, notes: [] };
  const up = await upstream(repo, base);
  if (!up) return start;
  const name = upstream_name(up);
  try {
    await fetch(repo, up, account);
  } catch (e) {
    start.notes.push(["warn", `Could not fetch ${name}; branching from the copy fetched before`, err_str(e)]);
  }
  const theirs = await commit(repo, up.tracking);
  if (theirs === null) return start;
  const local = `refs/heads/${base}`;
  const ours = await commit(repo, local);
  if (ours === null) {
    start.rev = theirs;
    start.from = name;
    return start;
  }
  if (await is_ancestor(repo, theirs, ours)) {
    start.rev = ours;
    return start;
  }
  const count = async (range: string) => {
    try {
      return (await git_ok(repo, ["rev-list", "--count", range])).trim();
    } catch {
      return "?";
    }
  };
  if (!(await is_ancestor(repo, ours, theirs))) {
    const n = await count(`${theirs}..${ours}`);
    start.notes.push(["warn", `${base} has diverged from ${name}; branching from ${name}, without the ${n} commit${plural(n)} only ${base} has`, null]);
    start.rev = theirs;
    start.from = name;
    return start;
  }
  const n = await count(`${ours}..${theirs}`);
  const dir = await checked_out_in(repo, local);
  let pulled: Error | null = null;
  try {
    if (dir !== null) await git_ok(dir, ["merge", "--ff-only", "--quiet", theirs]);
    else await git_ok(repo, ["update-ref", "-m", "huntaway: pull before worktree", local, theirs, ours]);
  } catch (e) {
    pulled = e;
  }
  if (pulled === null) {
    start.notes.push(["info", `Pulled ${base} from ${name} (${n} new commit${plural(n)})`, null]);
    start.rev = theirs;
  } else {
    const text = `Branching from ${name}, ${n} commit${plural(n)} ahead of ${base}, which couldn't be fast-forwarded`;
    start.notes.push(["info", text, err_str(pulled)]);
    start.rev = theirs;
    start.from = name;
  }
  return start;
}
