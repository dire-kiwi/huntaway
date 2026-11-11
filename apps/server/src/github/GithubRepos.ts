import { Clock, Context, Effect, Fiber, FiberSet, FileSystem, Layer, Option, Path, Predicate, Ref, Result, Schema } from "effect"
import { Conflict, Invalid } from "@huntaway/contracts"
import type { CloneProject, CreatedRepo, GithubAccounts, GithubRepo, GithubRepoList, NewGithubProject, ProfileId, Project } from "@huntaway/contracts"
import { parseAccount } from "@huntaway/shared"
import { Git } from "../git/Git.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { defaultCloneDir } from "../profiles/checks.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { checkKey, normalizeKey } from "../projects/keys.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Projects } from "../projects/Projects.ts"
import { expandTilde } from "../settings/Folders.ts"
import { Gh } from "./Gh.ts"
import type { GhCallOptions } from "./Gh.ts"
import { isGithubCom, remoteRepo } from "./GithubRemote.ts"
import {
  accountsFromStatus,
  checkName,
  checkRepo,
  contributedOf,
  CONTRIBUTED,
  ghError,
  latestFirst,
  loginOf,
  orgsOf,
  PAGES,
  repoFolder,
  reposOf,
  SEARCH_RESULTS,
  searchQuery,
  userReposPage,
} from "./repos/model.ts"

// 6.11: adding a project from GitHub (docs/plan/inventory/04-git-review.md §2.21, 06-integrations.md §2.5; the old
// `integrations/github.ts` and `api/projects.ts`' clone and create): the accounts gh is signed in to, the repositories
// one can clone, cloning one into the profile's clone folder, and creating one for a folder. gh acts as the profile's
// GitHub account, or as gh's active one when it has none. A clone or a creation carries on without its caller (a dialog
// closed meanwhile), and holds its folder until the project is added, so a request for it meanwhile waits and then finds
// the project.

/** gh couldn't do it, in its own words. */
export class GithubFailed extends Schema.TaggedError<GithubFailed, { readonly brand: unique symbol }>()("GithubFailed", { message: Schema.String }) {}

const failed = (message: string) => new GithubFailed({ message })

/** How long an account's login and organizations are kept for its searches. */
const OWNERS_TTL_MS = 5 * 60 * 1000
const CLONE_TIMEOUT = "60 minutes"
const CREATE_TIMEOUT = "15 minutes"
const JsonText = Schema.fromJsonString(Schema.Unknown)

export interface GithubReposShape {
  /** The accounts gh is signed in to on this host; `error` says why there are none. */
  readonly accounts: Effect.Effect<GithubAccounts>
  /**
   * The repositories `account` (gh's active one when null) can clone: without `query`, those it owns, collaborates on or
   * has contributed to, newest push first; with one, those named like it among its own and its organizations'.
   */
  readonly list: (account: string | null, query: string | null) => Effect.Effect<GithubRepoList>
  /**
   * Clones `OWNER/REPO` into `dest` (a new or empty folder) as `account`. A clone of it there already is kept as it is.
   * A failed clone is taken away again, leaving the folder as it was. Whether it cloned.
   */
  readonly clone: (account: string | null, repo: string, dest: string) => Effect.Effect<boolean, GithubFailed>
  /**
   * Creates the repository `name` (under `owner`, the account's login by default) from the folder `dir` with `gh repo
   * create --source --remote origin [--push]`: a folder that isn't a repository is made one, a new folder is made, and a
   * failure leaves the folder as it was.
   */
  readonly create: (account: string | null, dir: string, owner: string | null, name: string, priv: boolean) => Effect.Effect<CreatedRepo, GithubFailed>
  /** `projects.clone`: the clone added as the profile's project. */
  readonly cloneProject: (input: CloneProject) => Effect.Effect<Project, ProfileNotFound | Invalid | Conflict | GithubFailed>
  /** `projects.createOnGithub`: the folder's repository made on GitHub, and the folder added as the profile's project. */
  readonly createProject: (
    input: NewGithubProject,
  ) => Effect.Effect<{ readonly project: Project; readonly github: CreatedRepo }, ProfileNotFound | Invalid | Conflict | GithubFailed>
}

export class GithubRepos extends Context.Service<GithubRepos, GithubReposShape>()("huntaway-server/github/GithubRepos") {
  static readonly layer = Layer.effect(
    GithubRepos,
    Effect.gen(function* () {
      const gh = yield* Gh
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* ServerConfig
      const locks = yield* KeyedLock
      const profiles = yield* ProfileRepo
      const projectRepo = yield* ProjectRepo
      const projects = yield* Projects
      const background = yield* FiberSet.make()
      /** Each account's login and organizations, and when they were looked up. */
      const known = yield* Ref.make<ReadonlyMap<string, { readonly at: number; readonly owners: ReadonlyArray<string> }>>(new Map())

      const run = (args: ReadonlyArray<string>, options: GhCallOptions) => gh.gh(args, options).pipe(Effect.mapError((e) => failed(e.message)))
      /** What gh prints as JSON, as `account`, or why it failed. */
      const ghJson = (account: string | null, args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const out = yield* run(args, { account, timeout: "60 seconds" })
          if (out.code !== 0) return yield* failed(ghError(out.stderr))
          return yield* Schema.decodeEffect(JsonText)(out.stdout).pipe(Effect.mapError((e) => failed(`couldn't read what gh printed: ${e.message}`)))
        })

      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
      const lexists = (p: string) =>
        fs.lstat(p).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      const isDir = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((i) => i.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      const canonical = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => null))
      const entries = (p: string) => fs.readDirectory(p).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      const removeAll = (p: string) => fs.remove(p, { recursive: true, force: true }).pipe(Effect.ignore)
      const ok = (dir: string, args: ReadonlyArray<string>) => git.run(dir, args).pipe(Effect.orElseSucceed(() => null))

      /**
       * The folder `p` (absolute) names, however it's written, as the file system would have it once the folders in it
       * that aren't there yet are made: each part that's there resolved (symlinks too), `..` the parent of what came
       * before. So it's the same before a clone makes them as after.
       */
      const folder = Effect.fnUntraced(function* (p: string) {
        let out = p.startsWith("/") ? "/" : ""
        for (const name of p.split("/")) {
          if (name === "" || name === ".") continue
          if (name === "..") {
            out = out === "/" || out === "" ? out : path.dirname(out) === "." ? "" : path.dirname(out)
            continue
          }
          out = out === "" ? name : path.join(out, name)
          out = (yield* canonical(out)) ?? out
        }
        return out
      })

      const accounts = Effect.gen(function* () {
        const out = yield* Effect.result(gh.gh(["auth", "status", "--json=hosts"], { account: null, timeout: "30 seconds" }))
        if (Result.isFailure(out)) return { accounts: [], error: out.failure.message }
        const parsed = yield* Effect.option(Schema.decodeEffect(JsonText)(out.success.stdout))
        if (out.success.code === 0 && Option.isSome(parsed)) return { accounts: accountsFromStatus(parsed.value), error: null }
        return { accounts: [], error: `gh auth status failed: ${out.success.stderr.trim()}` }
      }).pipe(Effect.withSpan("GithubRepos.accounts"))

      /** The login `account` acts as, then its organizations: the owners a search looks among. Kept a while. */
      const owners = Effect.fnUntraced(function* (account: string | null) {
        const key = account ?? ""
        const now = yield* Clock.currentTimeMillis
        const cached = (yield* Ref.get(known)).get(key)
        if (cached !== undefined && now - cached.at < OWNERS_TTL_MS) return cached.owners
        const [user, orgs] = yield* Effect.all([ghJson(account, ["api", "user"]), Effect.result(ghJson(account, ["api", "user/orgs?per_page=100"]))], {
          concurrency: 2,
        })
        const login = loginOf(user)
        if (login === null) return yield* failed("gh didn't say which GitHub account it's signed in as")
        // Without them (a token that can't list them), it searches the account's own.
        const list = [login, ...(Result.isSuccess(orgs) ? orgsOf(orgs.success) : [])]
        yield* Ref.update(known, (m) => new Map([...m, [key, { at: now, owners: list }]]))
        return list
      })

      const find = Effect.fnUntraced(function* (account: string | null, query: string | null) {
        if (query !== null) {
          const os = yield* owners(account)
          const q = searchQuery(query, os)
          if (q === null) return { login: os[0] ?? null, repos: [] }
          const found = yield* ghJson(account, ["api", "-X", "GET", "search/repositories", "-f", `q=${q}`, "-f", `per_page=${SEARCH_RESULTS}`])
          return { login: os[0] ?? null, repos: reposOf(Predicate.hasProperty(found, "items") ? found.items : []) }
        }
        const [user, first, contributed] = yield* Effect.all(
          [ghJson(account, ["api", "user"]), ghJson(account, ["api", userReposPage(1)]), Effect.result(ghJson(account, ["api", "graphql", "-f", CONTRIBUTED]))],
          { concurrency: 3 },
        )
        const login = loginOf(user)
        if (login === null) return yield* failed("gh didn't say which GitHub account it's signed in as")
        const all: Array<GithubRepo> = [...reposOf(first)]
        for (let n = 2; n <= PAGES; n++) {
          if (all.length < (n - 1) * 100) break
          all.push(...reposOf(yield* ghJson(account, ["api", userReposPage(n)])))
        }
        // Without them (an error about one of them, an organization's SSO say), its own are still listed.
        const theirs = Result.isSuccess(contributed) ? contributedOf(contributed.success) : []
        return { login, repos: latestFirst([...all, ...theirs]) }
      })

      const list = Effect.fn("GithubRepos.list")(function* (account: string | null, query: string | null) {
        const q = query?.trim() === "" ? null : (query?.trim() ?? null)
        const found = yield* Effect.result(find(account, q))
        if (Result.isFailure(found)) return { account, repos: [], error: found.failure.message }
        return { account: account ?? found.success.login, repos: found.success.repos, error: null }
      })

      /** The protocol gh is set up to clone from `host` with (`https` or `ssh`), in its own config. */
      const gitProtocol = (host: string) =>
        gh.gh(["config", "get", "git_protocol", "--host", host], { account: null, timeout: "10 seconds" }).pipe(
          Effect.map((out) => (out.code === 0 && out.stdout.trim() !== "" ? out.stdout.trim() : null)),
          Effect.orElseSucceed(() => null),
        )

      /** Whether `dir` is a clone of `repo` on `host`: the top of a git repository with a remote there. */
      const isCloneOf = Effect.fnUntraced(function* (dir: string, host: string, repo: string) {
        const top = yield* ok(dir, ["rev-parse", "--show-toplevel"])
        if (top === null || !top.ok) return false
        const [a, b] = [yield* canonical(top.stdout.trim()), yield* canonical(dir)]
        if (a === null || a !== b) return false
        const urls = yield* ok(dir, ["config", "--get-regexp", "^remote\\..*\\.url$"])
        for (const line of urls?.stdout.split("\n") ?? []) {
          const sp = line.indexOf(" ")
          if (sp < 0) continue
          const r = remoteRepo(line.slice(sp + 1).trim())
          if (r === null) continue
          const hostOk = host === "github.com" ? isGithubCom(r[0]) : r[0] === host
          if (hostOk && r[1].toLowerCase() === repo.toLowerCase()) return true
        }
        return false
      })

      /** Whether the clone in `dir` is checked out whole: HEAD is a commit, and nothing of it is missing from the index and files. */
      const checkedOut = Effect.fnUntraced(function* (dir: string) {
        const head = yield* ok(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        if (head === null || !head.ok) return false
        const status = yield* ok(dir, ["status", "--porcelain", "--untracked-files=no"])
        return status !== null && status.ok && status.stdout.trim() === ""
      })

      /** Takes away what a failed clone left in `dest`: the folder, or what's in it if it was there (empty) before. */
      const removeClone = Effect.fnUntraced(function* (dest: string, existed: boolean) {
        if (!existed) return yield* removeAll(dest)
        // A symlink goes itself, rather than what it points to.
        return yield* Effect.forEach(yield* entries(dest), (e) => removeAll(path.join(dest, e)), { concurrency: 1, discard: true })
      })

      const clone = Effect.fn("GithubRepos.clone")(function* (account: string | null, repo: string, dest: string) {
        const host = (account === null ? null : parseAccount(account)?.host) ?? "github.com"
        const existed = yield* exists(dest)
        if (existed) {
          if (yield* isCloneOf(dest, host, repo)) return false
          if ((yield* entries(dest)).length > 0) return yield* failed(`${dest} already exists`)
        } else {
          const parent = path.dirname(dest)
          yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError((e) => failed(`couldn't create ${parent}: ${e.message}`)))
        }
        // The account's own gh config clones over HTTPS, so SSH is asked for by URL when that's what gh is set up to use.
        const ssh = account !== null && (yield* gitProtocol(host)) === "ssh"
        const target = ssh ? `git@${host}:${repo}.git` : host !== "github.com" ? `${host}/${repo}` : repo
        const out = yield* Effect.result(
          run(["repo", "clone", target, dest], { account, plain: true, timeout: CLONE_TIMEOUT, env: { GIT_TERMINAL_PROMPT: "0" } }),
        )
        if (Result.isSuccess(out) && out.success.code === 0) return true
        const why = Result.isSuccess(out) ? ghError(out.success.stderr) : out.failure.message
        const cloned = yield* isCloneOf(dest, host, repo)
        // gh adds a fork's parent as its `upstream` remote once it has cloned it, which can fail with the clone whole.
        // Git keeps a clone whose checkout failed (to look into), which isn't.
        if (cloned && Result.isSuccess(out) && (yield* checkedOut(dest))) return true
        if (cloned) yield* removeClone(dest, existed)
        return yield* failed(`couldn't clone ${repo}: ${why}`)
      })

      const create = Effect.fn("GithubRepos.create")(function* (account: string | null, given: string, ownerIn: string | null, name: string, priv: boolean) {
        const parsed = account === null ? null : parseAccount(account)
        const host = parsed?.host ?? "github.com"
        const owner = ownerIn?.trim() === "" || ownerIn === null ? (parsed?.login ?? null) : ownerIn.trim()
        if (owner !== null && checkRepo(`${owner}/${name}`) === null) return yield* failed(`${owner}/${name} isn't a GitHub repository name`)
        // The folder the path names, however it's written, before anything's made or checked, so that what's rolled back
        // is what this call made and nothing that was there.
        const dir = yield* folder(given)
        // The folders this call makes, the destination first and then those above it that weren't there. A failure takes
        // the destination away (all of it is this call's) and the others only while they're empty.
        const created: Array<string> = []
        for (let a = dir; !(yield* lexists(a)); a = path.dirname(a)) {
          created.push(a)
          if (path.dirname(a) === a) break
        }
        const undo = (inited: boolean) =>
          Effect.gen(function* () {
            const [first, ...above] = created
            if (first !== undefined) {
              yield* removeAll(first)
              for (const f of above) {
                if ((yield* entries(f)).length > 0) break
                yield* removeAll(f)
              }
            } else if (inited) yield* removeAll(path.join(dir, ".git"))
          })
        const fail = (inited: boolean, message: string) => Effect.andThen(undo(inited), Effect.fail(failed(message)))
        if (created.length > 0) {
          const made = yield* Effect.result(fs.makeDirectory(dir, { recursive: true }))
          if (Result.isFailure(made)) return yield* fail(false, `couldn't create ${dir}: ${made.failure.message}`)
        }
        const probe = yield* git.run(dir, ["rev-parse", "--show-toplevel"]).pipe(Effect.result)
        if (Result.isFailure(probe)) return yield* fail(false, probe.failure.message)
        const top = probe.success.ok ? yield* canonical(probe.success.stdout.trim()) : null
        // Git metadata that's there but that git won't open (another owner's, damaged) isn't initialised over, and isn't
        // ours to take away if the repository can't be created.
        if (top === null && (yield* lexists(path.join(dir, ".git")))) {
          return yield* fail(false, `${dir} has a .git that git can't use, so no repository was created: ${probe.success.stderr.trim()}`)
        }
        const inited = top === null
        if (top !== null) {
          if (top !== (yield* canonical(dir))) return yield* fail(false, `${dir} is inside the repository ${top}: pick its top folder`)
          if ((yield* ok(dir, ["remote", "get-url", "origin"]))?.ok === true) return yield* fail(false, `${dir} already has a remote called origin`)
        } else {
          const init = yield* ok(dir, ["init", "-q"])
          if (init === null || !init.ok) return yield* fail(false, `git init failed: ${init?.stderr.trim() ?? "git couldn't run"}`)
        }
        const hasCommits = (yield* ok(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.ok === true
        const named = owner === null ? name : `${owner}/${name}`
        const target = host === "github.com" ? named : `${host}/${named}`
        const args = ["repo", "create", target, priv ? "--private" : "--public", "--source", dir, "--remote", "origin", ...(hasCommits ? ["--push"] : [])]
        const out = yield* Effect.result(run(args, { account, plain: true, cwd: dir, timeout: CREATE_TIMEOUT, env: { GIT_TERMINAL_PROMPT: "0" } }))
        const why = Result.isFailure(out) ? out.failure.message : out.success.code === 0 ? null : ghError(out.success.stderr)
        // gh makes the repository and adds the remote before it pushes, so a push that fails leaves both.
        const origin = yield* ok(dir, ["remote", "get-url", "origin"])
        const remote = origin?.ok === true ? origin.stdout.trim() : null
        const fromRemote = remote === null ? null : (remoteRepo(remote)?.[1] ?? null)
        const printed = Result.isSuccess(out)
          ? (out.success.stdout
              .split("\n")
              .toReversed()
              .map((l) => remoteRepo(l.trim())?.[1] ?? null)
              .find((r) => r !== null) ?? null)
          : null
        const full = printed ?? fromRemote ?? (owner === null ? null : `${owner}/${name}`)
        if (full === null || (why !== null && remote === null)) return yield* fail(inited, `couldn't create ${target}: ${why ?? "gh didn't say what it made"}`)
        // The account's own gh config adds an HTTPS remote, so SSH is asked for by URL when that's what gh is set up to use.
        if (account !== null && (yield* gitProtocol(host)) === "ssh") yield* ok(dir, ["remote", "set-url", "origin", `git@${host}:${full}.git`])
        return { full_name: full, pushed: hasCommits && why === null, push_error: why === null ? null : `couldn't push to ${target}: ${why}` }
      })

      const requireProfile = (id: ProfileId) =>
        Effect.flatMap(profiles.get(id), Option.match({ onNone: () => Effect.fail(new ProfileNotFound({ id })), onSome: Effect.succeed }))

      /** A key that would stop the project being added, checked before anything's made (and again as it's added). */
      const precheckKey = Effect.fnUntraced(function* (profileId: ProfileId, given: string | null | undefined) {
        const trimmed = given?.trim() ?? ""
        if (trimmed === "") return null
        const key = normalizeKey(trimmed)
        return yield* checkKey(yield* projectRepo.list(profileId), null, key)
      })

      /** Refused when `dest` is one of the profile's projects already. */
      const notAProject = Effect.fnUntraced(function* (profileId: ProfileId, dest: string, dir: string) {
        for (const p of yield* projectRepo.list(profileId)) {
          if ((yield* folder(expandTilde(p.repo_path, config.home))) === dir) {
            return yield* new Conflict({ reason: "in_use", detail: `${dest} is already the project "${p.name}"` })
          }
        }
        return undefined
      })

      /** `work` in the service's scope, so it carries on when its caller goes; its folder held meanwhile. */
      const reserved = <A, E>(dir: string, work: Effect.Effect<A, E>) =>
        Effect.flatMap(FiberSet.run(background, locks.withLock(["folder", dir])(work)), Fiber.join)

      const cloneProject = Effect.fn("GithubRepos.cloneProject")(function* (input: CloneProject) {
        const profile = yield* requireProfile(input.profile_id)
        const repo = checkRepo(input.repo)
        if (repo === null) return yield* new Invalid({ field: "repo", reason: "repo must be a GitHub repository, as OWNER/REPO" })
        const given = input.repo_path?.trim() ?? ""
        const cloneDir = profile.clone_dir?.trim() === "" || profile.clone_dir === null ? defaultCloneDir(profile.name) : profile.clone_dir.trim()
        const dest = given !== "" ? expandTilde(given, config.home) : path.join(expandTilde(cloneDir, config.home), repoFolder(repo))
        if (!path.isAbsolute(dest)) return yield* new Invalid({ field: "repo_path", reason: "repo_path must be an absolute path, or start with ~/" })
        const key = yield* precheckKey(profile.id, input.key)
        const dir = yield* folder(dest)
        return yield* reserved(
          dir,
          Effect.gen(function* () {
            yield* notAProject(profile.id, dest, dir)
            yield* clone(profile.github_account, repo, dest)
            return yield* projects.create({ profile_id: profile.id, name: input.name ?? "", repo_path: dest, key, base_branch: null, use_worktrees: null })
          }),
        )
      })

      const createProject = Effect.fn("GithubRepos.createProject")(function* (input: NewGithubProject) {
        const profile = yield* requireProfile(input.profile_id)
        const dest = expandTilde(input.repo_path.trim(), config.home)
        if (input.repo_path.trim() === "" || !path.isAbsolute(dest)) {
          return yield* new Invalid({ field: "repo_path", reason: "repo_path must be an absolute path, or start with ~/" })
        }
        if ((yield* exists(dest)) && !(yield* isDir(dest))) return yield* new Invalid({ field: "repo_path", reason: `${dest} is not a directory` })
        const repoName = checkName(
          input.repo_name?.trim() === "" || input.repo_name === null || input.repo_name === undefined ? path.basename(dest) : input.repo_name,
        )
        if (repoName === null) return yield* new Invalid({ field: "repo_name", reason: "the repository's name must be letters, digits, - _ and . (up to 100)" })
        const key = yield* precheckKey(profile.id, input.key)
        const dir = yield* folder(dest)
        return yield* reserved(
          dir,
          Effect.gen(function* () {
            yield* notAProject(profile.id, dest, dir)
            const made = yield* create(profile.github_account, dest, input.owner ?? null, repoName, input.visibility === "private")
            if (made.push_error !== null) yield* Effect.logWarning(made.push_error)
            const said = (why: string) => `created ${made.full_name} on GitHub, but couldn't add the project: ${why}`
            const project = yield* projects
              .create({ profile_id: profile.id, name: input.name ?? "", repo_path: dest, key, base_branch: null, use_worktrees: null })
              .pipe(
                Effect.catchTags({
                  Invalid: (e) => Effect.fail(new Invalid({ field: e.field, reason: said(e.reason) })),
                  Conflict: (e) => Effect.fail(new Conflict({ reason: e.reason, detail: said(e.detail) })),
                }),
              )
            return { project, github: made }
          }),
        )
      })

      return GithubRepos.of({ accounts, list, clone, create, cloneProject, createProject })
    }),
  )
}
