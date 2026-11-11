import { fallbackTargets, helpTargets, repoHost } from "./ghTargets.ts"
import { asciiLower } from "./keys.ts"
import type { CommandHelp } from "./ghTargets.ts"

// Running gh as one GitHub account and no other (docs/plan/inventory/03-mcp.md 2.10, 2.13): what the board's gh tools
// (`github/Gh.ts`) and `huntaway gh-run` (a wait's gh, `apps/server/src/hooks/ghRun.ts`) share. From huntaway's
// mcp/gh_mcp.ts (`refuse`), mcp/gh_mcp/account.ts (`Account`) and mcp/gh_mcp/env.ts (`GhEnv`, `no_repo_commands`,
// `repo_commands`, `shell_env`). Plain TypeScript with no I/O: each side runs gh and git its own way.

/** The environment variable a wait's command gets its task's GitHub account in, for `gh-run` (the old `IA_GH_ACCOUNT`). */
export const ACCOUNT_ENV = "HUNTAWAY_GH_ACCOUNT"
/** The real gh, for `gh-run`, which is `gh` on a wait's command's PATH (the old `IA_GH_BIN`). */
export const GH_BIN_ENV = "HUNTAWAY_GH_BIN"
/** Where `gh-run` makes its private gh config folders: the server's root, so one sweep covers both. */
export const GH_CONFIG_ROOT_ENV = "HUNTAWAY_GH_CONFIG_ROOT"
/** The token git_push's credential helper reads (the old `IA_GH_GIT_TOKEN`). */
export const GIT_TOKEN_ENV = "HUNTAWAY_GH_GIT_TOKEN"

/** Where gh (and the GitHub tools it follows) may find tokens in the environment. */
export const TOKEN_VARS: ReadonlyArray<string> = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]

/** Set for every gh and git the tools run: nothing asks, pages or colours its output, and gh doesn't look for updates. */
export const GH_FIXED_ENV: Readonly<Record<string, string>> = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
}

/** A private gh config folder older than this was left by a process killed while gh ran (ms). */
export const STALE_CONFIG_MS = 24 * 3600 * 1000

/**
 * Why gh's arguments are turned away, or null: gh commands no agent gets, whatever its permission mode (the gh tool's
 * approval doesn't apply in auto or bypass): `gh auth` (`gh auth token` would put the account's token in the thread, as
 * would `config get` of a host's `oauth_token`), and those that change what later gh commands run (extensions,
 * aliases, settings). gh's command comes first: a flag before it could take the next argument as its value, so only
 * `--help` and `--version` may.
 */
export const refuse = (all: ReadonlyArray<string>): string | null => {
  let i = 0
  while (i < all.length && ["--help", "-h", "--version"].includes(all[i] ?? "")) i++
  const args = all.slice(i)
  const [first, second] = args
  if (first === undefined) return null
  if (first.startsWith("-")) return `put gh's command first, e.g. ["release", "list", ${JSON.stringify(first)}]`
  let refused: string | null = null
  if (first === "auth") refused = "gh auth"
  // Into submodules, whose own git config isn't checked (see `repoCommands`).
  else if (args.some((a) => a.startsWith("--recurse-submodules"))) refused = "--recurse-submodules"
  else if (["extension", "extensions", "ext"].includes(first)) refused = "gh extension"
  // Their subcommands come first too, for the same reason.
  else if ((first === "alias" || first === "config") && second !== undefined && second.startsWith("-")) {
    return `put the subcommand straight after ${JSON.stringify(first)}`
  } else if (first === "alias" && ["set", "import", "delete"].includes(second ?? "")) refused = "changing gh's aliases"
  else if (first === "config" && ["set", "clear-cache"].includes(second ?? "")) refused = "changing gh's settings"
  // A host's settings are its login, token and all (`config get -h HOST oauth_token` prints it).
  else if (first === "config" && args.slice(1).some((a) => a.includes("oauth_token") || a.startsWith("-h") || a.startsWith("--host"))) {
    refused = "reading a host's gh settings"
  }
  return refused === null ? null : `${refused} isn't available to agents; ask the user to run it`
}

/**
 * A GitHub account gh is signed in to: a login on github.com, or `HOST/LOGIN` on another GitHub host (Enterprise Cloud
 * with data residency, `*.ghe.com`, or Enterprise Server).
 */
export interface GhAccount {
  /** Lowercase. */
  readonly host: string
  readonly login: string
}

/** An account as a profile or project names it (`login` or `HOST/login`), or null when that isn't one. */
export const parseAccount = (given: string): GhAccount | null => {
  const s = given.trim()
  const i = s.indexOf("/")
  const [host, login] = i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : ["github.com", s]
  // Logins are letters, digits and hyphens (Enterprise managed users add `_shortcode`).
  // ASCII only, so its length is its length in bytes.
  const loginOk = /^[A-Za-z0-9_-]{1,100}$/.test(login) && !login.startsWith("-")
  const hostOk = /^[A-Za-z0-9.:-]+$/.test(host) && !host.startsWith("-") && !host.startsWith(".")
  return loginOk && hostOk ? { host: asciiLower(host), login } : null
}

/** How an account is named: its login on github.com, else `HOST/login`. */
export const accountName = (a: GhAccount): string => (a.host === "github.com" ? a.login : `${a.host}/${a.login}`)

/**
 * Whether `host` (of a URL) is one of the account's: its host, or its API's (`api.github.com` for github.com,
 * `api.acme.ghe.com` for `acme.ghe.com`; Enterprise Server's API is on its host), uploads' or gists'
 * (`gist.github.com`).
 */
export const ownsHost = (a: GhAccount, given: string): boolean => {
  const host = asciiLower(given)
  return host === a.host || ["api.", "uploads.", "gist."].some((p) => host.startsWith(p) && host.slice(p.length) === a.host)
}

/**
 * Why a gh command (its arguments and `GH_REPO`) is turned away for naming a host other than the account's, where gh
 * would act as another account (or send this one's token), or null: `--hostname`, a repository given as
 * `HOST/OWNER/REPO` or a URL (with `--repo`, `--source` or `--branch-repo`), and the command's arguments that say where
 * it goes, as its help has them. What else it's given (texts, fields, search queries, a repository's homepage) isn't
 * checked. Without its help (gh missing, a command gh doesn't have), every argument is, but options' values that are
 * always content.
 */
export const checkTargets = (a: GhAccount, args: ReadonlyArray<string>, repo: string | null, help: CommandHelp | null): string | null => {
  const hosts: Array<string> = []
  const rh = repo === null ? null : repoHost(repo)
  if (rh !== null) hosts.push(rh)
  hosts.push(...(help === null ? fallbackTargets(args) : helpTargets(help, args)))
  const other = hosts.find((h) => !ownsHost(a, h))
  return other === undefined ? null : `this project's GitHub account is ${accountName(a)}, so the gh tools only reach ${a.host}: not ${other}`
}

/**
 * Why git would push to one of `urls` (a remote's push URLs, as git rewrites them) as another account, or null: one is
 * on another host, or is HTTP(S) with credentials in it, which git uses instead of asking the credential helper for
 * the account's (see `gitCredentialConfig`).
 */
export const checkGitUrls = (a: GhAccount, urls: ReadonlyArray<string>): string | null => {
  // URLs, not a gh command: each is checked.
  const elsewhere = checkTargets(a, urls, null, null)
  if (elsewhere !== null) return elsewhere
  for (const url of urls) {
    const lower = asciiLower(url.trim())
    const rest = lower.startsWith("https://") ? lower.slice(8) : lower.startsWith("http://") ? lower.slice(7) : null
    if (rest !== null && (rest.split(/[/?#]/)[0] ?? "").includes("@")) {
      return `the remote URL has a login in it, which git would use instead of the GitHub account ${accountName(a)}: remove it from the remote's URL`
    }
  }
  return null
}

/**
 * git's `-c` settings (as `key=value`) that give the account's token (in `GIT_TOKEN_ENV`) for HTTPS on its host, in
 * place of other credential helpers for that host (such as gh's own, which would use gh's active account). Fetches and
 * pushes over SSH still use the host's SSH keys.
 */
export const gitCredentialConfig = (a: GhAccount): ReadonlyArray<string> => {
  const key = `credential.https://${a.host}.helper`
  const helper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${GIT_TOKEN_ENV}"; }; f`
  return [`${key}=`, `${key}=${helper}`]
}

/** `git -c` options for settings given as `key=value`. */
export const dashC = (settings: ReadonlyArray<string>): ReadonlyArray<string> => settings.flatMap((s) => ["-c", s])

/**
 * Settings as `key=value` put in an environment's command-line git config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
 * `GIT_CONFIG_VALUE_<n>`), after any it has: what `-c` does, for a command whose arguments aren't the board's to write.
 */
export const withGitConfig = (env: Readonly<Record<string, string | undefined>>, settings: ReadonlyArray<string>): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = { ...env }
  let n = Number(env["GIT_CONFIG_COUNT"]) || 0
  for (const s of settings) {
    const eq = s.indexOf("=")
    out[`GIT_CONFIG_KEY_${n}`] = eq < 0 ? s : s.slice(0, eq)
    out[`GIT_CONFIG_VALUE_${n}`] = eq < 0 ? "" : s.slice(eq + 1)
    n++
  }
  out["GIT_CONFIG_COUNT"] = String(n)
  return out
}

/**
 * Git settings that run commands of the repository's choosing, turned off for the git (and gh's git) that the gh tools
 * run outside the agent's sandbox: the agent can write the repository's hooks and config (its commits go there), so
 * they'd run its code unsandboxed, with the account's token in the environment for a push. The repository's config
 * can't be turned off as these are, so the rest of what it could set is refused instead (see `repoCommands`).
 */
export const UNSANDBOXED_GIT: ReadonlyArray<string> = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  // A push to (or fetch from) a path on this machine runs git there without this config (git drops it for a local
  // transport), so that repository's hooks would run: one the agent made and named as a push URL, say.
  "protocol.file.allow=never",
  // Not into submodules, whose own config (in .git/modules) isn't checked (see `repoCommands`).
  "submodule.recurse=false",
  "push.recurseSubmodules=no",
  "fetch.recurseSubmodules=false",
]

/** `env` with `UNSANDBOXED_GIT` in its command-line git config, after any it has (the old `no_repo_commands`). */
export const noRepoCommands = (env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => withGitConfig(env, UNSANDBOXED_GIT)

/**
 * Settings that make git run a command (the SSH command or a proxy command, a remote's receive-pack or helper, a
 * credential helper or askpass, a filter or diff driver, a submodule's update command, the alternates' refs command, a
 * signing program, the `ext::` transport) or send its traffic, and with it the account's token, elsewhere (a proxy,
 * TLS without checks or with another CA). From the user's own config they're the user's; from the repository's (local
 * or worktree), the agent may have written them.
 *
 * shortcut: a list of the settings git and gh's git use on a push, fetch or checkout, not every one git has; a new one
 * of git's that runs a command would need adding.
 */
export const REPO_COMMANDS =
  /^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|credential\..*helper|remote\..*\.(receivepack|uploadpack|proxy|vcs)|http\..*(proxy|sslverify|sslcainfo|sslcapath)|protocol\.(.*\.)?allow|filter\..*\.(clean|smudge|process)|diff\.(.*\.textconv|external)|submodule\..*\.update|gpg\.(.*\.)?program|gpg\.ssh\.defaultkeycommand)$/

/** The settings of `REPO_COMMANDS` a repository sets in its own config (local or worktree), from `git config --show-scope --list`. */
export const repoCommands = (configList: string): ReadonlyArray<string> => {
  const keys = new Set<string>()
  for (const line of configList.split("\n")) {
    const tab = line.indexOf("\t")
    const [scope, kv] = [line.slice(0, tab), line.slice(tab + 1)]
    const eq = kv.indexOf("=")
    const key = kv.slice(0, eq < 0 ? kv.length : eq).toLowerCase()
    if ((scope === "local" || scope === "worktree") && REPO_COMMANDS.test(key)) keys.add(key)
  }
  return [...keys]
}

/** Why a repository's own config keeps the gh tools out of it (`repoCommands` found these), or null. */
export const repoCommandsRefusal = (set: ReadonlyArray<string>): string | null =>
  set.length === 0
    ? null
    : `the repository's own git config sets ${set.join(", ")}, which can run a command or send git's traffic elsewhere, and these tools run git outside your sandbox, so they won't run there: unset ${set.length === 1 ? "it" : "them"} (git config --unset), or set ${set.length === 1 ? "it" : "them"} in the user's own config if they're the user's`

/** The `-c` settings (as `key=value`) that empty every `http.extraHeader` git has (from `git config --get-regexp '^http\..*extraheader$'`). */
export const extraHeaderResets = (configured: string): ReadonlyArray<string> => {
  const keys = configured
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split(" ")[0] ?? "")
    .filter((k) => k.length > 0)
  keys.push("http.extraheader")
  return [...new Set(keys)].toSorted().map((k) => `${k}=`)
}

/**
 * gh's `hosts.yml` with the account's login and token only, as gh writes a login it keeps out of the keyring (`gh auth
 * login --insecure-storage`). JSON strings are YAML's double-quoted ones.
 */
export const hostsYml = (a: GhAccount, token: string): string => {
  const [host, login, tok] = [JSON.stringify(a.host), JSON.stringify(a.login), JSON.stringify(token)]
  return `${host}:\n    users:\n        ${login}:\n            oauth_token: ${tok}\n    oauth_token: ${tok}\n    user: ${login}\n    git_protocol: https\n`
}

/**
 * The variables that make gh act as the account and no other, given its private config folder (`hostsYml` in it):
 * removed ones are undefined. gh has a login for the account's host only, so no token for any other host, whatever a
 * command names (unlike GH_ENTERPRISE_TOKEN, which gh sends to every host but github.com). There are no tokens in the
 * environment, the keyring is out of reach on Linux (gh looks there for hosts it has no login for: the Secret Service,
 * over the session bus), and GH_HOST is the account's host, so calls that don't name a host go there and gh refuses a
 * repository whose remotes are elsewhere. An inherited GH_REPO goes too: set the call's own after this.
 */
export const accountEnv = (a: GhAccount, configDir: string, linux: boolean): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {}
  for (const v of [...TOKEN_VARS, "GH_REPO"]) env[v] = undefined
  env["GH_CONFIG_DIR"] = configDir
  env["GH_HOST"] = a.host
  if (linux) env["DBUS_SESSION_BUS_ADDRESS"] = "disabled:"
  return env
}

/** The token variables removed: for `gh auth token`, which must give the account's own token, not one in the environment. */
export const withoutTokens: Readonly<Record<string, undefined>> = Object.fromEntries(TOKEN_VARS.map((v) => [v, undefined]))

/** The arguments of `gh auth token` for the account. */
export const tokenArgs = (a: GhAccount): ReadonlyArray<string> => ["auth", "token", `--hostname=${a.host}`, `--user=${a.login}`]

/** Why the account's token couldn't be had from `gh auth token` (its stderr), with what to do about it. */
export const notSignedIn = (a: GhAccount, stderr: string): string =>
  `the GitHub account ${accountName(a)} isn't signed in to gh on this host (${stderr.trim()}). Sign in to it with \`gh auth login${
    a.host === "github.com" ? "" : ` --hostname ${a.host}`
  }\`, or pick another account in the profile's or project's settings.`

/** `gh-run`'s shim: `gh` on a wait's command's PATH, a script that runs `<exe> gh-run`. */
export const shimScript = (exe: string): string => `#!/bin/sh\nexec '${exe.replaceAll("'", "'\\''")}' gh-run "$@"\n`
