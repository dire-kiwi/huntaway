import { assert, describe, it } from "@effect/vitest"
import { RunId } from "@huntaway/contracts"
import type { Steer } from "@huntaway/contracts"
import { AGENT_CHARS, beginRefresh, clean, endRefresh, MESSAGE_CHARS, MESSAGES, newTitle, noRefreshes, refreshInput, worthAsking } from "./text.ts"
import type { RefreshTask } from "./text.ts"

// The old title.test.ts's cases on what the model is sent and what of its reply is a title. The placeholder's cases
// are tasks/decide.test.ts's (`placeholderTitle`, which task creation uses).

const count = (s: string, w: string) => s.split(w).length - 1

const steer = (text: string, from_agent: boolean): Steer => ({ id: text, text, from_agent, run_id: RunId.make("r"), written: true })

describe("titles' text", () => {
  it("refresh_input_has_the_users_messages_with_what_the_agent_asked", () => {
    let task: RefreshTask = {
      title: "Fix login",
      description: "The login page 500s",
      steering: [steer("and the logout page", false), steer("from another agent", true)],
      queued_user_text: "then deploy it",
    }
    const question = `${"x".repeat(400)}Should I fix the session too?`
    const replies: ReadonlyArray<readonly [string | null, string]> = [
      [null, "Use the new API"],
      [question, "Yes"],
    ]
    assert.strictEqual(
      refreshInput(task, replies, "Merged. What next?", 0),
      `<title>Fix login</title>\n\n<task>\nThe login page 500s\n</task>\n\n<message>\nUse the new API\n</message>\n\n<message>\n<agent>…${"x".repeat(AGENT_CHARS - 29)}Should I fix the session too?</agent>\nYes\n</message>\n\n<message>\n<agent>Merged. What next?</agent>\nand the logout page\n</message>\n\n<message>\nthen deploy it\n</message>\n`,
    )
    // Only the latest messages go, each cut short.
    const many = Array.from({ length: MESSAGES + 5 }, (_, i) => [null, `${i}${"y".repeat(MESSAGE_CHARS)}`] as const)
    task = { ...task, steering: [], queued_user_text: null }
    const input = refreshInput(task, many, null, 0)
    assert.strictEqual(refreshInput(task, many.slice(5), null, 5), input)
    assert.isTrue(input.includes("(5 earlier messages left out)") && !input.includes("\n4y") && input.includes("\n5y"), input)
    assert.isTrue(input.includes(`\n34${"y".repeat(MESSAGE_CHARS - 2)}…\n</message>`), input)
  })

  it("replies_keep_the_title_or_give_a_short_one", () => {
    assert.strictEqual(newTitle("Add a logout button", "Fix login"), "Add a logout button")
    assert.strictEqual(newTitle(clean("KEEP"), "Fix login"), null)
    assert.strictEqual(newTitle(clean("Keep."), "Fix login"), null)
    assert.strictEqual(newTitle(clean("`KEEP`"), "Fix login"), null)
    assert.strictEqual(newTitle("", "Fix login"), null)
    assert.strictEqual(newTitle("Agent-controlled project settings with approval gate, no delete and a sturdier update", "Fix login"), null)
  })

  it("a_sentence_saying_to_keep_the_title_keeps_it", () => {
    // HA-196: Codex answered with a sentence instead of KEEP, and the task was renamed to it.
    assert.strictEqual(clean("Keep the task title “Say hello”"), "Keep the task title “Say hello")
    assert.strictEqual(newTitle(clean("Keep the task title “Say hello”."), "Say hello"), null)
    assert.strictEqual(newTitle(clean("Keep the task title “Say hello”"), "Say hello"), null)
    for (const r of [
      "KEEP: the title still fits",
      "KEEP — nothing changed",
      "Keep the current title",
      "Keep the task's title unchanged",
      "Keep it as is",
      "Keep “Say hello”",
      "Keep the title as “Say hello”",
      "Keep the existing title 'Say hello' unchanged",
      "The title still fits",
      "The current title is fine",
      "No change",
      "Keep “Say hello” as the title",
      "Keep the title unchanged: “Say hello”",
      "Keep the title as is: Say hello",
      "The title “Say hello” still fits",
      "Keep as is",
      "Keep unchanged",
      "Keep — nothing changed",
      "Title unchanged",
      "Unchanged",
      "No changes",
      "No changes needed",
      "No title change",
    ])
      assert.strictEqual(newTitle(clean(r), "Say hello"), null, r)
    // A title that starts with "Keep" is still a title, even one that mentions a title or the task's current one.
    for (const [r, current] of [
      ["Keep sessions alive after logout", "Fix login"],
      ["Keep the title bar visible on scroll", "Fix the header"],
      ["Keep the task title in sync with the branch", "Rename branches"],
      ["Keep dark mode in sync across tabs", "Dark mode"],
      ["Keep it simple", "Fix login"],
      ["Keeper of the logs", "Fix login"],
      ["Keep the task list sorted", "Say hello"],
      ["Say hello in French", "Say hello"],
    ] as const)
      assert.strictEqual(newTitle(clean(r), current), r)
  })

  it("links_and_attachments_alone_dont_ask_for_a_title", () => {
    assert.isFalse(worthAsking("  https://example.com/shot.png\n"))
    assert.isFalse(worthAsking("Attached files:\n- /data/attachments/0123/shot.png"))
    assert.isFalse(worthAsking(""))
    assert.isTrue(worthAsking("see https://example.com/shot.png"))
    assert.isTrue(worthAsking("Make it blue\n\nAttached files:\n- /data/attachments/0123/shot.png"))
  })

  it("a_refresh_that_ends_late_isnt_taken_for_a_later_one", () => {
    // A is slow; B, asked after it, ends first; then C is asked, and A ends before C.
    let s = noRefreshes
    let a: number, b: number, c: number, latest: boolean
    ;[a, s] = beginRefresh(s, "t")
    ;[b, s] = beginRefresh(s, "t")
    ;[latest, s] = endRefresh(s, "t", b)
    assert.isTrue(latest)
    ;[c, s] = beginRefresh(s, "t")
    ;[latest, s] = endRefresh(s, "t", a)
    assert.isFalse(latest, "A is out of date")
    ;[latest, s] = endRefresh(s, "t", c)
    assert.isTrue(latest, "C is the latest")
    ;[latest, s] = endRefresh(s, "t", c)
    assert.isFalse(latest)
  })

  it("a_message_sent_again_goes_once", () => {
    let task: RefreshTask = { title: "Fix login", description: "", steering: [], queued_user_text: "wrong browser " }
    let input = refreshInput(task, [[null, "wrong browser"]], null, 0)
    assert.strictEqual(count(input, "wrong browser"), 1, input)
    input = refreshInput(
      task,
      [
        [null, "wrong browser"],
        [null, "wrong browser"],
      ],
      null,
      0,
    )
    assert.strictEqual(count(input, "wrong browser"), 1, input)

    // The same words answering a different question are a different message, whether the agent has taken them in yet
    // or not.
    const replies: ReadonlyArray<readonly [string | null, string]> = [
      ["A: add a cache; B: add search", "Use option B"],
      ["A: keep the index; B: replace it", "Use option B"],
    ]
    task = { ...task, queued_user_text: null }
    input = refreshInput(task, replies, null, 0)
    assert.isTrue(count(input, "Use option B") === 2 && input.includes("<agent>A: keep the index; B: replace it</agent>\nUse option B"), input)
    task = { ...task, queued_user_text: "Use option B" }
    input = refreshInput(task, replies.slice(0, 1), "A: keep the index; B: replace it", 0)
    assert.isTrue(count(input, "Use option B") === 2 && input.includes("<agent>A: keep the index; B: replace it</agent>\nUse option B"), input)
  })

  it("clean_strips_decoration", () => {
    assert.strictEqual(clean('"Generate task titles with Haiku."\n'), "Generate task titles with Haiku")
    assert.strictEqual(clean("Title: **Add login**"), "Add login")
    assert.strictEqual(clean("Wire the flow to call `claude -p` for the title."), "Wire the flow to call `claude -p` for the title")
  })
})
