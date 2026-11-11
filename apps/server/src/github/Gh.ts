import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Ref, Result, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  accountEnv,
  accountName,
  asciiLower,
  checkGitUrls,
  checkTargets,
  dashC,
  extraHeaderResets,
  GH_FIXED_ENV,
  GIT_TOKEN_ENV,
  gitCredentialConfig,
  HELP_ENV,
  helpCommand,
  hostsYml,
  noRepoCommands,
  notSignedIn,
  parseAccount,
  parseHelp,
  repoCommands,
  repoCommandsRefusal,
  shimScript,
  STALE_CONFIG_MS,
  tokenArgs,
  urlHost,
  withGitConfig,
  withoutTokens,
  ACCOUNT_ENV,
  GH_BIN_ENV,
  GH_CONFIG_ROOT_ENV,
} from "@huntaway/shared"
import type { CommandHelp, GhAccount } from "@huntaway/shared"
import { Git } from "../git/Git.ts"
import { toJson } from "../platform/columns.ts"
import { DataDir } from "../platform/DataDir.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { clip, command, exitStatus, merges, prFromUrl, trimmedArg } from "./gh/commands.ts"
import type { Command, ToolArgs } from "./gh/commands.ts"

// Running the GitHub CLI (docs/plan/06-server.md, GitHub; docs/plan/inventory/03-mcp.md 2.10; huntaway's
// mcp/gh_mcp.ts `run` and `exec`, mcp/gh_mcp/account.ts and env.ts): the gh tools' calls (`run`), the board's own gh
// calls (`gh`), a wait's command's gh (`shellEnv`, through `gh-run`) and an authenticated fetch (`fetchEnv`), each as
// one GitHub account and no other when the task has one. Agents' gh runs outside their sandbox, so git's commands of
// the repository's choosing are turned off or refused, and the calls that may merge ask the board first.

/** Why a gh tool call wasn't run, or a GitHub account can't be acted as: told to the agent as `Error: <message>`. */
export class GhRefused extends Schema.TaggedError<GhRefused, { readonly brand: unique symbol }>()("GhRefused", { message: Schema.String }) {}

/** The run a gh tool call is for: where it runs, the account it acts as, and the board's say on merging. */
export interface GhRun {
  /** The run's directory, where calls without a `dir` run. */
  readonly cwd: string | null
  readonly account: GhAccount | null
  /** Why the board won't let this run merge now, if it won't (`MergeGate.blocked`). */
  readonly mergeGate: Effect.Effect<string | null>
}

/** What a gh tool call printed (stdout, then stderr, clipped; "Done." for nothing), and whether it failed. */
export interface GhOutput {
  readonly text: string
  readonly failed: boolean
}

export interface GhCallOptions {
  /** Where gh runs (default: the server's folder). */
  readonly cwd?: string | undefined
  /** The account it acts as (`login` or `HOST/login`); null for gh's active one. */
  readonly account: string | null
  /** `GH_REPO`. */
  readonly repo?: string | null | undefined
  /** Default 60 seconds. */
  readonly timeout?: Duration.Input | undefined
  /**
   * 6.11: without `UNSANDBOXED_GIT`, for the board's own clone and repository creation (`GithubRepos`), whose git is the
   * user's as the old `gh_vars` ran it (their hooks, a local remote), not an agent's.
   */
  readonly plain?: boolean | undefined
  /** 6.11: more variables, over the rest. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** How a board's own gh call ended. */
export interface GhResult {
  /** Null when a signal ended it. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** How often a stacked pull request's merge (GitHub's merge-async) is looked at, and for how long. Tests shorten it. */
export const MergePoll = Context.Reference<{ readonly every: Duration.Input; readonly for: Duration.Input }>("huntaway-server/github/Gh/MergePoll", {
  defaultValue: () => ({ every: "2 seconds", for: "10 minutes" }),
})

/** A gh tool call's limit. */
export const TIMEOUT = "600 seconds"

/** What is kept of a command's output, per stream. */
const MAX_BYTES = 16 * 1024 * 1024

interface Ran {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
}

const decoder = new TextDecoder()

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
      (acc, chunk) => {
        if (acc.size < MAX_BYTES) acc.chunks.push(chunk)
        return { chunks: acc.chunks, size: acc.size + chunk.length }
      },
    ),
    Effect.map(({ chunks }) => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return decoder.decode(out)
    }),
  )

const JsonText = Schema.fromJsonString(Schema.Unknown)
const StackedPr = Schema.Struct({ stack: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Finite }))) })
const Stack = Schema.Struct({
  pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: Schema.optional(Schema.Unknown), merged_at: Schema.optional(Schema.Unknown) }))),
})
const MergeAsync = Schema.Struct({
  status: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Struct({ uuid: Schema.optional(Schema.Unknown), message: Schema.optional(Schema.Unknown) })),
})

const refused = (message: string) => new GhRefused({ message })
const done = (text: string, failed: boolean): GhOutput => ({ text, failed })
/** A merge-async answer, read leniently. */
const read = (v: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(MergeAsync)(v))

/** An account as a profile or project names it, or why gh can't act as it. */
const accountOf = (name: string) => {
  const a = parseAccount(name)
  return a === null ? Effect.fail(refused(`the GitHub account ${name} isn't one gh can use`)) : Effect.succeed(a)
}

export interface GhShape {
  /** A gh tool's call (`tool` with its arguments) for run `r`: its output, and whether it failed. */
  readonly run: (tool: string, args: ToolArgs, r: GhRun) => Effect.Effect<GhOutput, GhRefused>
  /** gh as the board runs it for itself (pull requests' state, merges, stacks), as `account`. A non-zero exit is a result. */
  readonly gh: (args: ReadonlyArray<string>, options: GhCallOptions) => Effect.Effect<GhResult, GhRefused>
  /** The account's token from gh's logins on its host. */
  readonly token: (account: GhAccount) => Effect.Effect<string, GhRefused>
  /**
   * What a wait's command's environment gets for its gh to act as `account` (none: `{}`): `gh` on its PATH is a script
   * that runs `huntaway gh-run`, which checks each call as the gh tools do and runs gh with the token. The shell never
   * sees the token. Fails when the account isn't signed in to gh, so the command doesn't run as another one.
   */
  readonly shellEnv: (account: string | null) => Effect.Effect<Readonly<Record<string, string>>, GhRefused>
  /** `GitHubAccess.fetchEnv`: the environment for an HTTPS fetch from `remoteUrl` in `cwd` as `account`. */
  readonly fetchEnv: (cwd: string, account: string | null, remoteUrl: string) => Effect.Effect<Readonly<Record<string, string | undefined>>>
}

export class Gh extends Context.Service<Gh, GhShape>()("huntaway-server/github/Gh") {
  static readonly layer = Layer.effect(
    Gh,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const random = yield* SecureRandom.SecureRandom
      const help = yield* Ref.make<ReadonlyMap<string, CommandHelp | null>>(new Map())
      const linux = process.platform === "linux"
      const configRoot = `${config.cacheDir}/huntaway/gh-account`
      const shimDir = `${dataDir.root}/gh-shim`

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      /** Run `program` to its end within `timeout`: how it ended, or "timeout". Fails when it couldn't start. */
      const execute = (
        program: string,
        args: ReadonlyArray<string>,
        options: { readonly cwd?: string | null | undefined; readonly env: Readonly<Record<string, string | undefined>>; readonly timeout: Duration.Input },
      ) => {
        const once: Effect.Effect<Ran, PlatformError.PlatformError, Scope.Scope> = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(program, args, {
              ...(options.cwd === null || options.cwd === undefined ? {} : { cwd: options.cwd }),
              env: options.env,
              extendEnv: true,
              stdin: "ignore",
            }),
          )
          const [stdout, stderr, exit] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), Effect.result(handle.exitCode)], {
            concurrency: 3,
          })
          if (Result.isSuccess(exit)) return { code: Number(exit.success), signal: null, stdout, stderr }
          const signal = /signal: '(\w+)'/.exec(exit.failure.message)?.[1] ?? null
          if (signal === null) return yield* exit.failure
          return { code: null, signal, stdout, stderr }
        })
        return once.pipe(
          Effect.scoped,
          Effect.map((ran): Ran | "timeout" => ran),
          Effect.timeoutOrElse({ duration: options.timeout, orElse: () => Effect.succeed("timeout" as const) }),
        )
      }

      /** The environment everything here runs in: the agents' (the server's without its own settings) and `extra`. */
      const envWith = (extra: Readonly<Record<string, string | undefined>>) => ({ ...config.agentEnv, ...extra })

      const token = Effect.fn("Gh.token")(function* (a: GhAccount) {
        const name = accountName(a)
        // Its own token, not one in the environment.
        const out = yield* execute(config.ghBin, tokenArgs(a), { env: envWith(withoutTokens), timeout: "30 seconds" }).pipe(
          Effect.mapError((e) => refused(`couldn't get a token for the GitHub account ${name}: couldn't run gh (${e.message})`)),
        )
        if (out === "timeout") return yield* refused(`couldn't get a token for the GitHub account ${name}: gh auth token timed out`)
        const tok = out.stdout.trim()
        if (out.code !== 0 || tok === "") return yield* refused(notSignedIn(a, out.stderr))
        return tok
      })

      /** The private gh config folders' root, with those left by a process killed while gh ran (over a day old) removed. */
      const sweptRoot = Effect.gen(function* () {
        yield* fs.makeDirectory(configRoot, { recursive: true }).pipe(Effect.mapError((e) => refused(`couldn't create ${configRoot}: ${e.message}`)))
        const stale = (yield* Clock.currentTimeMillis) - STALE_CONFIG_MS
        const entries = yield* fs.readDirectory(configRoot).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        yield* Effect.forEach(
          entries,
          (entry) =>
            fs.stat(`${configRoot}/${entry}`).pipe(
              Effect.flatMap((info) =>
                Option.isSome(info.mtime) && info.mtime.value.getTime() < stale ? fs.remove(`${configRoot}/${entry}`, { recursive: true }) : Effect.void,
              ),
              Effect.ignore,
            ),
          { concurrency: 1, discard: true },
        )
      })

      /**
       * A gh config folder of the account's own (`hosts.yml` with its login only, readable by this user only) for the
       * scope, and the variables that make gh use it and nothing else (`accountEnv`).
       */
      const accountConfig = Effect.fnUntraced(function* (a: GhAccount, tok: string) {
        yield* sweptRoot
        const dir = `${configRoot}/${yield* random.uuidV4().pipe(Effect.orDie)}`
        yield* Effect.acquireRelease(fs.makeDirectory(dir, { mode: 0o700 }).pipe(Effect.mapError((e) => refused(`couldn't create ${dir}: ${e.message}`))), () =>
          fs.remove(dir, { recursive: true }).pipe(Effect.ignore),
        )
        yield* fs
          .writeFileString(`${dir}/hosts.yml`, hostsYml(a, tok), { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError((e) => refused(`couldn't write ${dir}/hosts.yml: ${e.message}`)))
        return accountEnv(a, dir, linux)
      })

      /** gh's help for the command `args` run, read once and kept (null: gh has none, and the fallback heuristics hold). */
      const helpFor = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
        const c = helpCommand(args)
        if (c === null) return null
        const known = (yield* Ref.get(help)).get(c.key)
        if (known !== undefined) return known
        const out = yield* execute(config.ghBin, c.argv, { env: envWith(HELP_ENV), timeout: "30 seconds" }).pipe(Effect.orElseSucceed(() => "timeout" as const))
        const parsed = out !== "timeout" && out.code === 0 ? parseHelp(out.stdout) : null
        yield* Ref.update(help, (all) => new Map([...all, [c.key, parsed]]))
        return parsed
      })

      const isDir = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )

      /** Every URL `remote` (a remote's name) pushes to in `dir`, with git's rewrites applied; null if there's no such remote. */
      const pushUrls = Effect.fnUntraced(function* (dir: string, remote: string) {
        const out = yield* git.run(dir, ["remote", "get-url", "--push", "--all", "--", remote]).pipe(Effect.orElseSucceed(() => null))
        if (out === null || !out.ok) return null
        const urls = out.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
        return urls.length > 0 ? urls : null
      })

      /** `git -c` settings that empty every `http.extraHeader` configured in `dir` (an `Authorization` header of another login). */
      const headerResets = (dir: string) =>
        git.run(dir, ["config", "--get-regexp", "^http\\..*extraheader$"]).pipe(
          Effect.map((o) => extraHeaderResets(o.stdout)),
          Effect.orElseSucceed(() => extraHeaderResets("")),
        )

      /** Where call `a` runs: its `dir`, or the run's directory. */
      const workDir = (a: ToolArgs, r: GhRun): string | null => {
        const given = a["dir"]
        const d = typeof given === "string" && given.trim() !== "" ? given : r.cwd
        return d === null ? null : expand(d)
      }

      /** Run a command where call `a` runs, as the run's account if it has one: its output, and whether it failed. */
      const exec = (c: Command, a: ToolArgs, r: GhRun) =>
        Effect.scoped(
          Effect.gen(function* () {
            const program = c.program === "gh" ? config.ghBin : "git"
            const d = workDir(a, r)
            let env: Record<string, string | undefined> = envWith({})
            const pre: Array<string> = []
            const account = r.account
            if (account !== null) {
              if (c.program === "git") {
                // To another host, the push would go as whoever git's credentials (or SSH keys) there are. So it's to a
                // remote by name, all of whose push URLs (as git rewrites them) are checked: a URL given as the remote
                // would be rewritten when pushing.
                const u = c.args.indexOf("-u")
                const remote = u >= 0 && c.args[u + 1] !== undefined ? (c.args[u + 1] ?? "origin") : "origin"
                const urls = yield* pushUrls(d ?? ".", remote)
                if (urls === null) {
                  return yield* refused(
                    `there's no remote named ${remote}: with a GitHub account set, git_push takes a remote's name (add one with git remote add)`,
                  )
                }
                const elsewhere = checkGitUrls(account, urls)
                if (elsewhere !== null) return yield* refused(elsewhere)
                pre.push(...dashC([...(yield* headerResets(d ?? ".")), ...gitCredentialConfig(account)]))
                // Only for a push over HTTPS, whose credential helper is the only thing to read it: over SSH, the SSH
                // keys push, and the token would be in the environment of the SSH command.
                if (urls.some((url) => /^https:\/\//i.test(url))) env[GIT_TOKEN_ENV] = yield* token(account)
              } else {
                const elsewhere = checkTargets(account, c.args, c.repo, yield* helpFor(c.args))
                if (elsewhere !== null) return yield* refused(elsewhere)
                env = { ...env, ...(yield* accountConfig(account, yield* token(account))) }
              }
            }
            env = noRepoCommands({ ...env, ...GH_FIXED_ENV })
            // Only the call's own repository, which was checked.
            env["GH_REPO"] = c.repo ?? undefined
            if (d !== null && !(yield* isDir(d))) return yield* refused(`${d} is not a directory`)
            if (d !== null) {
              const list = yield* git.run(d, ["config", "--show-scope", "--list"]).pipe(
                Effect.map((o) => o.stdout),
                Effect.orElseSucceed(() => ""),
              )
              const why = repoCommandsRefusal(repoCommands(list))
              if (why !== null) return yield* refused(why)
            }
            const out = yield* execute(program, [...pre, ...c.args], { cwd: d, env, timeout: TIMEOUT }).pipe(
              Effect.mapError((e) => refused(`couldn't run ${c.program}: ${e.message}`)),
            )
            if (out === "timeout") return yield* refused(`${c.program} timed out after ${Duration.toSeconds(Duration.fromInputUnsafe(TIMEOUT))} seconds`)
            const failed = out.code === null || !c.okCodes.includes(out.code)
            let text = out.stdout.trimEnd()
            if (out.stderr.trim() !== "") {
              if (text !== "") text += "\n\n"
              text += out.stderr.trimEnd()
            }
            if (failed) text += `\n\n(${c.program} exited with ${exitStatus(out.code, out.signal)})`
            else if (text === "") text = "Done."
            const result: GhOutput = { text: clip(text.trimStart()), failed }
            return result
          }),
        )

      /** pr_merge's arguments with `pr` and `repo` resolved to the PR's number and repository. */
      const resolvePr = Effect.fnUntraced(function* (a: ToolArgs, r: GhRun) {
        const args = ["pr", "view"]
        const pr = typeof a["pr"] === "string" ? a["pr"].trim() : ""
        if (pr !== "") {
          if (pr.startsWith("-")) return yield* refused(`bad pr: ${pr}`)
          args.push(pr)
        }
        args.push("--json=url", "--jq=.url")
        const out = yield* exec({ program: "gh", args, okCodes: [0], repo: trimmedArg(a, "repo") }, a, r)
        if (out.failed) return yield* refused(`couldn't find the pull request: ${out.text}`)
        const found = prFromUrl(out.text)
        if (found === null) return yield* refused(`unexpected pull request URL ${out.text}`)
        const resolved: ToolArgs = { ...a, pr: found[0], repo: found[1] }
        return resolved
      })

      /**
       * pr_merge of a pull request in a stack on GitHub (HA-336), which GitHub's legacy merge (`gh pr merge`) refuses:
       * with its merge-async API, waiting for the result. GitHub merges the unmerged pull requests below one in its stack
       * with it, so that's refused here: they're merged first. Null for one that isn't in a stack.
       */
      const mergeStacked = Effect.fnUntraced(function* (a: ToolArgs, r: GhRun) {
        const repo = typeof a["repo"] === "string" ? a["repo"] : ""
        const number = typeof a["pr"] === "string" ? a["pr"] : ""
        const parts = repo.split("/")
        const host = parts.length === 3 ? (parts[0] ?? null) : null
        const path = `repos/${parts.slice(-2).join("/")}`
        /** A REST call's answer (null for none), or why it failed. */
        const api = (args: ReadonlyArray<string>) =>
          Effect.map(
            exec({ program: "gh", args: ["api", ...(host === null ? [] : ["--hostname", host]), ...args], okCodes: [0], repo: null }, a, r),
            (out): Result.Result<unknown, string> => {
              if (out.failed) return Result.fail(out.text)
              if (out.text.trim() === "" || out.text === "Done.") return Result.succeed(null)
              return Option.match(Schema.decodeOption(JsonText)(out.text), {
                onNone: () => Result.fail(`unexpected answer from GitHub: ${out.text}`),
                onSome: Result.succeed,
              })
            },
          )
        const pr = yield* api([`${path}/pulls/${number}`])
        const stack = Result.isFailure(pr) ? null : (Option.getOrUndefined(Schema.decodeUnknownOption(StackedPr)(pr.success))?.stack ?? null)
        // Unreadable: the legacy merge says what's wrong.
        if (stack === null) return null
        if (a["auto"] === true) {
          return done(`#${number} is in a stack on GitHub (#${stack.number}), and GitHub doesn't auto-merge those yet: merge it once its checks pass`, true)
        }
        const whole = yield* api([`${path}/stacks/${stack.number}`])
        if (Result.isFailure(whole)) return done(`couldn't read #${number}'s stack on GitHub (#${stack.number}): ${whole.failure}`, true)
        const prs = Option.getOrUndefined(Schema.decodeUnknownOption(Stack)(whole.success))?.pull_requests ?? []
        const at = prs.findIndex((p) => String(p.number) === number)
        const openBelow = prs.slice(0, Math.max(at, 0)).filter((p) => p.merged_at === null || p.merged_at === undefined)
        if (openBelow.length > 0) {
          const which = openBelow.map((p) => `#${String(p.number)}`).join(", ")
          const one = openBelow.length === 1
          return done(
            `${which}, below #${number} in its stack on GitHub, ${one ? "isn't" : "aren't"} merged yet, and GitHub would merge ${one ? "it" : "them"} with it: merge ${one ? "that" : "those"} first`,
            true,
          )
        }
        const method = typeof a["method"] === "string" ? a["method"] : "merge"
        const sent = yield* api(["-X", "PUT", `${path}/pulls/${number}/merge-async`, "-f", `merge_method=${method}`])
        if (Result.isFailure(sent)) return done(`GitHub didn't take the merge of #${number} (in a stack there, #${stack.number}): ${sent.failure}`, true)
        let res = sent.success
        const uuid = read(res)?.details?.uuid
        const poll = yield* MergePoll
        const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(poll.for))
        // Without an id to look it up by, its answer is the last word.
        const polled = typeof uuid === "string" ? uuid : null
        while (true) {
          if (polled === null || read(res)?.status !== "pending") break
          if ((yield* Clock.currentTimeMillis) > deadline) {
            return done(`#${number}'s merge (in a stack on GitHub, #${stack.number}) is still pending: look at it again later`, true)
          }
          yield* Effect.sleep(poll.every)
          const now = yield* api([`${path}/pulls/${number}/merge-async/${polled}`])
          if (Result.isFailure(now)) return done(`couldn't read how #${number}'s merge went: ${now.failure}`, true)
          res = now.success
        }
        const kept = a["delete_branch"] === true ? " Its branch was kept: GitHub retargets the pull requests stacked on it." : ""
        const status = read(res)?.status
        if (status === "merged") return done(`Merged #${number} (in a stack on GitHub, #${stack.number}, with its merge-async API).${kept}`, false)
        if (status === "enqueued") return done(`#${number} (in a stack on GitHub, #${stack.number}) was added to the merge queue.${kept}`, false)
        const message = read(res)?.details?.message
        return done(
          `GitHub couldn't merge #${number} (in a stack there, #${stack.number}): ${typeof message === "string" ? message : yield* toJson(res)}`,
          true,
        )
      })

      const run = Effect.fn("Gh.run")(function* (tool: string, a: ToolArgs, r: GhRun) {
        if (merges(tool, a, yield* toJson(a))) {
          const why = yield* r.mergeGate
          if (why !== null) return { text: why, failed: true } satisfies GhOutput
        }
        const args = tool === "pr_merge" ? yield* resolvePr(a, r) : a
        if (tool === "pr_merge") {
          const stacked = yield* mergeStacked(args, r)
          if (stacked !== null) return stacked
        }
        const c = command(tool, args)
        if (Result.isFailure(c)) return yield* refused(c.failure)
        return yield* exec(c.success, args, r)
      })

      const gh = Effect.fn("Gh.gh")(function* (args: ReadonlyArray<string>, options: GhCallOptions) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            let env: Record<string, string | undefined> = envWith(GH_FIXED_ENV)
            if (options.account !== null) {
              const a = yield* accountOf(options.account)
              env = { ...env, ...(yield* accountConfig(a, yield* token(a))) }
            }
            env = options.plain === true ? { ...env, ...options.env } : noRepoCommands({ ...env, ...options.env })
            env["GH_REPO"] = options.repo ?? undefined
            const timeout = options.timeout ?? "60 seconds"
            const out = yield* execute(config.ghBin, args, { cwd: options.cwd, env, timeout }).pipe(
              Effect.mapError((e) => refused(`couldn't run gh: ${e.message}`)),
            )
            if (out === "timeout")
              return yield* refused(`gh ${args.slice(0, 2).join(" ")} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`)
            const result: GhResult = { code: out.code, stdout: out.stdout, stderr: out.stderr }
            return result
          }),
        )
      })

      /** The real gh a wait's shim runs: `ghBin` as given if it's a path, else the first on PATH that isn't the shim. */
      const realGh = Effect.fnUntraced(function* () {
        if (config.ghBin.includes("/")) return config.ghBin
        for (const d of config.path.split(":")) {
          if (d === "" || d === shimDir) continue
          const found = yield* fs.stat(`${d}/${config.ghBin}`).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.orElseSucceed(() => false),
          )
          if (found) return `${d}/${config.ghBin}`
        }
        return yield* refused("gh isn't installed")
      })

      /** `<data dir>/gh-shim/gh`, written aside and renamed when it isn't the script already, so a command running it never sees half of it. */
      const writeShim = Effect.fnUntraced(function* (exe: string) {
        const shim = `${shimDir}/gh`
        const script = shimScript(exe)
        const current = yield* fs.readFileString(shim).pipe(Effect.orElseSucceed(() => null))
        if (current === script) return
        const tmp = `${shimDir}/.gh-${yield* random.uuidV4().pipe(Effect.orDie)}`
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(shimDir, { recursive: true })
          yield* fs.writeFileString(tmp, script)
          yield* fs.chmod(tmp, 0o755)
          yield* fs.rename(tmp, shim)
        }).pipe(Effect.mapError((e) => refused(`couldn't write ${shim}: ${e.message}`)))
      })

      const shellEnv = Effect.fn("Gh.shellEnv")(function* (name: string | null) {
        if (name === null) return {}
        const a = yield* accountOf(name)
        // It doesn't run as another account when this one isn't signed in.
        yield* token(a)
        const real = yield* realGh()
        if (config.exe === null) return yield* refused("gh can't be given to the command as the GitHub account: this server wasn't started by bin/huntaway")
        yield* writeShim(config.exe)
        const env: Readonly<Record<string, string>> = {
          PATH: [shimDir, ...config.path.split(":").filter((d) => d !== shimDir && d !== "")].join(":"),
          [ACCOUNT_ENV]: accountName(a),
          [GH_BIN_ENV]: real,
          [GH_CONFIG_ROOT_ENV]: configRoot,
        }
        return env
      })

      const fetchEnv = Effect.fn("Gh.fetchEnv")(function* (cwd: string, name: string | null, remoteUrl: string) {
        const a = name === null ? null : parseAccount(name)
        const url = remoteUrl.trim()
        if (a === null || !asciiLower(url).startsWith("https://") || urlHost(url) !== a.host) return {}
        const key = `credential.https://${a.host}.helper`
        // No helper at all: the fetch fails rather than go as another login.
        const none = withGitConfig({}, [...(yield* headerResets(cwd)), `${key}=`])
        const elsewhere = checkGitUrls(a, [url])
        if (elsewhere !== null) {
          yield* Effect.logWarning(`a fetch from ${url} as ${accountName(a)} gets no credentials: ${elsewhere}`)
          return none
        }
        const tok = yield* Effect.result(token(a))
        if (Result.isFailure(tok)) {
          yield* Effect.logWarning(`a fetch from ${url} gets no credentials: ${tok.failure.message}`)
          return none
        }
        const env: Readonly<Record<string, string | undefined>> = {
          ...withGitConfig({}, [...(yield* headerResets(cwd)), ...gitCredentialConfig(a)]),
          [GIT_TOKEN_ENV]: tok.success,
        }
        return env
      })

      return Gh.of({ run, gh, token, shellEnv, fetchEnv })
    }),
  )
}
