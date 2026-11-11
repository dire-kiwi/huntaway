import { Effect, FileSystem, Schema } from "effect"
import { REPO_ROOT } from "./fakeAgent.ts"
import { tempDir } from "./TestBoard.ts"

// A fake GitHub for tests (docs/plan/10-testing.md, packages/testing): its state, which bin/fake-gh.ts answers the
// board's and its agents' gh calls from, and the `gh` to give the server (`ServerConfig.ghBin`). bin/fake-gh.ts says
// what it answers. A test makes one with what it needs (accounts, repositories with their pull requests, checks,
// reviews and stacks), gives `bin` to the server, and reads back what changed and every call gh was given (`calls`).
// Later tasks extend it: merges (4.7), stacks (4.8). Pull requests' GraphQL reads (4.5) take a pull request's checks
// (with their job ids, required flags, suites and statuses), comments, reviews and review threads (paged by `threadsPage`),
// and its failed jobs' logs from the repository's `jobs`.

/** A login gh has: `auth token --hostname=<host> --user=<login>` prints its token. */
export const FakeAccount = Schema.Struct({
  host: Schema.String,
  login: Schema.String,
  token: Schema.String,
  /** gh's active account on its host: what a call without the board's private config acts as. */
  active: Schema.optional(Schema.Boolean),
})

/** A check on a pull request, as `gh pr checks --json` has it (`bucket`: pass, fail, pending, skipping). */
export const FakeCheck = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  bucket: Schema.String,
  workflow: Schema.optional(Schema.String),
  link: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  /** Its check run's id, which is its GitHub Actions job's (default 1000 + its index). */
  id: Schema.optional(Schema.Finite),
  /** How it ended, as GraphQL has it (CANCELLED, TIMED_OUT…), when `bucket` doesn't say enough. */
  conclusion: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  /** `status` for a commit status rather than a check run. */
  kind: Schema.optional(Schema.Literals(["check", "status"])),
  /** Its workflow run (check suite), for one with a `workflow`: default id 1, and completed unless it's pending. */
  suite: Schema.optional(Schema.Struct({ id: Schema.Finite, status: Schema.String })),
})

/** What a comment, review or review comment may say of itself: its id (default by its place), a bot's, its URL. */
const remarkFields = {
  id: Schema.optional(Schema.String),
  bot: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
}

export const FakeComment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.optional(Schema.String),
  authorAssociation: Schema.optional(Schema.String),
  ...remarkFields,
})

export type FakeComment = typeof FakeComment.Type

export const FakeReview = Schema.Struct({
  author: Schema.String,
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: Schema.String,
  body: Schema.optional(Schema.String),
  submittedAt: Schema.optional(Schema.String),
  authorAssociation: Schema.optional(Schema.String),
  ...remarkFields,
})

/** A review thread on a file, with its comments. */
export const FakeThread = Schema.Struct({
  path: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.String,
      body: Schema.String,
      createdAt: Schema.optional(Schema.String),
      authorAssociation: Schema.optional(Schema.String),
      line: Schema.optional(Schema.NullOr(Schema.Finite)),
      ...remarkFields,
    }),
  ),
})

/** A pull request. Left out: what the fake gives by default (mergeable, no checks, not in a stack…). */
export const FakePull = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  /** OPEN, CLOSED or MERGED. */
  state: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  head: Schema.String,
  base: Schema.String,
  headOid: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  /** MERGEABLE (default), CONFLICTING or UNKNOWN. */
  mergeable: Schema.optional(Schema.String),
  mergeStateStatus: Schema.optional(Schema.String),
  reviewDecision: Schema.optional(Schema.String),
  isCrossRepository: Schema.optional(Schema.Boolean),
  checks: Schema.optional(Schema.Array(FakeCheck)),
  comments: Schema.optional(Schema.Array(FakeComment)),
  reviews: Schema.optional(Schema.Array(FakeReview)),
  /** What `gh pr diff` prints. */
  diff: Schema.optional(Schema.String),
  /** The GitHub stack it is in (`repos.<r>.stacks`), if any: the legacy merge refuses it. */
  stack: Schema.optional(Schema.NullOr(Schema.Finite)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  /** How it was merged (merge, squash, rebase), once it was or will be. */
  mergeMethod: Schema.optional(Schema.String),
  /** `gh pr merge --auto` was asked for. */
  autoMerge: Schema.optional(Schema.Boolean),
  deletedBranch: Schema.optional(Schema.Boolean),
  /** How a merge-async of it goes: merged at once (default), pending until it is looked at again, or failed. */
  mergeAsync: Schema.optional(Schema.Literals(["merged", "pending", "failed"])),
  mergeAsyncPending: Schema.optional(Schema.Boolean),
  reviewThreads: Schema.optional(Schema.Array(FakeThread)),
  /** How many review threads a GraphQL read gets at a time (default 100, as GitHub's). */
  threadsPage: Schema.optional(Schema.Finite),
  /** A GraphQL read of it fails with this. */
  unreadable: Schema.optional(Schema.String),
  /** 4.8: the REST API's `mergeable_state` (default `dirty` for a CONFLICTING one, else `clean`). */
  mergeableState: Schema.optional(Schema.String),
  /**
   * 4.8: GitHub's own rebase of a stacked level: when the pull request below it in its stack is merged, GitHub retargets it
   * to where that went and its head becomes this commit (as GitHub force-pushes the rebased branch; the test pushes the
   * commit itself). Without it, the head stays (GitHub couldn't rebase it), and `mergeableState` says `dirty`.
   */
  rebasedTo: Schema.optional(Schema.String),
})
export type FakePull = typeof FakePull.Type

export const FakeIssue = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  state: Schema.String,
  author: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  comments: Schema.optional(Schema.Array(FakeComment)),
})

export const FakeRun = Schema.Struct({
  databaseId: Schema.Finite,
  workflowName: Schema.optional(Schema.String),
  displayTitle: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  /** What `gh run view --log-failed` prints. */
  log: Schema.optional(Schema.String),
})

export const FakeRepo = Schema.Struct({
  default_branch: Schema.optional(Schema.String),
  pulls: Schema.optional(Schema.Array(FakePull)),
  issues: Schema.optional(Schema.Array(FakeIssue)),
  runs: Schema.optional(Schema.Array(FakeRun)),
  /** GitHub stacks by number: their pull requests' numbers, bottom first. */
  stacks: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Finite))),
  /** What `gh run view --job <id> --log-failed` prints, by job id. */
  jobs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type FakeRepo = typeof FakeRepo.Type

/** An answer by a call's exact arguments (joined with spaces): its output, or `json` printed as JSON. */
export const FakeRoute = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Finite),
  json: Schema.optional(Schema.Unknown),
})

/** A call gh was given. */
export const FakeGhCall = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  /** The login it acted as: the token in the board's private config, else the host's active account. */
  as: Schema.NullOr(Schema.String),
  /** GH_HOST and GH_REPO as it had them. */
  host: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  /** A token was in its environment (GH_TOKEN and the like): the board never gives one. */
  envToken: Schema.Boolean,
  /** GH_CONFIG_DIR (the board's private config, for an account), and the modes of it and its hosts.yml. */
  configDir: Schema.NullOr(Schema.String),
  configModes: Schema.NullOr(Schema.Array(Schema.String)),
  /** DBUS_SESSION_BUS_ADDRESS: `disabled:` keeps gh out of the keyring on Linux. */
  dbus: Schema.NullOr(Schema.String),
})
export type FakeGhCall = typeof FakeGhCall.Type

export const FakeGitHubState = Schema.Struct({
  accounts: Schema.optional(Schema.Array(FakeAccount)),
  /** By `OWNER/REPO` (github.com) or `HOST/OWNER/REPO`. */
  repos: Schema.optional(Schema.Record(Schema.String, FakeRepo)),
  defaultRepo: Schema.optional(Schema.NullOr(Schema.String)),
  /** `gh <command> [sub] --help` by "command sub". */
  help: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  routes: Schema.optional(Schema.Record(Schema.String, FakeRoute)),
  calls: Schema.optional(Schema.Array(FakeGhCall)),
})
export type FakeGitHubState = typeof FakeGitHubState.Type

/** bin/fake-gh, which reads the state named by `$HUNTAWAY_FAKE_GH_STATE`. */
export const FAKE_GH = `${REPO_ROOT}packages/testing/bin/fake-gh`

/** A pull request with what a test doesn't say filled in: open, `head` into main. */
export const fakePull = (pull: Partial<FakePull> & { readonly number: number; readonly head: string }): FakePull => ({
  title: `PR ${pull.number}`,
  body: "",
  state: "OPEN",
  base: "main",
  ...pull,
})

export interface FakeGitHub {
  /** The `gh` to give the server (`ServerConfig.ghBin`): a script that runs bin/fake-gh over this state. */
  readonly bin: string
  /** The state's file. */
  readonly path: string
  readonly state: Effect.Effect<FakeGitHubState>
  /** Change the state (between calls). */
  readonly update: (f: (state: FakeGitHubState) => FakeGitHubState) => Effect.Effect<void>
  /** Every call gh was given, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<FakeGhCall>>
  /** A repository's pull request as it is now. */
  readonly pull: (repo: string, number: number) => Effect.Effect<FakePull | undefined>
}

const StateJson = Schema.fromJsonString(FakeGitHubState)

/** A fake GitHub in a temp folder for the scope, starting from `initial`. */
export const fakeGitHub = (initial: FakeGitHubState = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* tempDir
    const path = `${dir}/github.json`
    const bin = `${dir}/gh`
    const write = (state: FakeGitHubState) => Schema.encodeEffect(StateJson)(state).pipe(Effect.flatMap((text) => fs.writeFileString(path, text)))
    yield* write(initial)
    yield* fs.writeFileString(bin, `#!/bin/sh\nHUNTAWAY_FAKE_GH_STATE='${path}' exec '${FAKE_GH}' "$@"\n`)
    yield* fs.chmod(bin, 0o755)
    const state = fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeEffect(StateJson)), Effect.orDie)
    const fake: FakeGitHub = {
      bin,
      path,
      state,
      update: (f) => Effect.flatMap(state, (s) => write(f(s))).pipe(Effect.orDie),
      calls: Effect.map(state, (s) => s.calls ?? []),
      pull: (repo, number) => Effect.map(state, (s) => s.repos?.[repo]?.pulls?.find((p) => p.number === number)),
    }
    return fake
  }).pipe(Effect.orDie)
