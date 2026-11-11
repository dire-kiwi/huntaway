import { assert, describe, it } from "@effect/vitest"
import { combine, decideSend, isCompact, newCommand } from "./queue.ts"
import type { SendFacts } from "./queue.ts"

// What happens to a message (huntaway's runner/send.ts and queue.ts), as plain functions: the decisions the service
// tests (Runs.test.ts) then see carried out.

const facts = (over: Partial<SendFacts> = {}): SendFacts => ({
  task: { kind: "task", merging: false, merge_approval: null, session_id: "s1", queued_message: null },
  message: { text: "go", source: "user" },
  plan: false,
  project: null,
  activeMerge: null,
  live: null,
  agents: true,
  unmet: [],
  ...over,
})

const live = { kind: "prompt", phase: "running", acceptsInput: true, writesDocuments: false } as const

describe("decideSend", () => {
  it("starts a run, taking what is queued ahead of the message", () => {
    assert.deepStrictEqual(decideSend(facts()), { _tag: "Start", kind: "prompt", take: "Ahead" })
    // What is queued, alone.
    assert.deepStrictEqual(decideSend(facts({ message: null, task: { ...facts().task, queued_message: "later" } })), {
      _tag: "Start",
      kind: "prompt",
      take: "Only",
    })
    // The board's own message takes nothing.
    assert.deepStrictEqual(decideSend(facts({ message: { text: "go", source: "board", auto: true } })), { _tag: "Start", kind: "prompt", take: "No" })
    // A review round.
    assert.deepStrictEqual(decideSend(facts({ message: { text: "review", source: "board", auto: true, review: true } })), {
      _tag: "Start",
      kind: "review",
      take: "No",
    })
  })

  it("steers into a live run that takes input, or one being prepared, and queues for one that can't", () => {
    assert.deepStrictEqual(decideSend(facts({ live })), { _tag: "Steer" })
    assert.deepStrictEqual(decideSend(facts({ live: { ...live, phase: "preparing", acceptsInput: false } })), { _tag: "Steer" })
    // Started by an older build, whose agents read only their prompt, or a compaction.
    assert.deepStrictEqual(decideSend(facts({ live: { ...live, acceptsInput: false } })), { _tag: "Queue" })
    assert.deepStrictEqual(decideSend(facts({ live: { ...live, kind: "compact" } })), { _tag: "Queue" })
    // `/compact` can't go into a turn; `/plan` only into a run that can write the plan.
    assert.deepStrictEqual(decideSend(facts({ live, message: { text: "/compact", source: "user" } })), { _tag: "Queue" })
    assert.deepStrictEqual(decideSend(facts({ live, plan: true, message: { text: "/plan it", source: "user" } })), { _tag: "Queue" })
    assert.deepStrictEqual(decideSend(facts({ live: { ...live, writesDocuments: true }, plan: true, message: { text: "/plan it", source: "user" } })), {
      _tag: "Steer",
    })
    // An empty message has nothing to send.
    assert.deepStrictEqual(decideSend(facts({ live, message: { text: "  ", source: "user" } })), { _tag: "Nothing" })
    // The board's own message never joins a run: it is refused while one goes.
    assert.deepStrictEqual(decideSend(facts({ live, message: { text: "go", source: "board", auto: true } })), {
      _tag: "Refuse",
      refusal: { _tag: "AlreadyRunning" },
    })
  })

  it("waits for dependencies, but not for a compaction, a merging task, the board's own message or a host without agents", () => {
    const unmet = ["WEB-1"]
    assert.deepStrictEqual(decideSend(facts({ unmet })), { _tag: "WaitForDependencies", unmet })
    assert.deepStrictEqual(decideSend(facts({ unmet, message: { text: "/compact", source: "user" } })), { _tag: "Start", kind: "compact", take: "No" })
    assert.deepStrictEqual(decideSend(facts({ unmet, task: { ...facts().task, merging: true } })), { _tag: "Start", kind: "prompt", take: "Ahead" })
    assert.deepStrictEqual(decideSend(facts({ unmet, message: { text: "go", source: "board", auto: true } })), { _tag: "Start", kind: "prompt", take: "No" })
    assert.deepStrictEqual(decideSend(facts({ unmet, agents: false })), { _tag: "Refuse", refusal: { _tag: "NoAgents" } })
  })

  it("refuses an archived project's thread, a queued merge's, and /compact with no conversation", () => {
    assert.deepStrictEqual(decideSend(facts({ project: { name: "Old", archived: true }, live })), {
      _tag: "Refuse",
      refusal: { _tag: "Archived", project: "Old" },
    })
    const merging = { ...facts().task, merging: true }
    assert.deepStrictEqual(decideSend(facts({ task: merging, activeMerge: { title: "Other" } })), {
      _tag: "Refuse",
      refusal: { _tag: "MergeQueued", after: "Other" },
    })
    // One waiting for the user's approval isn't in the queue yet, so it can be talked to.
    assert.deepStrictEqual(decideSend(facts({ task: { ...merging, merge_approval: "pending" }, activeMerge: { title: "Other" } })), {
      _tag: "Start",
      kind: "prompt",
      take: "Ahead",
    })
    assert.deepStrictEqual(decideSend(facts({ task: { ...facts().task, session_id: null }, message: { text: "/compact", source: "user" } })), {
      _tag: "Refuse",
      refusal: { _tag: "NoConversation" },
    })
    // What is queued may be a `/compact`, queued for after the run it came in.
    assert.deepStrictEqual(decideSend(facts({ message: null, task: { ...facts().task, queued_message: "/compact" } })), {
      _tag: "Start",
      kind: "compact",
      take: "Only",
    })
  })
})

describe("the queue", () => {
  it("joins queued messages with a blank line; from other agents only if all of them are", () => {
    const q = combine([
      { text: "first", source: "user", automation_run_id: null },
      { text: "second", source: "agent", automation_run_id: null },
      { text: "third", source: "user", automation_run_id: null },
    ])
    assert.deepStrictEqual(q, { text: "first\n\nsecond\n\nthird", fromAgent: false, userText: "first\n\nthird", routine: false, automationRuns: [] })
    assert.deepStrictEqual(
      combine([
        { text: "a", source: "agent", automation_run_id: null },
        { text: "", source: "automation", automation_run_id: "ar1" },
        { text: "b", source: "routine", automation_run_id: "ar2" },
      ]),
      { text: "a\n\nb", fromAgent: false, userText: "", routine: false, automationRuns: ["ar1", "ar2"] },
    )
    assert.deepStrictEqual(combine([{ text: "daily", source: "routine", automation_run_id: "ar" }]), {
      text: "daily",
      fromAgent: true,
      userText: null,
      routine: true,
      automationRuns: ["ar"],
    })
  })

  it("knows the board's commands, and not what only starts the same way", () => {
    assert.deepStrictEqual([isCompact("/compact"), isCompact(" /compact keep notes"), isCompact("/compactly")], [true, true, false])
    assert.deepStrictEqual([newCommand("/new"), newCommand("/new  fix it "), newCommand("/newer")], ["", "fix it", null])
  })
})
