import type { Duration } from "effect"
import { Context, Effect, FiberSet, Layer, Option, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { TaskBase } from "../git/TaskBase.ts"
import { expandHome } from "../git/paths.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import type { PrApproval } from "../tasks/decide.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Gh } from "./Gh.ts"
import { previewFor } from "./prWatch/target.ts"

// A task's pull request (docs/plan/06-server.md, GitHub; docs/plan/inventory/04-git-review.md 2.11; huntaway's
// git/worktree/pr.ts and api/tasks.ts `preview_status`): finding it once its agent's run ends, whether moving the task to
// Done would leave work of its unmerged, whether it needs and has an approving review before a merge, and whether its
// preview answers. Pull requests are opened by the agents; the board only looks them up, as the task's GitHub account
// and never as another.

/** Whether a task's preview URL answers 200 (`board.previewStatus`): its status, or null and why it couldn't be asked. */
export interface PreviewStatus {
  readonly up: boolean
  readonly status: number | null
  readonly error?: string
}

const AnObject = Schema.Record(Schema.String, Schema.Unknown)
const isObject = Schema.is(AnObject)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const Reviews = Schema.Struct({
  reviewDecision: Schema.optional(Schema.Unknown),
  reviews: Schema.optional(Schema.Array(Schema.Unknown)),
})
const Review = Schema.Struct({
  author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.Unknown) }))),
  state: Schema.optional(Schema.Unknown),
  authorAssociation: Schema.optional(Schema.Unknown),
})
const decodeReviews = Schema.decodeUnknownOption(Reviews)
const decodeReview = Schema.decodeUnknownOption(Review)

/**
 * Whether a pull request (as `gh pr view --json reviewDecision,reviews` prints it) is approved: GitHub's decision if it
 * has one, else each reviewer's standing verdict from their reviews in order (comments keep it, a dismissal clears it)
 * is an approval with no change request standing.
 */
export const approvedByReviews = (v: unknown): boolean => {
  const pr = Option.getOrNull(decodeReviews(v))
  const decision = pr?.reviewDecision
  if (decision === "APPROVED") return true
  // Required reviews GitHub doesn't count as met (too few, or not from people who can write), or changes asked for.
  if (decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") return false
  const verdicts = new Map<string, string>()
  for (const raw of pr?.reviews ?? []) {
    const r = Option.getOrNull(decodeReview(raw))
    const who = r?.author?.login
    const st = r?.state
    if (typeof who !== "string" || typeof st !== "string") continue
    // Anyone can review a public repository's pull request: only those with a say in the repository count.
    const assoc = typeof r?.authorAssociation === "string" ? r.authorAssociation : ""
    if (st === "APPROVED" && !["OWNER", "MEMBER", "COLLABORATOR"].includes(assoc)) continue
    if (st === "APPROVED" || st === "CHANGES_REQUESTED") verdicts.set(who, st)
    else if (st === "DISMISSED") verdicts.delete(who)
  }
  const vs = new Set(verdicts.values())
  return vs.has("APPROVED") && !vs.has("CHANGES_REQUESTED")
}

export interface PullRequestsShape {
  /**
   * Look up the pull request of a task's branch with gh as its GitHub account (once its agent's run ends) and keep its
   * URL on the task, unless it has one or gets one meanwhile. Skipped for a task with no branch or one already set; quiet
   * when gh isn't installed or signed in, or the branch has no pull request yet. The URL found, if any.
   */
  readonly find: (task: TaskId) => Effect.Effect<string | null>
  /** `find` in the background (a run's end doesn't wait on GitHub). */
  readonly findLater: (task: TaskId) => Effect.Effect<void>
  /**
   * Whether moving a task to Done would leave work of its unmerged, for the board to ask first: it has work to merge
   * and its pull request, if it has one, isn't merged on GitHub (squashed or rebased, its commits aren't in its base
   * branch). A task with a document type has none. A pull request that can't be read in five seconds counts as not merged.
   */
  readonly unmerged: (task: Task) => Effect.Effect<boolean>
  /**
   * Whether a task needs an approving review on its pull request to go to Ready for merge (its project's
   * `require_pr_approval`, else its profile's), and whether the pull request it will have (`url`, its `pr_url` unless the
   * same change sets another) has one. Not required where the task's merge goes through no pull request.
   */
  readonly approval: (task: Task, url: string | null) => Effect.Effect<PrApproval>
  /** Whether a preview URL answers 200, asked from here (a browser can't read a cross-origin response's status). */
  readonly previewStatus: (url: string) => Effect.Effect<PreviewStatus>
  /**
   * A project's preview template changed from `before`'s to `after`'s: its tasks' previews of their pull requests follow
   * it. A preview set otherwise stays, and done tasks without one get none (their previews are gone).
   */
  readonly followPreviews: (before: Project, after: Project) => Effect.Effect<void>
}

export class PullRequests extends Context.Service<PullRequests, PullRequestsShape>()("huntaway-server/github/PullRequests") {
  static readonly layer = Layer.effect(
    PullRequests,
    Effect.gen(function* () {
      const gh = yield* Gh
      const base = yield* TaskBase
      const repo = yield* TaskRepo
      const tasks = yield* Tasks
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const config = yield* ServerConfig
      const client = yield* HttpClient.HttpClient
      const background = yield* FiberSet.make()

      const projectOf = (task: Task) =>
        task.project_id === null ? Effect.succeed(null) : Effect.map(projects.get(task.project_id), (p) => Option.getOrNull(p))

      /** The JSON a gh command prints, as the task's account, or null when it fails (not signed in, no such pull request…). */
      const ghJson = Effect.fnUntraced(function* (task: Task, cwd: string, args: ReadonlyArray<string>, timeout: Duration.Input) {
        const account = yield* base.account(task)
        const out = yield* Effect.result(gh.gh(args, { cwd, account, timeout }))
        if (Result.isFailure(out)) {
          yield* Effect.logWarning(`task=${task.id}: couldn't ask GitHub about its pull request: ${out.failure.message}`)
          return null
        }
        if (out.success.code !== 0) return null
        return Option.getOrNull(decodeJson(out.success.stdout))
      })

      const find = Effect.fn("PullRequests.find")(function* (id: TaskId) {
        const task = yield* repo.get(id)
        if (task === null || task.branch === null || task.pr_url !== null || task.kind !== "task") return null
        const project = yield* projectOf(task)
        if (project === null) return null
        const repoPath = expandHome(project.repo_path, config.home)
        const dir = task.worktree_path !== null && task.worktree_state === "ready" ? task.worktree_path : repoPath
        // In the GitHub repository it's pushed to, which gh wouldn't pick from the remotes' fetch URLs if they're elsewhere.
        const where = yield* base.github(repoPath, yield* base.remoteBase(task, project))
        const args = ["pr", "view", task.branch, "--json", "url", ...(where === null ? [] : ["--repo", where.repo])]
        const found = yield* ghJson(task, dir, args, "30 seconds")
        const url = isObject(found) ? found["url"] : undefined
        if (typeof url !== "string" || !url.startsWith("https://")) return null
        // Unless it was set meanwhile.
        yield* tasks.change(id, (t) => (t.pr_url === null ? { pr_url: url } : null), Actor.board).pipe(Effect.ignore)
        return url
      })

      const unmerged = Effect.fn("PullRequests.unmerged")(function* (task: Task) {
        if (task.kind !== "task" || task.task_type !== null || !(yield* base.hasWorkToMerge(task))) return false
        const url = task.pr_url
        if (url === null) return true
        const project = yield* projectOf(task)
        if (project === null) return true
        const pr = yield* ghJson(task, expandHome(project.repo_path, config.home), ["pr", "view", url, "--json", "state"], "5 seconds")
        return !(isObject(pr) && pr["state"] === "MERGED")
      })

      const approval = Effect.fn("PullRequests.approval")(function* (task: Task, url: string | null) {
        const project = yield* projectOf(task)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const required = project?.require_pr_approval ?? profile?.require_pr_approval ?? false
        // Agents open a pull request only for a task with its own branch, in a project that has them, pushed to GitHub.
        if (project === null || !project.pull_requests || !required || task.branch === null) return { _tag: "NotRequired" } satisfies PrApproval
        const repoPath = expandHome(project.repo_path, config.home)
        if ((yield* base.github(repoPath, yield* base.remoteBase(task, project))) === null) return { _tag: "NotRequired" } satisfies PrApproval
        const answer = (approved: boolean, error: string | null): PrApproval => ({ _tag: "Required", url, approved, error })
        if (url === null) return answer(false, "the task has no pull request yet; open one and get it approved on GitHub first")
        const pr = yield* ghJson(task, repoPath, ["pr", "view", url, "--json", "reviewDecision,reviews"], "30 seconds")
        if (pr === null) return answer(false, "couldn't read the pull request's reviews from GitHub")
        return answer(approvedByReviews(pr), null)
      })

      const previewStatus = Effect.fn("PullRequests.previewStatus")(function* (url: string) {
        const res = yield* client.execute(HttpClientRequest.get(url)).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.result)
        if (Result.isSuccess(res)) return { up: res.success.status === 200, status: res.success.status } satisfies PreviewStatus
        const error = res.failure._tag === "TimeoutError" ? "timed out after 5 seconds" : res.failure.message
        return { up: false, status: null, error } satisfies PreviewStatus
      })

      const followPreviews = Effect.fn("PullRequests.followPreviews")(function* (before: Project, after: Project) {
        for (const t of yield* repo.projectTasks(after.id)) {
          if (t.kind !== "task") continue
          const ours = t.preview_url !== null ? t.preview_url === previewFor(before.pr_preview_url, t.pr_url) : t.status !== "done"
          const preview = previewFor(after.pr_preview_url, t.pr_url)
          if (!ours || preview === t.preview_url) continue
          // Unless the task changed meanwhile.
          yield* tasks
            .change(t.id, (now) => (now.preview_url === t.preview_url && now.pr_url === t.pr_url ? { preview_url: preview } : null), Actor.board)
            .pipe(Effect.ignore)
        }
      })

      return PullRequests.of({
        followPreviews,
        find,
        findLater: (id) =>
          FiberSet.run(background, find(id).pipe(Effect.catchCause((cause) => Effect.logWarning(`task=${id}: looking up its pull request`, cause)))).pipe(
            Effect.asVoid,
          ),
        unmerged,
        approval,
        previewStatus,
      })
    }),
  )
}
