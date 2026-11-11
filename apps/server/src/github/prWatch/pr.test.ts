import { assert, describe, it } from "@effect/vitest"
import { Duration, Result } from "effect"
import { approvedByReviews } from "../PullRequests.ts"
import { backoff, storedPr } from "../PrWatch.ts"
import { LOG_CHARS, LOG_LINE_CHARS, LOG_LINES, logTail } from "./failed.ts"
import { wakeEvents } from "./inReview.ts"
import { statesOf, statesQuery } from "./merged.ts"
import { BODY_MAX, compare, EVENTS, note, parsePr, QUERY, SEEN_MAX, seenNothing, summary, THREADS, trimmed } from "./pr.ts"
import type { Compared, Pr, Seen } from "./pr.ts"
import { parseTarget, targetLabel, targetOf } from "./target.ts"
import type { Target } from "./target.ts"

// The pull request watch's plain parts (the old mcp/pr_watch/tests.test.ts cases that need no board, review/merged.test.ts
// `builds_one_query_and_reads_its_answer`, and git/worktree/approval_tests.test.ts): targets, reading GitHub's answer,
// what is news to the agent, the ends of failed jobs' logs. `response` builds an answer as the old tests' did.

type Check = readonly [string, string, string, boolean]

/** Check runs (`[name, status, conclusion, required]`) of head `head`, as the answer has them. */
const checkNodes = (head: string, checks: ReadonlyArray<Check>): Array<Record<string, unknown>> =>
  checks.map(([name, status, conclusion, required], i) => ({
    __typename: "CheckRun",
    databaseId: `${head}${i}`,
    name,
    status,
    conclusion: conclusion === "" ? null : conclusion,
    detailsUrl: `https://github.com/o/r/actions/runs/${i}`,
    isRequired: required,
  }))

/** Comments (`[id, author, body]`), as the answer has them. */
const commentNodes = (comments: ReadonlyArray<readonly [string, string, string]>): Array<Record<string, unknown>> =>
  comments.map(([id, author, body]) => ({
    id,
    author: { login: author },
    body,
    url: `https://github.com/o/r/pull/7#${id}`,
    createdAt: `2026-10-31T00:00:${id}Z`,
  }))

/** The answer's check contexts. */
const rollup = (nodes: ReadonlyArray<unknown>) => ({ nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] })

/**
 * A query's answer: pull request 7 in o/r, open and mergeable, with `checks` and `comments`, read as `viewer`; `over`
 * replaces fields of the pull request.
 */
const response = (
  viewer: string,
  head: string,
  checks: ReadonlyArray<Check>,
  comments: ReadonlyArray<readonly [string, string, string]>,
  over: Readonly<Record<string, unknown>> = {},
) => ({
  data: {
    viewer: { login: viewer },
    repository: {
      pullRequest: {
        url: "https://github.com/o/r/pull/7",
        number: 7,
        title: "A change",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefOid: head,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        commits: rollup(checkNodes(head, checks)),
        comments: { nodes: commentNodes(comments) },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
        ...over,
      },
    },
  },
})

const pr = (v: unknown): Pr => {
  const p = parsePr(v)
  return Result.isSuccess(p) ? p.success : assert.fail(p.failure)
}
const all = [...EVENTS]
const events = (c: Compared["news"]): ReadonlyArray<string> => c?.news.events ?? []
const seen = (o: Partial<Seen>): Seen => ({ ...seenNothing, ...o })
const target = (host: string, owner: string, name: string, number: number): Target => ({ host, owner, name, number })
const parsed = (given: string, def: readonly [string, string] | null) => {
  const t = parseTarget(given, def)
  return Result.isSuccess(t) ? t.success : assert.fail(t.failure)
}
/** Pull request 7 with `checks`, GitHub's `mergeable` set to `m`. */
const withMergeable = (m: string, checks: ReadonlyArray<Check> = []) => pr(response("me", "a1", checks, [], { mergeable: m }))

/** Pull request 7 with these check contexts. */
const withChecks = (nodes: ReadonlyArray<unknown>) => pr(response("me", "a1", [], [], { commits: rollup(nodes) }))

/** A job of the Tests workflow (check suite 5). */
const testsJob = (name: string, status: string, conclusion: string | null, suite: string) => ({
  __typename: "CheckRun",
  databaseId: name.length,
  name,
  status,
  conclusion,
  detailsUrl: null,
  isRequired: false,
  checkSuite: { databaseId: 5, status: suite, workflowRun: { workflow: { name: "Tests" } } },
})

/** A passed job of dire-kiwi/huntaway's Tests workflow. */
const passedJob = (id: number, name: string) => ({
  __typename: "CheckRun",
  databaseId: id,
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  detailsUrl: `https://github.com/dire-kiwi/huntaway/actions/runs/40975665970/job/${id}`,
  isRequired: false,
  checkSuite: { workflowRun: { workflow: { name: "Tests" } } },
})

/** A review by a member of the repository, unless `assoc` says otherwise. */
const review = (login: string, state: string, assoc = "MEMBER") => ({ author: { login }, state, authorAssociation: assoc })

/** `n` review threads with a comment each, `T<first>`… (each one later than the one before). */
const threads = (first: number, n: number) =>
  Array.from({ length: n }, (_, k) => {
    const i = first + k
    const t = `2026-10-31T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`
    return {
      path: "a.rs",
      comments: { nodes: [{ id: `T${i}`, author: { login: "carol" }, body: "x", url: "u", createdAt: t, path: "a.rs", line: i, originalLine: null }] },
    }
  })

describe("pull requests' targets", () => {
  it("takes a number, a repository and number, or a URL", () => {
    const repo = ["github.com", "o/r"] as const
    assert.deepStrictEqual(parsed("12", repo), target("github.com", "o", "r", 12))
    assert.deepStrictEqual(parsed(" #12 ", repo), target("github.com", "o", "r", 12))
    assert.deepStrictEqual(parsed("12.0", repo), target("github.com", "o", "r", 12))
    assert.deepStrictEqual(parsed("other/thing#3.00", repo), target("github.com", "other", "thing", 3))
    assert.deepStrictEqual(parsed("other/thing#3", repo), target("github.com", "other", "thing", 3))
    assert.deepStrictEqual(parsed("https://github.com/a/b/pull/9/files#diff-1", null), target("github.com", "a", "b", 9))
    assert.deepStrictEqual(parsed("https://www.github.com/a/b/pull/9", null), target("github.com", "a", "b", 9))
    assert.deepStrictEqual(parsed("5", ["acme.ghe.com", "o/r"]), target("acme.ghe.com", "o", "r", 5))
    assert.strictEqual(targetLabel(parsed("https://ACME.ghe.com/o/r/pull/5", null)), "acme.ghe.com/o/r#5")
    const none = parseTarget("12", null)
    assert.isTrue(Result.isFailure(none) && none.failure.includes("give its URL"))
    for (const bad of ["", "0", "0.0", "12.5", "12.", "1e3", "abc", "https://github.com/a/b/issues/9", "https://github.com/a/b/pull/x", "a/b/c#1", "o/r#"]) {
      assert.isTrue(Result.isFailure(parseTarget(bad, repo)), bad)
    }
    const w = storedPr({ target: target("acme.ghe.com", "o", "r", 5), events: all }, null)
    assert.deepStrictEqual([w.url, w.repo], ["https://acme.ghe.com/o/r/pull/5", "acme.ghe.com/o/r"])
    assert.deepStrictEqual(targetOf(w), target("acme.ghe.com", "o", "r", 5))
  })
})

describe("what's news to the agent", () => {
  it("a first wait reports how checks ended but not old comments", () => {
    const p = pr(
      response(
        "bot",
        "a1",
        [
          ["test", "COMPLETED", "FAILURE", false],
          ["lint", "COMPLETED", "SUCCESS", false],
        ],
        [["01", "alice", "old"]],
      ),
    )
    const c = compare(null, p, all)
    assert.deepStrictEqual(events(c.news), ["checks_failed"])
    assert.deepStrictEqual(c.quiet.remarks, ["01"])
    assert.strictEqual(c.news?.news.checks?.failed[0]?.name, "test")
    assert.strictEqual(c.news?.news.checks?.outcome, "failed")
    const told = c.news?.told ?? assert.fail("no news")
    assert.deepStrictEqual([told.head, told.failed.length], ["a1", 1])
    // Told, the same failure isn't news again.
    assert.isNull(compare(told, p, all).news)
    // Nor are checks that are still running.
    assert.isNull(compare(null, pr(response("bot", "a1", [["test", "IN_PROGRESS", "", false]], [])), all).news)
  })

  it("checks pass once per head, and required ones are enough", () => {
    const checks = (head: string) =>
      pr(
        response(
          "bot",
          head,
          [
            ["req", "COMPLETED", "SUCCESS", true],
            ["slow", "IN_PROGRESS", "", false],
          ],
          [],
        ),
      )
    const c = compare(seenNothing, checks("a1"), all)
    assert.deepStrictEqual(events(c.news), ["checks_passed"])
    assert.strictEqual(note(c.news?.news), "Pull request #7: all required checks passed (1 other still running) (see pull_request).")
    const told = c.news?.told ?? assert.fail("no news")
    assert.isNull(compare(told, checks("a1"), all).news)
    // A new commit's checks are news again.
    assert.deepStrictEqual(events(compare(told, checks("b2"), all).news), ["checks_passed"])
    // Without required checks, all of them have to pass.
    const p = pr(
      response(
        "bot",
        "a1",
        [
          ["a", "COMPLETED", "SUCCESS", false],
          ["b", "QUEUED", "", false],
        ],
        [],
      ),
    )
    assert.isNull(compare(seenNothing, p, all).news)
    // A re-run that fails again is news (a new run).
    const told2 = seen({ head: "a1", failed: ["run:a10"] })
    assert.isNull(compare(told2, pr(response("bot", "a1", [["x", "COMPLETED", "FAILURE", false]], [])), all).news)
    const rerun = [{ ...checkNodes("a1", [["x", "COMPLETED", "FAILURE", false]])[0], databaseId: 99 }]
    assert.deepStrictEqual(events(compare(told2, withChecks(rerun), all).news), ["checks_failed"])
  })

  it("others' comments and reviews are news, but not the agent's own", () => {
    const s0 = seen({ remarks: ["01"] })
    const reviews = [
      { id: "R1", author: { login: "carol" }, state: "CHANGES_REQUESTED", body: "", url: "u", submittedAt: "2026-10-31T00:01:00Z" },
      { id: "R2", author: { login: "carol" }, state: "COMMENTED", body: "", url: "u", submittedAt: "2026-10-31T00:01:00Z" },
      { id: "R3", author: { login: "me" }, state: "PENDING", body: "draft", url: "u", submittedAt: null },
    ]
    const reviewThreads = [
      {
        path: "src/a.rs",
        comments: {
          nodes: [
            {
              id: "T1",
              author: { login: "carol" },
              body: "Off by one",
              url: "u",
              createdAt: "2026-10-31T00:00:59Z",
              path: "src/a.rs",
              line: null,
              originalLine: 12,
            },
          ],
        },
      },
    ]
    const comments3 = [
      ["01", "alice", "old"],
      ["02", "me", "my reply"],
      ["03", "bob", "<!-- bot -->Please fix"],
    ] as const
    const v = response("me", "a1", [], comments3, { reviews: { nodes: reviews }, reviewThreads: { nodes: reviewThreads } })
    const c = compare(s0, pr(v), all)
    assert.deepStrictEqual(events(c.news), ["comments"])
    // Its own and a bare review are seen without being news.
    assert.deepStrictEqual(c.quiet.remarks, ["01", "02", "R2"])
    const comments = c.news?.news.comments ?? []
    assert.deepStrictEqual(
      comments.map((x) => [x.author, x.kind]),
      [
        ["bob", "comment"],
        ["carol", "review_comment"],
        ["carol", "review"],
      ],
    )
    assert.strictEqual(comments[0]?.body, "Please fix")
    assert.deepStrictEqual([comments[1]?.path, comments[1]?.line], ["src/a.rs", 12])
    assert.strictEqual(comments[2]?.review_state, "changes_requested")
    assert.strictEqual(note(c.news?.news), "Pull request #7: 3 new comments or reviews from bob, carol (see pull_request).")
    assert.deepStrictEqual(c.news?.told.remarks, ["01", "02", "R2", "03", "T1", "R1"])
    // Not wanted, it stays news for a later wait that wants it.
    const none = compare(s0, pr(response("me", "a1", [], [["03", "bob", "x"]])), ["conflicts"])
    assert.isTrue(none.news === null && !none.quiet.remarks.includes("03"))
  })

  it("a conflict is news once, until it clears", () => {
    const c = compare(null, withMergeable("CONFLICTING"), all)
    assert.deepStrictEqual(events(c.news), ["conflicts"])
    const told = c.news?.told ?? assert.fail("no news")
    assert.isTrue(told.conflicting)
    assert.isNull(compare(told, withMergeable("CONFLICTING"), all).news)
    // Unknown (after a push) keeps it; mergeable clears it, so a new conflict is news.
    assert.isTrue(compare(told, withMergeable("UNKNOWN"), all).quiet.conflicting)
    const { quiet } = compare(told, withMergeable("MERGEABLE"), all)
    assert.isFalse(quiet.conflicting)
    assert.deepStrictEqual(events(compare(quiet, withMergeable("CONFLICTING"), all).news), ["conflicts"])
  })

  it("a conflict ends a wait on checks that won't run (HA-287)", () => {
    const checks = ["checks_failed", "checks_passed"]
    const c = compare(seenNothing, withMergeable("CONFLICTING", []), checks, true)
    assert.deepStrictEqual(events(c.news), ["conflicts"])
    assert.strictEqual(note(c.news?.news), "Pull request #7: it conflicts with main (see pull_request).")
    // Not counted as told: the next wait on checks hears of it again, and so does one that wants conflicts.
    const told = c.news?.told ?? assert.fail("no news")
    assert.isTrue(!told.conflicting && !c.quiet.conflicting)
    assert.deepStrictEqual(events(compare(told, withMergeable("CONFLICTING", []), checks, true).news), ["conflicts"])
    assert.deepStrictEqual(events(compare(told, withMergeable("CONFLICTING", []), all, true).news), ["conflicts"])
    // Even after a wait that wanted conflicts was told of it.
    const wanted = compare(seenNothing, withMergeable("CONFLICTING", []), all, true).news?.told ?? assert.fail("no news")
    assert.isTrue(wanted.conflicting)
    assert.deepStrictEqual(events(compare(wanted, withMergeable("CONFLICTING", []), all, true).news), ["conflicts"])
    // Checks that are still running will end it themselves.
    assert.isNull(compare(seenNothing, withMergeable("CONFLICTING", [["test", "IN_PROGRESS", "", false]]), checks, true).news)
    // Unknown (after a push) and mergeable don't end it, nor does a conflict end a wait on comments alone.
    assert.isNull(compare(seenNothing, withMergeable("UNKNOWN", []), checks, true).news)
    assert.isNull(compare(seenNothing, withMergeable("MERGEABLE", []), checks, true).news)
    assert.isNull(compare(seenNothing, withMergeable("CONFLICTING", []), ["comments"], true).news)
    // Checks' news is reported as such.
    assert.deepStrictEqual(events(compare(seenNothing, withMergeable("CONFLICTING", [["test", "COMPLETED", "FAILURE", false]]), checks, true).news), [
      "checks_failed",
    ])
    // The in-review watcher (not a wait) doesn't wake the agent with a conflict it was told of on every read.
    assert.isNull(compare(wanted, withMergeable("CONFLICTING", []), wakeEvents("failures")).news)
  })

  it("merged or closed always ends it", () => {
    for (const [state, event] of [
      ["MERGED", "merged"],
      ["CLOSED", "closed"],
    ] as const) {
      const c = compare(seenNothing, pr(response("me", "a1", [], [], { state })), [])
      assert.deepStrictEqual(events(c.news), [event])
      assert.strictEqual(note(c.news?.news), `Pull request #7: it was ${event} (see pull_request).`)
    }
  })

  it("ids a read still sees stay seen", () => {
    // More ids seen than are kept, the oldest of which a read still sees (a busy pull request's first review threads):
    // those that go are ones it doesn't see.
    const p = pr(response("me", "a1", [], [], { reviewThreads: { nodes: threads(0, 100) } }))
    const remarks = [...Array.from({ length: 100 }, (_, i) => `T${i}`), ...Array.from({ length: SEEN_MAX }, (_, i) => `old${i}`)]
    const c = compare(seen({ remarks }), p, all)
    assert.isNull(c.news)
    assert.strictEqual(c.quiet.remarks.length, SEEN_MAX)
    for (let i = 0; i < 100; i++) assert.isTrue(c.quiet.remarks.includes(`T${i}`))
    assert.isTrue(!c.quiet.remarks.includes("old99") && c.quiet.remarks.includes("old100"))
    // Seen again, they still aren't news.
    assert.isNull(compare(c.quiet, p, all).news)
  })

  it("deleted users' comments are from someone", () => {
    const ghost = [{ ...commentNodes([["01", "ghost", "Hm"]])[0], author: null }]
    const v = response("me", "a1", [], [], { comments: { nodes: ghost } })
    assert.strictEqual(note(compare(seenNothing, pr(v), all).news?.news), "Pull request #7: 1 new comment or review from someone (see pull_request).")
    // With others', those are named.
    const v2 = response("me", "a1", [], [], { comments: { nodes: [...commentNodes([["02", "bob", "x"]]), ...ghost] } })
    assert.strictEqual(note(compare(seenNothing, pr(v2), all).news?.news), "Pull request #7: 2 new comments or reviews from bob (see pull_request).")
  })

  it("long comments and bots' metadata are trimmed", () => {
    assert.strictEqual(trimmed("<!-- a -->Hi<!-- b --> there <!-- unclosed"), "Hi there")
    assert.strictEqual(trimmed("é".repeat(BODY_MAX + 5)), `${"é".repeat(BODY_MAX)}… [5 more characters]`)
  })
})

describe("GitHub's answers", () => {
  it("reads GitHub's response", () => {
    // dire-kiwi/huntaway#2 as GitHub had it, with a commit status added.
    const v = {
      data: {
        viewer: { login: "imeredith" },
        repository: {
          pullRequest: {
            url: "https://github.com/dire-kiwi/huntaway/pull/2",
            number: 2,
            title: "One prompt, several agents",
            state: "MERGED",
            isDraft: false,
            baseRefName: "master",
            headRefOid: "efcf49d5e5b97253016fb1fb7775829dd6e38f71",
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
            reviewDecision: null,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          passedJob(123802950792, "server"),
                          passedJob(123802951119, "app"),
                          {
                            __typename: "StatusContext",
                            context: "Vercel",
                            state: "PENDING",
                            targetUrl: "https://vercel.com/x",
                            createdAt: "2026-10-30T20:00:00Z",
                            isRequired: false,
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
            comments: { nodes: [] },
            reviews: { nodes: [] },
            reviewThreads: { nodes: [] },
          },
        },
      },
    }
    const p = pr(v)
    assert.deepStrictEqual(
      p.checks.map((c) => [c.name, c.state, c.key, c.job]),
      [
        ["Tests / server", "Passed", "run:123802950792", 123802950792],
        ["Tests / app", "Passed", "run:123802951119", 123802951119],
        ["Vercel", "Pending", "status:Vercel:2026-10-30T20:00:00Z", null],
      ],
    )
    const s = summary(p)
    assert.deepStrictEqual([s.state, s.mergeable, s.checks.outcome], ["merged", "unknown", "pending"])
    assert.deepStrictEqual(s.checks.pending, ["Vercel"])
    assert.deepStrictEqual(events(compare(null, p, all).news), ["merged"])
  })

  // HA-393: a workflow's jobs that were skipped (its first job found nothing to test) count as passed, and a run whose
  // first job has passed while the others' checks aren't made yet isn't passed: its check suite hasn't ended.
  it("skipped jobs pass, and a run that hasn't ended is pending", () => {
    const run = testsJob
    const skipped = withChecks([
      run("tree", "COMPLETED", "SUCCESS", "COMPLETED"),
      run("server", "COMPLETED", "SKIPPED", "COMPLETED"),
      run("ui", "COMPLETED", "SKIPPED", "COMPLETED"),
    ])
    assert.deepStrictEqual(
      skipped.checks.map((c) => [c.name, c.state, c.conclusion]),
      [
        ["Tests / tree", "Passed", "success"],
        ["Tests / server", "Passed", "skipped"],
        ["Tests / ui", "Passed", "skipped"],
      ],
    )
    assert.strictEqual(summary(skipped).checks.outcome, "passed")
    assert.deepStrictEqual(events(compare(seenNothing, skipped, all).news), ["checks_passed"])
    // The first job passed, and the others' checks aren't there yet.
    const early = withChecks([run("tree", "COMPLETED", "SUCCESS", "IN_PROGRESS")])
    assert.deepStrictEqual(
      early.checks.map((c) => [c.name, c.state, c.key]),
      [
        ["Tests / tree", "Passed", "run:4"],
        ["Tests / jobs still to start", "Pending", "suite:5"],
      ],
    )
    assert.strictEqual(summary(early).checks.outcome, "pending")
    assert.deepStrictEqual(events(compare(seenNothing, early, all).news), [])
    // While one of its jobs is running, that job is what's pending.
    const going = withChecks([run("tree", "COMPLETED", "SUCCESS", "IN_PROGRESS"), run("server", "IN_PROGRESS", null, "IN_PROGRESS")])
    assert.deepStrictEqual(summary(going).checks.pending, ["Tests / server"])
    // A failed job is reported while the run goes on, as before.
    const failed = withChecks([run("tree", "COMPLETED", "SUCCESS", "IN_PROGRESS"), run("server", "COMPLETED", "FAILURE", "IN_PROGRESS")])
    assert.strictEqual(summary(failed).checks.outcome, "failed")
  })

  it("a missing pull request is an error", () => {
    const v = {
      data: { viewer: { login: "me" }, repository: null },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'o/r'." }],
    }
    assert.deepStrictEqual(parsePr(v), Result.fail("Could not resolve to a Repository with the name 'o/r'."))
    // Fields it isn't allowed to read don't make it one.
    const v2 = { ...response("me", "a1", [], []), errors: [{ message: "Resource not accessible by integration" }] }
    assert.isTrue(Result.isSuccess(parsePr(v2)))
  })

  it("reads bots' comments", () => {
    const v = response("me", "a1", [], [], {
      comments: {
        nodes: [
          { id: "01", author: { __typename: "Bot", login: "renovate" }, body: "x", createdAt: "2026-10-31T00:01:00Z" },
          { id: "02", author: { __typename: "User", login: "bob" }, body: "y", createdAt: "2026-10-31T00:02:00Z" },
        ],
      },
    })
    assert.deepStrictEqual(
      pr(v).remarks.map((r) => r.bot),
      [true, false],
    )
    assert.deepStrictEqual(wakeEvents("failures"), ["checks_failed", "conflicts"])
    assert.deepStrictEqual(wakeEvents("off"), [])
  })

  it("the queries are GraphQL GitHub takes", () => {
    // Their braces balance, and the cursor is only in the second.
    for (const q of [QUERY, THREADS]) {
      assert.strictEqual(q.split("{").length, q.split("}").length, q)
      assert.isTrue(q.includes("reviewThreads(first: 100") && q.includes("pageInfo { hasNextPage endCursor }"), q)
    }
    assert.isTrue(!QUERY.includes("$after") && THREADS.includes("after: $after"))
  })

  it("builds one query for many pull requests and reads its answer", () => {
    const q = statesQuery([target("github.com", "o", "r", 7), target("github.com", "o", "s", 8)])
    assert.isTrue(q.query.includes("pr0: repository(owner: $o0, name: $n0) { pullRequest(number: $p0) { state headRefOid"))
    assert.isTrue(q.query.includes("isRequired(pullRequestNumber: $p1)") && !q.query.includes("$number"))
    assert.strictEqual(q.query.split("{").length, q.query.split("}").length)
    assert.deepStrictEqual(q.vars, [
      ["o0", "o"],
      ["n0", "r"],
      ["o1", "o"],
      ["n1", "s"],
    ])
    assert.deepStrictEqual(q.numbers, [
      ["p0", 7],
      ["p1", 8],
    ])
    // One GitHub couldn't read is null, the others are read.
    const v = { data: { pr0: { pullRequest: { state: "MERGED", headRefOid: "a1" } }, pr1: { pullRequest: null } }, errors: [{ message: "gone" }] }
    const read = statesOf(v, 2)
    assert.deepStrictEqual(
      Result.map(read, (r) => r.map((x) => x?.state ?? null)),
      Result.succeed(["merged", null]),
    )
    assert.deepStrictEqual(statesOf({ errors: [{ message: "rate limited" }] }, 2), Result.fail("rate limited"))
  })
})

describe("failed checks' logs", () => {
  it("a failed job's log is cut to its end, without times, colours or groups", () => {
    const raw =
      "test\tSet up job\t2026-11-01T01:02:03.0000000Z \u{feff}Runner\n" +
      "test\tRun tests\t2026-11-01T01:02:04.1234567Z ##[group]Run cargo test\n" +
      "test\tRun tests\t2026-11-01T01:02:04.1234567Z cargo test\n" +
      "test\tRun tests\t2026-11-01T01:02:04.1234567Z ##[endgroup]\n" +
      "test\tRun tests\t2026-11-01T01:02:05.0000000Z \u{1b}[31mFAILED\u{1b}[0m a::b\n" +
      "test\tRun tests\t2026-11-01T01:02:06.0000000Z ##[error]Process completed with exit code 101.\n\n"
    assert.strictEqual(
      logTail(raw),
      "--- Set up job ---\nRunner\n--- Run tests ---\nRun cargo test\ncargo test\nFAILED a::b\n##[error]Process completed with exit code 101.",
    )
    // A long one keeps its last lines, under their step's heading.
    let long = ""
    for (let i = 0; i < 500; i++) long += `j\tBuild\t2026-11-01T01:02:03.0000000Z line ${i}\n`
    let tail = logTail(long)
    assert.isTrue(tail.startsWith(`[${500 - LOG_LINES} earlier lines left out]\n--- Build ---\nline ${500 - LOG_LINES}\n`), tail)
    assert.isTrue(tail.endsWith("line 499"))
    // And no more than LOG_CHARS of them, with long lines cut.
    let wide = ""
    for (let i = 0; i < 50; i++) wide += `j\tBuild\t${i}${"x".repeat(1000)}\n`
    tail = logTail(wide)
    assert.isTrue(new TextEncoder().encode(tail).length < LOG_CHARS + 100 && tail.endsWith("…"), String(tail.length))
    assert.isTrue(tail.split("\n").every((l) => Array.from(l).length <= LOG_LINE_CHARS + 1))
  })

  it("reads back off after failures", () => {
    const poll = 60_000
    assert.strictEqual(Duration.toMillis(backoff(1)), poll * 2)
    assert.strictEqual(Duration.toMillis(backoff(2)), poll * 4)
    assert.strictEqual(Duration.toMillis(backoff(9)), poll * 10)
  })
})

describe("approval on GitHub", () => {
  it("a reviewer's standing verdict survives their comments", () => {
    // GitHub's decision wins.
    assert.isTrue(approvedByReviews({ reviewDecision: "APPROVED", reviews: [] }))
    assert.isFalse(approvedByReviews({ reviewDecision: "CHANGES_REQUESTED", reviews: [review("a", "APPROVED")] }))
    assert.isFalse(approvedByReviews({ reviewDecision: "REVIEW_REQUIRED", reviews: [review("a", "APPROVED")] }))
    // Without one, each reviewer's latest verdict: a comment after an approval keeps it.
    assert.isTrue(approvedByReviews({ reviewDecision: "", reviews: [review("a", "APPROVED"), review("a", "COMMENTED")] }))
    // A change request standing blocks it, until the reviewer approves.
    assert.isFalse(approvedByReviews({ reviews: [review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")] }))
    assert.isTrue(approvedByReviews({ reviews: [review("b", "CHANGES_REQUESTED"), review("a", "APPROVED"), review("b", "APPROVED")] }))
    // A dismissal clears the verdict.
    assert.isFalse(approvedByReviews({ reviews: [review("a", "APPROVED"), review("a", "DISMISSED")] }))
    // An approval from someone with no say in the repository doesn't count.
    assert.isFalse(approvedByReviews({ reviews: [review("x", "APPROVED", "CONTRIBUTOR")] }))
    assert.isFalse(approvedByReviews({ reviewDecision: null, reviews: [review("a", "COMMENTED")] }))
    assert.isFalse(approvedByReviews({ reviews: [] }))
  })
})
