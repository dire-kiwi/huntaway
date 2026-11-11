import { Clock, Context, Duration, Effect, FiberSet, Layer, Option, Ref, Schema, Semaphore } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import type { GitHubRestack } from "../git/GitHubAccess.ts"
import { expandHome } from "../git/paths.ts"
import { taskBase } from "../git/worktree/stacks.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { stackedBelow, stackedLevels } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Gh } from "./Gh.ts"
import { targetOfUrl, targetUrl } from "./prWatch/target.ts"
import type { Target } from "./prWatch/target.ts"

// GitHub's stacked pull requests (docs/plan/06-server.md, GitHub; inventory 04, section 2.16; huntaway's
// git/worktree/gh_stack.ts, HA-336). A stack level lands after the task below it, which the board sees to whether or
// not GitHub knows. Once a level's pull request and the one below's are both open in the same repository, the board
// links them as a stack there too (`POST repos/O/R/stacks`, or `…/stacks/N/add` on top of the one below's stack), keeps
// its number (`github_stack`), and only then calls the level "stacked". In a stack on GitHub, pull requests can't be
// merged with the legacy API (the gh tools' `pr_merge` uses merge-async) nor have their base changed until unstacked;
// once the bottom one is merged, GitHub retargets the next and, a few seconds later, rebases its own commits and
// force-pushes its branch, which a restack waits for and takes in (`restacked`). GitHub stacks are single chains.
//
// Built on the git line (it needs only `Gh` and the task rows), so that `GitHubAccess` (the git area's seam) can offer
// the restack what it needs of it.

/** How long a linked level's restack waits for GitHub's rebase of it, and how often it looks. Tests shorten it. */
export const GhStackWait = Context.Reference<{ readonly wait: Duration.Input; readonly poll: Duration.Input }>("huntaway-server/github/GhStacks/GhStackWait", {
  defaultValue: () => ({ wait: "90 seconds", poll: "3 seconds" }),
})

/** A pull request as GitHub's REST API gives it, as much as the board reads (`gh api repos/O/R/pulls/N`). */
const Pull = Schema.Struct({
  state: Schema.optional(Schema.String),
  head: Schema.optional(Schema.Struct({ ref: Schema.optional(Schema.String), sha: Schema.optional(Schema.String) })),
  base: Schema.optional(Schema.Struct({ ref: Schema.optional(Schema.String) })),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
  stack: Schema.optional(
    Schema.NullOr(Schema.Struct({ number: Schema.optional(Schema.Finite), position: Schema.optional(Schema.Finite), size: Schema.optional(Schema.Finite) })),
  ),
})
type Pull = typeof Pull.Type
const decodePull = Schema.decodeOption(Schema.fromJsonString(Pull))
const Made = Schema.Struct({ number: Schema.optional(Schema.Finite) })
const decodeMade = Schema.decodeOption(Schema.fromJsonString(Made))
const BaseRef = Schema.Struct({ baseRefName: Schema.optional(Schema.String) })
const decodeBaseRef = Schema.decodeOption(Schema.fromJsonString(BaseRef))

/** The URL of stack `number` in pull request `pr`'s repository. */
export const stackUrl = (pr: Target, number: number): string => `https://${pr.host}/${pr.owner}/${pr.name}/stack/${number}`

const repoPath = (pr: Target) => `repos/${pr.owner}/${pr.name}`
const sameRepo = (a: Target, b: Target) => a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()

export interface GhStacksShape {
  /**
   * Task `id`'s pull request was set (or changed), or it was restacked: link it into a stack on GitHub with the one below
   * it, and the levels on it with it. In the background, one link at a time.
   */
  readonly link: (id: TaskId) => Effect.Effect<void>
  /** Link the open stack levels with pull requests that aren't in a GitHub stack yet, as when the server starts. */
  readonly linkAll: Effect.Effect<void>
  /** Waits for the links asked for so far (tests). */
  readonly settled: Effect.Effect<void>
  /**
   * Linked level `task`'s level below was merged: wait (up to `GhStackWait`) for GitHub's rebase of its branch, from
   * `pushed` (where the branch was on the remote) onto `base`. `unstacked` clears its `github_stack`.
   */
  readonly restacked: (task: Task, dir: string, pushed: string, base: string) => Effect.Effect<GitHubRestack>
  /**
   * Have task `task`'s pull request (`url`) target `to`, unstacking it on GitHub first if it's in a stack there: whether it
   * moved, or why it couldn't.
   */
  readonly retarget: (task: Task, dir: string, url: string, to: string) => Effect.Effect<{ readonly moved: boolean } | { readonly error: string }>
}

export class GhStacks extends Context.Service<GhStacks, GhStacksShape>()("huntaway-server/github/GhStacks") {
  static readonly layer = Layer.effect(
    GhStacks,
    Effect.gen(function* () {
      const gh = yield* Gh
      const repo = yield* TaskRepo
      const tasks = yield* Tasks
      const threads = yield* Threads
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const config = yield* ServerConfig
      // The pull request pairs tried for each level, so a failure is said once, not on every change.
      const tried = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
      // One link at a time: a level on one being linked joins that stack rather than making another.
      const linking = yield* Semaphore.make(1)
      const links = yield* FiberSet.make()

      const board = Actor.board
      const say = (id: TaskId, text: string, detail?: string) => threads.notice(id, "info", text, detail).pipe(Effect.ignore)
      const get = (id: string) => repo.get(id)

      /** The GitHub account task `t`'s gh calls go as: its project's, else its profile's. */
      const account = Effect.fnUntraced(function* (t: Task) {
        const project = t.project_id === null ? null : Option.getOrNull(yield* projects.get(t.project_id))
        const own = project?.github_account?.trim() ?? ""
        if (own !== "") return own
        const p = Option.getOrNull(yield* profiles.get(t.profile_id))?.github_account?.trim() ?? ""
        return p === "" ? null : p
      })

      /** The folder gh runs in for task `t`: its project's repository. */
      const dirOf = Effect.fnUntraced(function* (t: Task) {
        const project = t.project_id === null ? null : Option.getOrNull(yield* projects.get(t.project_id))
        return project === null ? null : expandHome(project.repo_path, config.home)
      })

      /** `gh api` as task `t`'s account, in `dir`: what it printed, or why it failed. */
      const api = Effect.fnUntraced(function* (t: Task, dir: string, pr: Target, args: ReadonlyArray<string>) {
        const full = ["api", ...(pr.host !== "github.com" ? ["--hostname", pr.host] : []), ...args]
        const out = yield* gh.gh(full, { cwd: dir, account: yield* account(t), timeout: "60 seconds" }).pipe(Effect.result)
        if (out._tag === "Failure") return { error: out.failure.message }
        if (out.success.code !== 0) return { error: out.success.code === null ? "gh timed out" : out.success.stderr.trim() || "gh api failed" }
        return { out: out.success.stdout }
      })
      const pullOf = Effect.fnUntraced(function* (t: Task, dir: string, pr: Target) {
        const r = yield* api(t, dir, pr, [`${repoPath(pr)}/pulls/${pr.number}`])
        return "error" in r ? null : Option.getOrNull(decodePull(r.out))
      })

      const stackOf = Effect.fnUntraced(function* (t: Task, dir: string) {
        const pr = targetOfUrl(t.pr_url)
        if (pr === null) return null
        return (yield* pullOf(t, dir, pr))?.stack?.number ?? null
      })

      /** Takes `t`'s pull request out of stack `n` on GitHub (and every one in it): null once done, else why not. */
      const unstack = Effect.fnUntraced(function* (t: Task, dir: string, n: number) {
        const pr = targetOfUrl(t.pr_url)
        if (pr === null || t.project_id === null) return null
        const r = yield* api(t, dir, pr, ["-X", "POST", `${repoPath(pr)}/stacks/${n}/unstack`])
        // Gone already (404) is as good as unstacked.
        if ("error" in r && !/HTTP 404/.test(r.error)) return r.error
        for (const x of (yield* repo.projectTasks(t.project_id)).filter((s) => s.github_stack === n)) {
          yield* Ref.update(tried, (m) => new Map([...m].filter(([k]) => k !== x.id)))
          yield* tasks.change(x.id, (now) => (now.github_stack === null ? null : { github_stack: null }), board).pipe(Effect.ignore)
          if (x.id !== t.id && x.status !== "done") yield* say(x.id, `Its pull request was unstacked on GitHub, with ${t.key}'s`)
        }
        yield* say(t.id, "Unstacked its pull request on GitHub, so its base can be changed")
        return null
      })

      /** Links stack level `id` with the one below it on GitHub, if it can be (the old `link`). */
      const linkOne = (id: string, depth: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const t = yield* get(id)
          if (t === null || t.status === "done" || t.github_stack !== null || t.project_id === null) return
          const projectId = t.project_id
          const rows = yield* repo.projectTasks(projectId)
          let below = stackedBelow(rows, t)?.task ?? null
          if (below === null || below.status === "done") return
          // The level below goes in a stack with its own first, if it can: GitHub adds to a stack's top, not below it.
          if (below.github_stack === null && stackedBelow(rows, below) !== null && depth < 16) {
            yield* linkOne(below.id, depth + 1)
            below = (yield* get(below.id)) ?? below
          }
          const up = targetOfUrl(t.pr_url)
          const low = targetOfUrl(below.pr_url)
          if (up === null || low === null || !sameRepo(up, low)) return
          const pair = `${targetUrl(up)} ${targetUrl(low)} ${below.github_stack ?? ""}`
          if ((yield* Ref.get(tried)).get(id) === pair) return
          const dir = yield* dirOf(t)
          if (dir === null) return
          const them = below.key
          const [mine, theirs] = yield* Effect.all([pullOf(t, dir, up), pullOf(t, dir, low)], { concurrency: 2 })
          // Unreadable (gh not signed in, say): tried again on the next change, or when the server starts.
          if (mine === null || theirs === null || mine.state !== "open" || theirs.state !== "open") return
          yield* Ref.update(tried, (m) => new Map([...m, [id, pair]]))
          const beside = (text: string) => say(t.id, `${text}: it lands after ${them} all the same, and the board restacks it`)
          const done = Effect.fnUntraced(function* (number: number) {
            yield* tasks.change(t.id, () => ({ github_stack: number }), board).pipe(Effect.ignore)
            yield* say(t.id, `Its pull request is stacked on ${them}'s on GitHub: ${stackUrl(up, number)}`)
            // The levels on it can go on top of it now.
            for (const x of stackedLevels(yield* repo.projectTasks(projectId), t.id)) yield* linkOne(x.id, depth + 1)
          })
          const sm = mine.stack ?? null
          const st = theirs.stack ?? null
          // In a stack already (linked by hand, or before the server stopped): kept if it's on that one's.
          if (sm?.number !== undefined && sm !== null) {
            if (st?.number === sm.number && st.position === (sm.position ?? 0) - 1) yield* done(sm.number)
            else yield* beside(`Its pull request is in a stack on GitHub that ${them}'s isn't just below it in`)
            return
          }
          if (mine.base?.ref !== theirs.head?.ref) {
            yield* beside(`Its pull request targets ${mine.base?.ref ?? "another branch"} rather than ${them}'s branch, so it isn't stacked on GitHub`)
            return
          }
          // The bottom of a new stack is one whose base the board never changes: a task of the project's own whose pull
          // request targets its base branch. Otherwise the one below has to be in a stack itself.
          if (below.github_stack === null) {
            const moves =
              below.merges_into !== null
                ? "the task it merges into"
                : stackedBelow(rows, below) !== null
                  ? "the task it lands after"
                  : below.start_from?.type === "pull_request"
                    ? "the pull request it started from"
                    : null
            if (moves !== null) {
              yield* beside(
                `${them} isn't in a stack on GitHub itself, and its pull request's base changes once ${moves} lands, so this one isn't stacked on it there`,
              )
              return
            }
            const project = Option.getOrNull(yield* projects.get(projectId))
            const trunk = yield* taskBase(get, below, project)
            if (trunk === null || theirs.base?.ref !== trunk) {
              yield* beside(
                `${them}'s pull request targets ${theirs.base?.ref ?? "another branch"} rather than ${trunk ?? "its base branch"}, so this one isn't stacked on it on GitHub`,
              )
              return
            }
          }
          let made: { readonly out: string } | { readonly error: string }
          if (st?.number !== undefined && st !== null) {
            // GitHub's stacks are single chains: another pull request is on that one's already.
            if (st.position !== st.size) {
              yield* beside(`${them}'s pull request has another stacked on it on GitHub already, so this one isn't`)
              return
            }
            made = yield* api(t, dir, up, ["-X", "POST", `${repoPath(up)}/stacks/${st.number}/add`, "-F", `pull_requests[]=${up.number}`])
          } else {
            made = yield* api(t, dir, up, ["-X", "POST", `${repoPath(up)}/stacks`, "-F", `pull_requests[]=${low.number}`, "-F", `pull_requests[]=${up.number}`])
          }
          const number = "error" in made ? undefined : Option.getOrNull(decodeMade(made.out))?.number
          if (number === undefined) {
            yield* say(
              t.id,
              `Couldn't stack its pull request on ${them}'s on GitHub: it lands after ${them} all the same, and the board restacks it`,
              "error" in made ? made.error : "GitHub didn't say which stack",
            )
            return
          }
          // Unless it changed meanwhile.
          if ((yield* get(t.id))?.pr_url === t.pr_url) yield* done(number)
        })

      const queue = (id: string) =>
        FiberSet.run(
          links,
          Semaphore.withPermits(
            linking,
            1,
          )(linkOne(id, 0).pipe(Effect.catchCause((c) => Effect.logError(`task ${id}: linking its pull request on GitHub`, c)))),
        ).pipe(Effect.asVoid)

      const link = Effect.fn("GhStacks.link")(function* (id: TaskId) {
        const t = yield* get(id)
        if (t === null || t.project_id === null) return
        yield* queue(id)
        for (const x of stackedLevels(yield* repo.projectTasks(t.project_id), id)) yield* queue(x.id)
      })

      const linkAll = Effect.gen(function* () {
        for (const t of yield* repo.all) {
          if (t.kind !== "task" || t.status === "done" || t.github_stack !== null || t.pr_url === null || t.project_id === null) continue
          if (stackedBelow(yield* repo.projectTasks(t.project_id), t) !== null) yield* queue(t.id)
        }
      }).pipe(Effect.withSpan("GhStacks.linkAll"))

      const restacked = Effect.fn("GhStacks.restacked")(function* (t: Task, dir: string, pushed: string, base: string) {
        const pr = targetOfUrl(t.pr_url)
        if (pr === null) return "unknown" as const
        const { wait, poll } = yield* GhStackWait
        const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(wait)
        for (;;) {
          const p: Pull | null = yield* pullOf(t, dir, pr)
          if (p !== null) {
            if (p.state !== "open") return "unknown" as const
            if (p.stack === null || p.stack === undefined) {
              yield* tasks.change(t.id, (now) => (now.github_stack === null ? null : { github_stack: null }), board).pipe(Effect.ignore)
              yield* say(t.id, "Its pull request isn't in a stack on GitHub any more, so the board restacks it")
              return "unstacked" as const
            }
            if (typeof p.head?.sha === "string" && p.head.sha !== pushed) return "rebased" as const
            if (p.base?.ref === base && p.mergeable_state === "dirty") return "conflict" as const
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) return "unknown" as const
          yield* Effect.sleep(poll)
        }
      })

      const retarget = Effect.fn("GhStacks.retarget")(function* (t: Task, dir: string, url: string, to: string) {
        const account_ = yield* account(t)
        // What it targets now (unknown if gh can't say, when it's changed anyway).
        const viewed = yield* gh.gh(["pr", "view", url, "--json", "baseRefName"], { cwd: dir, account: account_, timeout: "60 seconds" }).pipe(Effect.option)
        const now = Option.isSome(viewed) && viewed.value.code === 0 ? (Option.getOrNull(decodeBaseRef(viewed.value.stdout))?.baseRefName ?? null) : null
        if (now === to) return { moved: false }
        // GitHub doesn't change the base of a pull request in a stack, whether the board recorded it or GitHub says so.
        const stack = t.github_stack ?? (yield* stackOf(t, dir))
        if (stack !== null) {
          const e = yield* unstack(t, dir, stack)
          if (e !== null) return { error: `it's in a stack on GitHub, which couldn't be unstacked: ${e}` }
        }
        const out = yield* gh.gh(["pr", "edit", url, "--base", to], { cwd: dir, account: account_, timeout: "60 seconds" }).pipe(Effect.result)
        if (out._tag === "Failure") return { error: out.failure.message }
        if (out.success.code === 0) return { moved: true }
        return { error: out.success.code === null ? "gh timed out" : out.success.stderr.trim() || "gh pr edit failed" }
      })

      return GhStacks.of({ link, linkAll, settled: FiberSet.awaitEmpty(links), restacked, retarget })
    }),
  )
}
