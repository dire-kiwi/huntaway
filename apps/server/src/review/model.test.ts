import { assert, describe, it } from "@effect/vitest"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Review, ReviewerRun } from "@huntaway/contracts"
import { LAST_MESSAGE_CHARS, REPLIES_CHARS, REPLY_CHARS, REPLY_CONTEXT_CHARS, review as reviewPrompt, userSaid } from "../prompts/review.ts"
import type { ReviewFacts, UserReplies } from "../prompts/review.ts"
import { summary as summaryPrompt } from "../prompts/summary.ts"
import type { SummaryFacts } from "../prompts/summary.ts"
import { Outcome } from "../runs/Run.ts"
import { changesCode } from "./changesCode.ts"
import {
  combine,
  decideExtend,
  decideIssues,
  endPart,
  label,
  mentionsMinor,
  reviewerEnd,
  stopReview,
  stopSummaries,
  submission,
  submitted,
  summaryEnd,
  variantKey,
  withParts,
} from "./model.ts"

// The pure part of review and summaries: the cases of huntaway's review/tests.test.ts, review/summary.test.ts and
// review/stats.test.ts that need no board, and git/changes/tests.test.ts's two tool-call cases (`changes_code`).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const LATER = Timestamp.make("2026-11-12T00:01:00.000Z")
const t = (n: number) => TaskId.make(`r${n}`)

/** A review in progress by `n` reviewers, labelled r0, r1…, with `over` written over it. */
const reviewing = (n: number, over: Partial<Review> = {}): Review =>
  Object.assign(
    {
      thread_id: t(0),
      state: "running" as const,
      head: "abc",
      summary: null,
      issues: [],
      fixes: 0,
      extra_rounds: 0,
      updated_at: AT,
      reviewers: Array.from({ length: n }, (_, i): ReviewerRun => ({ thread_id: t(i), label: `r${i}`, state: "running", summary: null, issues: [] })),
    },
    over,
  )

/** `r` with `over` written over it. */
const edited = (r: Review, over: Partial<Review>): Review => Object.assign({}, r, over)

/** Every part of a review of two in `state`, or the first `first` and the second `second`. */
const parts = (first: ReviewerRun["state"], second: ReviewerRun["state"]) =>
  reviewing(2).reviewers.map((p, i): ReviewerRun => Object.assign({}, p, { state: i === 0 ? first : second }))

/** `thread` submits `args`, then its run ends with `outcome`. */
const submitAndEnd = (
  r: Review,
  thread: TaskId,
  args: Parameters<typeof submission>[0] | null,
  outcome: Outcome = Outcome.ok,
  attention: string | null = null,
) => {
  const s = args === null ? r : submitted(r, thread, submission(args), AT)
  return endPart(s, thread, reviewerEnd(outcome, attention), LATER)
}

const at = (text: string) => (s: string) => {
  const i = text.indexOf(s)
  assert.isAtLeast(i, 0, `"${s}" not in ${text}`)
  return i
}

describe("combining reviewers' parts", () => {
  it("the review waits for every reviewer and combines their issues", () => {
    let r: Review | null = reviewing(3)
    r = submitAndEnd(r, t(0), { verdict: "pass", summary: "Looks good.", serious_issues: [] })
    assert.deepStrictEqual([r?.state, r?.reviewers[0]?.state], ["running", "passed"])
    r = submitAndEnd(r ?? reviewing(0), t(1), { verdict: "needs_fixes", summary: "One bug.", serious_issues: ["the bug"] })
    assert.strictEqual(r?.state, "running")
    // The last one fails: the issues the others found still count.
    r = submitAndEnd(r ?? reviewing(0), t(2), null, Outcome.failed("boom\nmore"))
    assert.strictEqual(r?.state, "issues")
    assert.deepStrictEqual(r?.issues, ["(r1) the bug"])
    assert.deepStrictEqual(
      r?.reviewers.map((p) => p.state),
      ["passed", "issues", "failed"],
    )
    assert.strictEqual(r?.reviewers[2]?.summary, "The review failed: boom")
    const summary = r?.summary ?? ""
    assert.isTrue(summary.includes("**r0:** Looks good.") && summary.includes("**r1:** One bug."), summary)
    assert.strictEqual(r?.updated_at, LATER)
    // A reviewer that has finished has no part in progress.
    assert.isNull(endPart(r, t(0), reviewerEnd(Outcome.ok, null), LATER))
  })

  it("a review passes when every reviewer passes, and a pass ends the rounds added to a cycle of fixes", () => {
    let r: Review | null = reviewing(2, { fixes: 3, extra_rounds: 2 })
    for (const i of [0, 1]) r = submitAndEnd(r ?? reviewing(0), t(i), { verdict: "pass", summary: "", serious_issues: [] })
    // So the next automatic review, which carries both on, gets the project's rounds.
    assert.deepStrictEqual([r?.state, r?.issues, r?.fixes, r?.extra_rounds], ["passed", [], 0, 0])
    assert.isNull(r?.summary)
  })

  it("a part ends as its run did: stopped, failed, asked, without a verdict", () => {
    const part: ReviewerRun = { thread_id: t(0), label: "", state: "running", summary: "s", issues: [], verdict: "pass" }
    assert.deepStrictEqual(reviewerEnd(Outcome.cancelled, null)(part), { state: "stopped", summary: "The review was stopped." })
    assert.deepStrictEqual(reviewerEnd(Outcome.ok, "Which one?")(part), { state: "failed", summary: "The reviewer asked: Which one?" })
    const { verdict: _verdict, ...none } = part
    assert.deepStrictEqual(reviewerEnd(Outcome.ok, null)(none), { state: "failed", summary: "The reviewer finished without submitting a verdict." })
    assert.deepStrictEqual(reviewerEnd(Outcome.ok, null)(Object.assign({}, part, { verdict: "issues" })), { state: "issues", summary: "s" })
    // All stopped is stopped; some failed is failed.
    assert.strictEqual(combine(reviewing(2, { reviewers: parts("stopped", "stopped") })).state, "stopped")
    assert.strictEqual(combine(reviewing(2, { reviewers: parts("stopped", "failed") })).state, "failed")
  })

  it("a review from before several reviewers still finishes", () => {
    const old = reviewing(0, { thread_id: t(7), verdict: "pass", summary: "Fine." })
    const split = withParts(old)
    assert.deepStrictEqual(split.reviewers, [{ thread_id: t(7), label: "", state: "running", summary: "Fine.", issues: [], verdict: "pass" }])
    const r = endPart(old, t(7), reviewerEnd(Outcome.ok, null), LATER)
    assert.deepStrictEqual([r?.state, r?.summary], ["passed", "Fine."])
  })

  it("superseding stops every reviewer still running", () => {
    const r = submitAndEnd(reviewing(2), t(0), { verdict: "pass", summary: "", serious_issues: [] })
    const stopped = stopReview(r, "Stopped by the user.", LATER)
    assert.deepStrictEqual(stopped?.running, [t(1)])
    assert.deepStrictEqual([stopped?.review.state, stopped?.review.summary], ["stopped", "Stopped by the user."])
    assert.deepStrictEqual(
      stopped?.review.reviewers.map((p) => p.state),
      ["passed", "stopped"],
    )
    // The stopped run ending doesn't change it, and there's nothing left to stop.
    assert.isNull(endPart(stopped?.review ?? null, t(1), reviewerEnd(Outcome.cancelled, null), LATER))
    assert.isNull(stopReview(stopped?.review ?? null, "again", LATER))
  })

  it("reviewers are labelled by config, model and effort", () => {
    assert.strictEqual(label("Codex", "gpt-5", "high"), "Codex · gpt-5 · high")
    assert.strictEqual(label(null, null, null), "Claude")
  })
})

describe("what a submission records", () => {
  it("counts issues as submit does", () => {
    assert.deepStrictEqual(submission({ verdict: "pass", serious_issues: [] }).issues, [])
    assert.deepStrictEqual(submission({ verdict: "needs_fixes", serious_issues: ["a", " ", "b "] }).issues, ["a", "b"])
    // A reviewer that wants fixes but didn't list them described them in its summary.
    assert.deepStrictEqual(submission({ verdict: "needs_fixes", summary: " A bug. ", serious_issues: [] }), {
      summary: "A bug.",
      verdict: "issues",
      issues: ["A bug."],
      minor: null,
    })
    assert.deepStrictEqual(submission({ verdict: "needs_fixes", serious_issues: [] }).issues, [
      "The reviewer asked for fixes without saying what they are; see the review thread.",
    ])
    assert.deepStrictEqual(submission({ verdict: "pass", serious_issues: [], minor_issues: ["x", ""] }).minor, ["x"])
  })

  it("tells summaries that mention minor issues", () => {
    assert.isTrue(mentionsMinor("One minor issue: the label is cut off."))
    assert.isTrue(mentionsMinor("Nits: rename `x`."))
    assert.isTrue(mentionsMinor("A few suggestions, none blocking."))
    assert.isFalse(mentionsMinor("No minor issues either."))
    assert.isFalse(mentionsMinor("I didn't find any minor problems or nits worth raising, nor any suggestions."))
    assert.isFalse(mentionsMinor("Everything checks out; tests pass."))
    assert.isFalse(mentionsMinor("Dominoes fell"))
  })
})

/** Why an extension was refused. */
const reason = (d: ReturnType<typeof decideExtend>) => (d._tag === "Refused" ? d.reason : null)

/** A review that found an issue after `fixes` rounds, with two extra. */
const found = (fixes: number): Review => reviewing(1, { state: "issues", issues: ["still"], fixes, extra_rounds: 2 })

describe("rounds of fixes", () => {
  const inReview = { status: "in_review" as const, running: false }

  it("the extra rounds of fixes count until they're used up", () => {
    // A round left: it goes to the agent.
    const sent = decideIssues(inReview, found(3), 2)
    assert.deepStrictEqual(sent._tag === "SendFixes" ? sent.review.fixes : null, 4)
    // None left: it's left for the user.
    assert.deepStrictEqual(decideIssues(inReview, found(4), 2), {
      _tag: "OutOfRounds",
      reason: "The review found 1 serious issue after 4 rounds of fixes",
    })
    assert.deepStrictEqual(decideIssues(inReview, edited(found(1), { extra_rounds: 0 }), 1), {
      _tag: "OutOfRounds",
      reason: "The review found 1 serious issue after a round of fixes",
    })
    // The user (or the agent) has moved on.
    assert.deepStrictEqual(decideIssues({ status: "in_progress", running: false }, found(0), 2), { _tag: "MovedOn" })
    assert.deepStrictEqual(decideIssues({ ...inReview, running: true }, found(0), 2), { _tag: "MovedOn" })
  })

  it("only a review with issues left after its rounds can be extended, by the project's rounds (at least one)", () => {
    const task = { status: "needs_attention" as const, merging: false, running: false }
    const out = edited(found(2), { extra_rounds: 0 })
    const extended = decideExtend({ ...task, review: out }, 2)
    assert.deepStrictEqual(extended._tag === "Extended" ? [extended.review.fixes, extended.review.extra_rounds, extended.more] : null, [3, 2, 2])
    const none = decideExtend({ ...task, review: edited(found(0), { extra_rounds: 0 }) }, 0)
    assert.deepStrictEqual(none._tag === "Extended" ? [none.review.fixes, none.review.extra_rounds] : null, [1, 1])
    assert.strictEqual(reason(decideExtend({ ...task, review: edited(out, { fixes: 1 }) }, 2)), "the task hasn't used up its rounds of fixes")
    assert.strictEqual(reason(decideExtend({ ...task, review: edited(out, { state: "passed" }) }, 2)), "the task's latest review didn't find issues to fix")
    assert.strictEqual(reason(decideExtend({ ...task, review: null }, 2)), "the task's latest review didn't find issues to fix")
    assert.strictEqual(reason(decideExtend({ ...task, running: true, review: out }, 2)), "the agent is working on the task; wait for it to finish or stop it")
    assert.strictEqual(reason(decideExtend({ ...task, merging: true, review: out }, 2)), "the task is done or merging; move it to another column first")
  })
})

describe("summaries", () => {
  it("a summary ends with what its summarizer wrote since it was asked", () => {
    assert.deepStrictEqual(summaryEnd(Outcome.ok, null, "  ## What changed\n\nA fix.  "), { state: "done", text: "## What changed\n\nA fix." })
    // A run that says nothing new doesn't pass off the last summary as its own.
    assert.strictEqual(summaryEnd(Outcome.ok, null, null).state, "failed")
    assert.deepStrictEqual(summaryEnd(Outcome.cancelled, null, "x"), { state: "stopped", text: "The summary was stopped." })
    assert.deepStrictEqual(summaryEnd(Outcome.failed("boom"), null, "x"), { state: "failed", text: "The summary failed: boom" })
    assert.deepStrictEqual(summaryEnd(Outcome.ok, "Which?", "x"), { state: "failed", text: "The summarizer asked: Which?" })
  })

  it("only the summaries being written are stopped", () => {
    const s = (id: number, state: "running" | "done") => ({ thread_id: t(id), label: "", state, head: "abc", text: null, updated_at: AT })
    const stopped = stopSummaries([s(0, "done"), s(1, "running")], "Stopped by the user.", LATER)
    assert.deepStrictEqual(
      stopped?.summaries.map((x) => [x.state, x.text]),
      [
        ["done", null],
        ["stopped", "Stopped by the user."],
      ],
    )
    assert.deepStrictEqual(stopped?.running, [t(1)])
    assert.isNull(stopSummaries(stopped?.summaries ?? [], "again", LATER))
  })

  it("a summarizer's thread is told apart by its name, prompt and skills", () => {
    assert.strictEqual(variantKey({ claude_config_id: null, model: "haiku", effort: null }), "")
    assert.strictEqual(
      variantKey({ claude_config_id: null, model: null, effort: null, name: " Skilled ", skills: ["tldr"], prompt: "Be brief." }),
      '{"name":"Skilled","prompt":"Be brief.","skills":["tldr"]}',
    )
  })
})

// ---- the prompts (huntaway's review/tests.test.ts and review/summary.test.ts prompt cases) ----

const NO_REPLIES: UserReplies = { replies: [], earlier: 0 }

const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  key: "X-1",
  title: "Fix it",
  description: "",
  pr_url: null,
  branch: "ia/x-1",
  base: "master",
  commit: "abc",
  work: { kind: "branch", own_start: false },
  fixed: [],
  replies: NO_REPLIES,
  instructions: "Check the docs too.",
  ...over,
})

describe("what a reviewer is asked", () => {
  it("the project's instructions go between where the work is and how to report", () => {
    const text = reviewPrompt(facts({ fixed: ["the bug"] }))
    const pos = at(text)
    assert.isTrue(pos("`pr_view` tool (pr `ia/x-1`)") < pos("Check the docs too.") && pos("Check the docs too.") < pos("call `submit_review` once"))
    assert.isTrue(pos("submit_review") < pos("- the bug"))
  })

  it("what the user decided goes before the instructions", () => {
    const replies: UserReplies = {
      replies: [
        ["Should it be A or B?\nB is faster.", "A, the gap is fine"],
        [null, "thanks"],
      ],
      earlier: 0,
    }
    const text = reviewPrompt(facts({ replies }))
    const pos = at(text)
    assert.isTrue(pos("`pr_view`") < pos("decisions they made there stand") && pos("decisions they made") < pos("Check the docs too."))
    assert.isTrue(pos("The agent:\n\n> Should it be A or B?\n> B is faster.\n\nThe user:\n\n> A, the gap is fine\n") < pos("The user:\n\n> thanks"))
    assert.isFalse(reviewPrompt(facts()).includes("decisions they made"))
  })

  it("what the user said is cut to the latest", () => {
    const long = "x".repeat(REPLY_CHARS + 10)
    const said = `${"y".repeat(REPLY_CONTEXT_CHARS)} the question?`
    let text = userSaid([[said, long]], false)
    assert.isTrue(text.includes(`> ${"x".repeat(REPLY_CHARS)} [...]\n`) && !text.includes(long))
    assert.isTrue(text.includes("> [...] y") && text.includes("the question?") && !text.includes("y".repeat(REPLY_CONTEXT_CHARS)))
    // The latest messages, as many as fit.
    const many = Array.from({ length: 20 }, (_, i) => [null, `message ${i} ${"z".repeat(REPLY_CHARS - 20)}`] as const)
    text = userSaid(many, false)
    assert.isTrue(text.length < REPLIES_CHARS + 1000 && text.includes("message 19") && !text.includes("message 0 "))
    const pos = at(text)
    assert.isTrue(pos("[Earlier messages left out.]") < pos("message 18") && pos("message 18") < pos("message 19"))
    assert.strictEqual(userSaid([], false), "")
    // Those the board didn't read are left out too.
    text = userSaid(many.slice(18), true)
    assert.isTrue(text.includes("[Earlier messages left out.]\n\nThe user:\n\n> message 18") && text.includes("message 19"), text)
    assert.isFalse(userSaid(many.slice(18), false).includes("left out"))
  })

  it("work done elsewhere is found from the agent's last message and pull request", () => {
    let text = reviewPrompt(
      facts({
        title: "Pin images",
        pr_url: "https://github.com/o/deploy/pull/4",
        work: { kind: "elsewhere", last_message: "Done in o/deploy#4.\nBoth images build." },
      }),
    )
    const pos = at(text)
    assert.isFalse(text.includes("ia/x-1`)"))
    assert.isTrue(pos("no commits of its own") < pos("https://github.com/o/deploy/pull/4") && pos("pull/4") < pos("`pr_diff` tools with its URL"))
    assert.isTrue(pos("> Done in o/deploy#4.\n> Both images build.") < pos("Check the docs too.") && pos("Check the docs too.") < pos("submit_review"))
    text = reviewPrompt(facts({ base: null, instructions: "", work: { kind: "elsewhere", last_message: "x".repeat(LAST_MESSAGE_CHARS + 10) } }))
    assert.isTrue(text.includes(`> ${"x".repeat(LAST_MESSAGE_CHARS)} [...]`))
  })
})

const summaryFacts = (over: Partial<SummaryFacts> = {}): SummaryFacts => ({
  key: "X-1",
  title: "Fix it",
  description: "",
  pr_url: null,
  review: "Looks good.",
  branch: "ia/x-1",
  base: "master",
  commit: "abc",
  elsewhere: false,
  own_start: false,
  last_message: null,
  prompt: null,
  skills: [],
  codex: false,
  ...over,
})

describe("what a summarizer is asked", () => {
  it("the prompt locates the work and asks for only the summary", () => {
    let text = summaryPrompt(summaryFacts())
    for (const want of [
      'task X-1: "Fix it"',
      "`pr_view` tool (pr `ia/x-1`)",
      "`git diff master...HEAD`",
      "> Looks good.",
      "end your turn with only the summary",
    ]) {
      assert.isTrue(text.includes(want), `"${want}" not in ${text}`)
    }
    text = summaryPrompt(summaryFacts({ elsewhere: true, last_message: "Done in o/deploy#4." }))
    assert.isTrue(text.includes("no commits of its own") && text.includes("> Done in o/deploy#4."), text)
    assert.isFalse(text.includes("skill"), text)
  })

  it("the prompt asks for a summarizer's skills and prompt", () => {
    const text = summaryPrompt(summaryFacts({ skills: ["tldr", "changelog"], prompt: "  Two bullets, no more.  " }))
    assert.isTrue(text.includes("these skills while you write the summary: `/tldr`, `/changelog` (invoke each with the `Skill` tool)"), text)
    // Its prompt is the board's instead of the default, and the board still asks for only the summary.
    assert.isTrue(text.includes("Write it as they ask:\n\nTwo bullets, no more.\n") && !text.includes("Write it in Markdown, briefly"), text)
    assert.isTrue(text.includes("end your turn with only the summary"), text)
    const codex = summaryPrompt(summaryFacts({ skills: ["tldr"], codex: true }))
    assert.isTrue(codex.includes("this skill while you write the summary: `$tldr`.") && codex.includes("Write it in Markdown, briefly"), codex)
  })
})

/** A tool call with a command. */
const call = (name: string, command = "") => ({ name, input: { command } })

describe("did the agent change code", () => {
  const ok = { type: "tool_result" as const, tool_use_id: "t", content: "", is_error: false }
  const failed = (content: string) => ({ ...ok, is_error: true, content })

  it("edits change code and reads don't", () => {
    assert.isTrue(changesCode(call("Edit"), ok))
    assert.isTrue(changesCode(call("ApplyPatch"), ok))
    assert.isFalse(changesCode({ name: "Read", input: { file_path: "a" } }, ok))
  })

  it("failed edits don't change code, but failed shell writes may have", () => {
    assert.isFalse(changesCode(call("ApplyPatch"), failed("The change was declined.")))
    assert.isFalse(changesCode(call("Edit"), failed("String to replace not found")))
    assert.isFalse(changesCode(call("Write"), null))
    const write = call("Bash", "sed -i 's/old/new/' /src/deploy/src/main.rs && false")
    assert.isTrue(changesCode(write, failed("(exit code 1)")))
    assert.isTrue(changesCode(write, null))
    assert.isFalse(changesCode(write, failed("The command was declined.")))
    assert.isFalse(changesCode(write, failed("The user denied this action.")))
    assert.isFalse(changesCode(call("Bash", "git log -3 > /tmp/log"), ok))
    assert.isTrue(changesCode(call("Bash", "git -C '../deploy repo' commit -am x"), ok))
  })
})
