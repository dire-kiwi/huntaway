import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import {
  ACCOUNT_ENV,
  accountName,
  accountEnv,
  checkTargets,
  GH_BIN_ENV,
  GH_CONFIG_ROOT_ENV,
  HELP_ENV,
  helpCommand,
  hostsYml,
  noRepoCommands,
  notSignedIn,
  parseAccount,
  parseHelp,
  refuse,
  STALE_CONFIG_MS,
  tokenArgs,
  withoutTokens,
} from "@huntaway/shared"
import type { GhAccount } from "@huntaway/shared"

// `huntaway gh-run <args>` (docs/plan/inventory/03-mcp.md 2.13; huntaway's mcp/gh_mcp/env.ts `gh_run`): gh in a wait's
// command, for a task with a GitHub account. The command's PATH has `<data dir>/gh-shim/gh` first, a script that runs
// this, with the account (`HUNTAWAY_GH_ACCOUNT`), the real gh (`HUNTAWAY_GH_BIN`) and where to make gh's config
// (`HUNTAWAY_GH_CONFIG_ROOT`) in its environment (`Gh.shellEnv`). It refuses what the gh tools refuse and calls that
// would reach another host, and runs the rest with the account's token, in a gh config folder of its own that goes
// once gh is done. The shell never sees the token. Plain Node: it starts per gh call, so it loads only this,
// `@huntaway/shared` and Node.

/** Why gh-run won't run gh: told on stderr, exit code 1. */
export class GhRunRefused extends Error {}

type Env = Readonly<Record<string, string | undefined>>

/** Where the private gh config folders go: the server's root, else `$XDG_CACHE_HOME` (or `~/.cache`)`/huntaway/gh-account`. */
const configRoot = (env: Env): string => {
  const given = env[GH_CONFIG_ROOT_ENV]
  if (given !== undefined && given !== "") return given
  const xdg = env["XDG_CACHE_HOME"]
  const cache = xdg !== undefined && xdg.startsWith("/") ? xdg : `${env["HOME"] ?? "/tmp"}/.cache`
  return `${cache}/huntaway/gh-account`
}

/** The account's token from gh's logins on its host (none from the environment). */
const token = (gh: string, a: GhAccount, env: Env): string => {
  const out = spawnSync(gh, tokenArgs(a), { env: { ...env, ...withoutTokens }, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
  if (out.error !== undefined) throw new GhRunRefused(`couldn't get a token for the GitHub account ${accountName(a)}: couldn't run gh (${out.error.message})`)
  const tok = out.stdout.trim()
  if (out.status !== 0 || tok === "") throw new GhRunRefused(notSignedIn(a, out.stderr))
  return tok
}

/** gh's help for the command `args` runs, if gh has it (the fallback heuristics hold without). */
const helpFor = (gh: string, args: ReadonlyArray<string>, env: Env) => {
  const c = helpCommand(args)
  if (c === null) return null
  const out = spawnSync(gh, c.argv, {
    env: { ...env, ...HELP_ENV },
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 << 20,
  })
  return out.error === undefined && out.status === 0 ? parseHelp(out.stdout) : null
}

/** A config folder of the account's own (its login only, readable by this user only), with stale ones removed. */
const accountConfig = (root: string, a: GhAccount, tok: string): string => {
  mkdirSync(root, { recursive: true })
  // Left behind by a process that was killed while gh ran.
  const stale = Date.now() - STALE_CONFIG_MS
  let entries: Array<string> = []
  try {
    entries = readdirSync(root)
  } catch {
    entries = []
  }
  for (const e of entries) {
    try {
      if (statSync(`${root}/${e}`).mtimeMs < stale) rmSync(`${root}/${e}`, { recursive: true, force: true })
    } catch {
      // Gone already.
    }
  }
  const dir = `${root}/${randomUUID()}`
  mkdirSync(dir, { mode: 0o700 })
  try {
    writeFileSync(`${dir}/hosts.yml`, hostsYml(a, tok), { flag: "wx", mode: 0o600 })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return dir
}

/** Runs gh with `args` as the account in `env` (the process's by default): gh's exit code. Throws `GhRunRefused` for what it won't run. */
export const ghRun = async (args: ReadonlyArray<string>, env: Env = process.env): Promise<number> => {
  const name = env[ACCOUNT_ENV]
  if (name === undefined || name === "") throw new GhRunRefused(`${ACCOUNT_ENV} isn't set`)
  const a = parseAccount(name)
  if (a === null) throw new GhRunRefused(`the GitHub account ${name} isn't one gh can use`)
  const gh = env[GH_BIN_ENV] !== undefined && env[GH_BIN_ENV] !== "" ? env[GH_BIN_ENV] : "gh"
  const repo = env["GH_REPO"] !== undefined && env["GH_REPO"] !== "" ? env["GH_REPO"] : null
  const refused = refuse(args)
  if (refused !== null) throw new GhRunRefused(refused)
  const elsewhere = checkTargets(a, args, repo, helpFor(gh, args, env))
  if (elsewhere !== null) throw new GhRunRefused(elsewhere)
  const dir = accountConfig(configRoot(env), a, token(gh, a, env))
  try {
    const runEnv: Record<string, string | undefined> = noRepoCommands({ ...env, ...accountEnv(a, dir, process.platform === "linux") })
    if (repo !== null) runEnv["GH_REPO"] = repo
    // Removed ones are left out (spawn drops undefined values).
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(gh, args, { env: runEnv, stdio: "inherit" })
      child.on("error", (e) => reject(new GhRunRefused(`couldn't run gh: ${e.message}`)))
      child.on("close", (code) => resolve(code ?? 1))
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
