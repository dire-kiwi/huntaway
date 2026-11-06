// Port of server/src/mcp/gh_mcp/account.rs: GitHub accounts gh is signed in to, their tokens, and checking that a
// command reaches only its account's host.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { context, new_id } from "../../util.ts";
import { ACCOUNT_ENV } from "../gh_mcp.ts";
import { GhEnv, ascii_lower, command_output, gh_program } from "./env.ts";
import { CommandHelp, command_help, fallback_targets, repo_host } from "./targets.ts";

const ascii_alnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

/**
 * A GitHub account gh is signed in to: a login on github.com, or `HOST/LOGIN` on another GitHub host (Enterprise Cloud
 * with data residency, `*.ghe.com`, or Enterprise Server).
 */
export class Account {
  host: string;
  login: string;
  constructor(host: string, login: string) {
    this.host = host;
    this.login = login;
  }

  static parse(s: string): Account | null {
    s = s.trim();
    const i = s.indexOf("/");
    const [host, login] = i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : ["github.com", s];
    // Logins are letters, digits and hyphens (Enterprise managed users add `_shortcode`).
    const login_ok =
      login.length > 0 && Buffer.byteLength(login) <= 100 && !login.startsWith("-") && [...login].every((c) => ascii_alnum(c) || c === "-" || c === "_");
    const host_ok = host.length > 0 && !host.startsWith("-") && !host.startsWith(".") && [...host].every((c) => ascii_alnum(c) || ".-:".includes(c));
    return login_ok && host_ok ? new Account(ascii_lower(host), login) : null;
  }

  /** The run's account, if it has one. */
  static from_env(): Account | null {
    const v = process.env[ACCOUNT_ENV];
    return v === undefined ? null : Account.parse(v);
  }

  is_github_com(): boolean {
    return this.host === "github.com";
  }

  /** The account's token from gh's logins on this host. */
  async token(): Promise<string> {
    // Its own token, not one in the environment.
    const env = { ...process.env };
    for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[v];
    let out;
    try {
      out = await command_output(gh_program(), ["auth", "token", `--hostname=${this.host}`, `--user=${this.login}`], { env, timeout: 30_000 });
    } catch (e) {
      throw context(`couldn't get a token for the GitHub account ${this}: couldn't run gh`, e);
    }
    if (out.timed_out) throw new Error(`couldn't get a token for the GitHub account ${this}: gh auth token timed out`);
    const token = out.stdout.toString().trim();
    if (out.code !== 0 || !token) {
      throw new Error(
        `the GitHub account ${this} isn't signed in to gh on this host (${out.stderr.toString().trim()}). Sign in to it with \`gh auth login${
          this.is_github_com() ? "" : ` --hostname ${this.host}`
        }\`, or pick another account in the profile's or project's settings.`,
      );
    }
    return token;
  }

  /** The environment that makes gh act as the account and no other, given its token: see `GhEnv`. */
  env(token: string): GhEnv {
    const root = join(cache_dir() ?? tmpdir(), "huntaway", "gh-account");
    try {
      mkdirSync(root, { recursive: true });
    } catch (e) {
      throw context(`couldn't create ${root}`, e);
    }
    // Left behind by a process that was killed while gh ran.
    const stale = Date.now() - 24 * 3600 * 1000;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {}
    for (const e of entries) {
      try {
        if (statSync(join(root, e)).mtimeMs < stale) rmSync(join(root, e), { recursive: true, force: true });
      } catch {}
    }
    const dir = join(root, new_id());
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      throw context(`couldn't create ${dir}`, e);
    }
    const env = new GhEnv(this, dir);
    try {
      // As gh writes a login it keeps out of the keyring (`gh auth login --insecure-storage`).
      // JSON strings are YAML's double-quoted ones.
      const [host, login, tok] = [JSON.stringify(this.host), JSON.stringify(this.login), JSON.stringify(token)];
      const hosts = `${host}:\n    users:\n        ${login}:\n            oauth_token: ${tok}\n    oauth_token: ${tok}\n    user: ${login}\n    git_protocol: https\n`;
      writeFileSync(join(dir, "hosts.yml"), hosts, { flag: "wx", mode: 0o600 });
    } catch (e) {
      env.drop();
      throw e;
    }
    return env;
  }

  /**
   * Whether `host` (of a URL) is one of the account's: its host, or its API's (`api.github.com` for github.com,
   * `api.acme.ghe.com` for `acme.ghe.com`; Enterprise Server's API is on its host), uploads' or gists'
   * (`gist.github.com`).
   */
  owns_host(host: string): boolean {
    host = ascii_lower(host);
    return host === this.host || ["api.", "uploads.", "gist."].some((p) => host.startsWith(p) && host.slice(p.length) === this.host);
  }

  /**
   * Fails if a gh command (its arguments and `GH_REPO`) names a host other than the account's, where gh would act as
   * another account (or send this one's token): `--hostname`, a repository given as `HOST/OWNER/REPO` or a URL (with
   * `--repo`, `--source` or `--branch-repo`), and the command's arguments that say where it goes, as its help has them:
   * URLs as a pull request, issue or gist (`gh pr view <url>`) or API endpoint, and repositories as `HOST/OWNER/REPO`,
   * `[USER@]HOST:PATH` or a URL (`gh repo clone <repository>`). What else it's given (texts, fields, search queries, a
   * repository's homepage) isn't checked. Without its help (gh missing, a command gh doesn't have), every argument is,
   * but options' values that are always content (see `CONTENT_OPTIONS`).
   */
  check_targets(args: string[], repo: string | null) {
    const help = command_help(args);
    this.check_targets_with(args, repo, help);
  }

  /** `check_targets` with the command's help (see `command_help`), if there is one. */
  check_targets_with(args: string[], repo: string | null, help: CommandHelp | null) {
    const hosts: string[] = [];
    const rh = repo !== null ? repo_host(repo) : null;
    if (rh !== null) hosts.push(rh);
    hosts.push(...(help ? help.targets(args) : fallback_targets(args)));
    const h = hosts.find((h) => !this.owns_host(h));
    if (h !== undefined) throw new Error(`this project's GitHub account is ${this}, so the gh tools only reach ${this.host}: not ${h}`);
  }

  /**
   * Fails if git would use any of `urls` (see `push_urls`) as another account: on another host, or over HTTP(S) with
   * credentials in the URL, which git uses instead of asking the credential helper for the account's (see
   * `git_config`).
   */
  check_git_urls(urls: string[]) {
    // URLs, not a gh command: each is checked.
    this.check_targets_with(urls, null, null);
    for (const url of urls) {
      const lower = ascii_lower(url.trim());
      const rest = lower.startsWith("https://") ? lower.slice(8) : lower.startsWith("http://") ? lower.slice(7) : null;
      if (rest !== null && rest.split(/[/?#]/)[0].includes("@")) {
        throw new Error(`the remote URL has a login in it, which git would use instead of the GitHub account ${this}: remove it from the remote's URL`);
      }
    }
  }

  /**
   * git's `-c` options that give the account's token (in `IA_GH_GIT_TOKEN`) for HTTPS on its host, in place of other
   * credential helpers for that host (such as gh's own, which would use gh's active account). Fetches and pushes over
   * SSH still use the host's SSH keys.
   */
  git_config(): string[] {
    const key = `credential.https://${this.host}.helper`;
    const helper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$IA_GH_GIT_TOKEN"; }; f`;
    return ["-c", `${key}=`, "-c", `${key}=${helper}`];
  }

  toString(): string {
    return this.is_github_com() ? this.login : `${this.host}/${this.login}`;
  }
}

/** `Account::parse`. */
export function Account_parse(s: string): Account | null {
  return Account.parse(s);
}

/** `dirs::cache_dir()` on Linux: `$XDG_CACHE_HOME`, else `~/.cache`. */
function cache_dir(): string | null {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  let home: string | null = null;
  try {
    home = process.env.HOME || homedir() || null;
  } catch {}
  return home ? join(home, ".cache") : null;
}
