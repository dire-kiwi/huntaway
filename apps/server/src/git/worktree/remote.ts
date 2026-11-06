// Port of server/src/git/worktree/remote.rs.
/** The GitHub repository a task's pull request goes to (`github`), from its repository's remotes. */
import { git, git_ok, lines, output } from "../worktree.ts";

/** The GitHub repository a task's pull request goes to: the remote to push to, and the repository's `OWNER/REPO`. */
export interface Github {
  remote: string;
  repo: string;
}

/** Hooks for tests (Rust's `#[cfg(test)]` thread-locals). */
export const remote_testing = {
  /** The SSH config `ssh_hostname` reads (`ssh -F`), in place of the user's. */
  SSH_CONFIG: null as string | null,
};

/**
 * Where a task branched from `base` in `repo` opens its pull request, if that's on GitHub: `base`'s upstream remote, or
 * else `origin` (or the only remote), going by where it pushes to.
 */
export async function github(repo: string, base: string | null | undefined): Promise<Github | null> {
  const pushed = await push_remote(repo, base);
  if (!pushed) return null;
  const [remote, url] = pushed;
  const r = remote_repo(url.trim());
  if (!r) return null;
  const [host, name] = r;
  return is_github_com(await ssh_hostname(url.trim(), host)) ? { repo: name, remote } : null;
}

/** The host and `OWNER/REPO` that a task branched from `base` in `repo` pushes to, as `github` picks the remote, on any host. */
export async function push_repo(repo: string, base: string | null | undefined): Promise<[string, string] | null> {
  const pushed = await push_remote(repo, base);
  if (!pushed) return null;
  const url = pushed[1];
  const r = remote_repo(url.trim());
  if (!r) return null;
  return [await ssh_hostname(url.trim(), r[0]), r[1]];
}

/**
 * The host that an SSH remote's `host` (see `remote_repo`) stands for: an alias's `HostName` in the SSH config, as
 * `ssh -G` has it. Several GitHub accounts are often set up with an alias for each one's key (`git@github-work:o/r.git`).
 * Other remotes' hosts, and those ssh can't look up, are as they are.
 */
async function ssh_hostname(url: string, host: string): Promise<string> {
  const ssh = !url.includes("://") || ["ssh://", "git+ssh://", "ssh+git://"].some((p) => url.startsWith(p));
  const alias = !is_github_com(host) && !host.startsWith("-") && /^[A-Za-z0-9\-_.]*$/.test(host);
  if (!ssh || !alias) return host;
  const args = remote_testing.SSH_CONFIG !== null ? ["-F", remote_testing.SSH_CONFIG] : [];
  args.push("-G", "--", host);
  let out;
  try {
    out = await output("ssh", args, { timeout: 5000 });
  } catch {
    return host;
  }
  if (!out.success) return host;
  const line = lines(out.stdout.toString()).find((l) => l.startsWith("hostname "));
  const name = line?.slice("hostname ".length).trim().toLowerCase();
  return name ? name : host;
}

/** The remote `github` picks, and its push URL. */
export async function push_remote(repo: string, base: string | null | undefined): Promise<[string, string] | null> {
  let listed;
  try {
    listed = await git(repo, ["remote"]);
  } catch {
    return null;
  }
  if (!listed.ok) return null;
  const remotes = lines(listed.stdout)
    .map((r) => r.trim())
    .filter((r) => r);
  let upstream: string | null = null;
  if (base) {
    try {
      upstream = (await git(repo, ["config", `branch.${base}.remote`])).stdout.trim();
    } catch {
      upstream = null;
    }
  }
  const remote = upstream !== null && remotes.includes(upstream) ? upstream : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (remote === null) return null;
  try {
    return [remote, await git_ok(repo, ["remote", "get-url", "--push", remote])];
  } catch {
    return null;
  }
}

/**
 * The host (lowercase) and `OWNER/REPO` of a remote URL with a path of that shape, on any host: `git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@ssh.github.com:443/o/r.git` and the like.
 */
export function remote_repo(url: string): [string, string] | null {
  let host: string, path: string;
  const scheme = url.indexOf("://");
  if (scheme >= 0) {
    const rest = url.slice(scheme + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    host = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    // scp-like `[user@]host:path`; a local path has a slash before any colon.
    const colon = url.indexOf(":");
    if (colon < 0) return null;
    host = url.slice(0, colon);
    path = url.slice(colon + 1);
    if (host.includes("/")) return null;
  }
  const at = host.split("@");
  host = at[at.length - 1].split(":")[0].toLowerCase();
  path = path.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  return owner && name ? [host, `${owner}/${name}`] : null;
}

/** Whether a remote's host is github.com's (its web, or SSH over HTTPS's port). */
export function is_github_com(host: string): boolean {
  return ["github.com", "www.github.com", "ssh.github.com"].includes(host);
}
