import { Effect } from "effect"
import type { Branch, Project, StartFrom, Task } from "@huntaway/contracts"
import { isMerged } from "../../tasks/checks.ts"
import type { GitShape } from "../Git.ts"
import type { GitHubAccessShape } from "../GitHubAccess.ts"
import { lines } from "../paths.ts"
import { fail, WorktreeFailed } from "./failed.ts"
import { github, pushRemote } from "./remote.ts"
import type { SshHostname } from "./remote.ts"
import { taskBase } from "./stacks.ts"
import type { Lookup } from "./stacks.ts"
import { fetchCommit, fetchUpstream, remoteBranch, upstream } from "./upstream.ts"

// Tasks that start from something other than their project's base branch (`start_from`): where they start
// (`pickStart`) and the branches to pick from (huntaway's git/worktree/start.ts; inventory 04, section 2.3).

/** Where a task asked to start from something other than its project's base branch starts, worked out as its worktree is first made. */
export interface Picked {
  /** Its base branch, which its pull request targets and its changes are compared with; null for the project's. */
  readonly base: string | null
  /** The commit its branch starts at, and what it is for the log, when that isn't its base branch's latest (a commit; a pull request from a fork). */
  readonly commit: readonly [string, string] | null
  /** Thread notes, as level and text. */
  readonly notes: ReadonlyArray<readonly ["info" | "warn", string]>
}

/** What `pickStart` reaches beyond git. */
export interface PickDeps {
  readonly git: GitShape
  readonly gh: GitHubAccessShape
  readonly get: Lookup
  readonly ssh: SshHostname
  /** The GitHub account the task's fetches and gh calls go as. */
  readonly account: string | null
  /** A note in the task's thread. */
  readonly note: (text: string) => Effect.Effect<void>
  /** Set up `other`'s worktree first (`Worktrees.setup`, within the setups already under way). */
  readonly setUp: (other: Task) => Effect.Effect<Task, WorktreeFailed>
}

/** The base branch a task in `project` gets when it doesn't say: the project's, or the branch checked out in its repository. */
export const projectBase = (g: GitShape, repo: string, project: Pick<Project, "base_branch">) =>
  project.base_branch !== null && project.base_branch !== "" ? Effect.succeed(project.base_branch) : g.currentBranch(repo)

const picked = (base: string, note: string): Picked => ({ base, commit: null, notes: [["info", note]] })

/**
 * Work out where `task` starts from `sf`. A task it's stacked on that has no branch yet has its worktree set up first;
 * one that's merged already has its task start from where it was merged. So does a merged pull request; one from a fork
 * (or closed) starts from its head commit, fetched by its SHA, with the pull request's base as the task's.
 */
export const pickStart = Effect.fnUntraced(function* (deps: PickDeps, task: Task, project: Project, repo: string, sf: StartFrom) {
  const g = deps.git
  switch (sf.type) {
    case "branch": {
      const branch = sf.branch
      // A remote's branch (`origin/feature`) is the branch of that name when that's the remote the name alone follows
      // (where its pull request goes).
      const rb = yield* remoteBranch(g, repo, branch)
      if (rb === null || (yield* g.commit(repo, `refs/heads/${branch}`)) !== null) return picked(branch, `Starting from branch ${branch}`)
      const [remote, name] = rb
      const follows = yield* upstream(g, repo, name)
      if (follows !== null && follows.remote === remote && follows.merge === `refs/heads/${name}`) return picked(name, `Starting from branch ${name}`)
      // Another remote's (`upstream/feature`) isn't a branch the task's pull request can target, which goes to the push
      // remote's repository: like a pull request from a fork, its latest commit it is (fetched), and the base branch the
      // project's.
      const up = yield* upstream(g, repo, branch)
      if (up === null) return yield* fail(`couldn't tell where ${branch} is fetched from`)
      yield* fetchUpstream(g, deps.gh, repo, up, deps.account).pipe(Effect.catch((e) => Effect.logWarning(`task ${task.id}: fetching ${branch}: ${e.reason}`)))
      const tip = yield* g.commit(repo, up.tracking)
      if (tip === null) return yield* fail(`branch ${branch} isn't in the repository (fetching it failed)`)
      const note =
        `${branch} is on ${remote}, which this task's pull request doesn't go to, so starting from its latest commit ${tip.slice(0, 12)}: ` +
        "this task's pull request targets the base branch, with its commits too"
      const out: Picked = { base: null, commit: [tip, branch], notes: [["info", note]] }
      return out
    }
    case "task": {
      const other = yield* deps.get(sf.task_id)
      if (other === null) return yield* fail("the task this one starts from was deleted")
      const key = other.key
      if (isMerged(other)) {
        // Where it went: that's merged too when it was stacked on another task (see `taskBase`).
        const base = yield* taskBase(deps.get, other, project)
        const out: Picked = { base, commit: null, notes: [["info", `${key} is merged already, so starting from ${base ?? "the base branch"}`]] }
        return out
      }
      let branch: string
      if (other.branch !== null) branch = other.branch
      else if (other.use_worktree) {
        yield* deps.note(`Setting up ${key}'s worktree first, to start from its branch…`)
        const setUp = yield* deps.setUp(other).pipe(Effect.mapError((e) => new WorktreeFailed({ reason: `setting up ${key}'s worktree: ${e.reason}` })))
        if (setUp.branch === null) return yield* fail(`${key} has no branch to start from`)
        branch = setUp.branch
      } else return yield* fail(`${key} has no branch to start from: it doesn't use a worktree`)
      return picked(branch, `Lands after ${key}: starting from its branch ${branch}, which this task's pull request targets`)
    }
    case "pull_request": {
      const number = sf.number
      const named = sf.repo ?? null
      // Where the project's tasks open their pull requests: its base branch's remote's repository.
      const gh = yield* github(g, deps.ssh, repo, yield* projectBase(g, repo, project))
      if (gh === null) return yield* fail(`${project.repo_path} isn't on GitHub, so it has no pull request #${number}`)
      if (named !== null && named.toLowerCase() !== gh.repo.toLowerCase()) {
        return yield* fail(`pull request #${number} is in ${named}, not in the project's repository ${gh.repo}`)
      }
      const pr = yield* deps.gh
        .pullRequest(repo, deps.account, String(number), gh.repo)
        .pipe(Effect.mapError((e) => new WorktreeFailed({ reason: `couldn't read pull request #${number} of ${gh.repo} with gh: ${e.reason}` })))
      if (pr === null) return yield* fail(`couldn't read pull request #${number} of ${gh.repo} with gh`)
      const head = pr.headRefName
      const base = pr.baseRefName
      const oid = pr.headRefOid
      if (head === "" || base === "" || oid === "") return yield* fail(`gh didn't say where pull request #${number} of ${gh.repo} is`)
      if (pr.state === "MERGED") return picked(base, `Pull request #${number} is merged already, so starting from its base ${base}`)
      // Its branch, if the name alone follows the remote it's on (where this task's pull request goes too).
      const up = yield* upstream(g, repo, head)
      const follows = up !== null && up.remote === gh.remote && up.merge === `refs/heads/${head}`
      if (pr.state === "OPEN" && !pr.isCrossRepository && follows) {
        return picked(head, `Starting from pull request #${number}'s branch ${head}, which this task's pull request targets`)
      }
      // Its branch isn't one the task's pull request can target: its commit it is.
      yield* fetchCommit(g, deps.gh, repo, gh.remote, oid, deps.account).pipe(
        Effect.mapError((e) => new WorktreeFailed({ reason: `fetching pull request #${number}'s head ${oid}: ${e.reason}` })),
      )
      const why =
        pr.state === "OPEN"
          ? !pr.isCrossRepository
            ? `has its branch on ${gh.remote}, which ${head} alone doesn't follow here`
            : "is from a fork"
          : "is closed"
      const note =
        `Pull request #${number} ${why}, so starting from its head commit ${oid.slice(0, 12)} on top of ${base}: ` +
        `this task's pull request targets ${base}, with its commits too`
      const out: Picked = { base, commit: [oid, `pull request #${number}`], notes: [["info", note]] }
      return out
    }
    case "commit": {
      const sha = sf.commit
      let found = yield* g.commit(repo, sha)
      if (found === null) {
        // GitHub (like most hosts) hands out a commit that's on one of its branches by its full SHA.
        const remote = (yield* pushRemote(g, repo, yield* projectBase(g, repo, project)))?.[0] ?? null
        if (remote === null || sha.length !== 40) return yield* fail(`commit ${sha} isn't in the repository (give its full SHA to fetch it)`)
        yield* fetchCommit(g, deps.gh, repo, remote, sha, deps.account).pipe(
          Effect.mapError((e) => new WorktreeFailed({ reason: `fetching commit ${sha}: ${e.reason}` })),
        )
        found = yield* g.commit(repo, sha)
        if (found === null) return yield* fail(`commit ${sha} isn't in the repository`)
      }
      const short = found.slice(0, 12)
      const out: Picked = { base: null, commit: [found, short], notes: [["info", `Starting from commit ${short}`]] }
      return out
    }
  }
  // Every kind is above; this is a `start_from` that isn't one of them.
  return yield* fail("unknown start_from")
})

/**
 * The branches of `repo`, newest commits first, up to 200: `{name, remote}` for each, those only on a remote named with
 * it (`origin/feature`), as a task's `start_from` takes them.
 */
export const branches = Effect.fnUntraced(function* (g: GitShape, repo: string) {
  const list = yield* g
    .ok(repo, ["for-each-ref", "--sort=-committerdate", "--count=400", "--format=%(refname)", "refs/heads", "refs/remotes"])
    .pipe(Effect.orElseSucceed(() => null))
  if (list === null) return []
  const refs = lines(list).map((r) => r.trim())
  const local = new Set(refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length)))
  const out: Array<Branch> = []
  for (const r of refs) {
    if (out.length >= 200) break
    if (r.startsWith("refs/heads/")) out.push({ name: r.slice("refs/heads/".length), remote: false })
    else if (r.startsWith("refs/remotes/")) {
      // Not a remote's HEAD, nor a branch that's here too.
      const name = r.slice("refs/remotes/".length)
      const i = name.indexOf("/")
      if (i < 0) continue
      const b = name.slice(i + 1)
      if (b !== "HEAD" && !local.has(b)) out.push({ name, remote: true })
    }
  }
  return out
})

/**
 * Record the branch `branch`'s pull request goes to, when that isn't the project's base branch (another task's), as
 * `gh pr create` reads it (`branch.<b>.gh-merge-base`), so an agent's pull request targets it even without `--base`.
 * Null (or the project's base branch) clears it. Best effort.
 */
export const setMergeBase = (g: GitShape, repo: string, branch: string, base: string | null, mainBase: string | null) => {
  const key = `branch.${branch}.gh-merge-base`
  return (base !== null && base !== mainBase ? g.run(repo, ["config", key, base]) : g.run(repo, ["config", "--unset", key])).pipe(Effect.ignore)
}
