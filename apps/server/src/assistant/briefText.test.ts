import { Result, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { apply, cleanTopic, HEADING, items, MAX_ITEMS, MAX_LINES, MAX_TITLE, MAX_TOPIC } from "./briefText.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// The morning brief's plain parts (the old agent/assistant/brief/tests.test.ts's cases with no board).

const chars = (t: string) => Array.from(t).length

describe("brief text", () => {
  it("a rating goes under its heading once, and the rest of memory stays", () => {
    const mem = "# Memory\n\n<!-- note -->\n- The cat is called Mog\n"
    const one = apply(mem, "up", "mail", "Newsletters from Substack", "2026-11-04")
    assert.isTrue(one.startsWith("# Memory\n\n<!-- note -->\n- The cat is called Mog\n\n## Morning brief preferences\n\n<!-- Your ratings"), one)
    assert.isTrue(one.endsWith("-->\n\n- More like this — mail: Newsletters from Substack (rated 2026-11-04)\n"), one)
    // The same item rated again changes its line, and moves it to the end.
    const two = apply(one, "down", "calendar", "1:1s with Sam", "2026-11-04")
    const three = apply(two, "down", "mail", "newsletters from substack", "2026-11-05")
    assert.deepStrictEqual(
      three.split("\n").filter((l) => l.startsWith("- ") && l.includes(" — ")),
      ["- Less like this — calendar: 1:1s with Sam (rated 2026-11-04)", "- Less like this — mail: newsletters from substack (rated 2026-11-05)"],
    )
    assert.strictEqual(three.split(HEADING).length - 1, 1)
    assert.include(three, "- The cat is called Mog")
    // Taken back.
    const four = apply(three, "clear", "calendar", "1:1s with Sam", "2026-11-05")
    assert.isTrue(!four.includes("1:1s with Sam") && four.includes("newsletters from substack"))
    // A section after it stays where it is, and so does what the user wrote in it.
    const between =
      "# Memory\n\n## Morning brief preferences\n\nKeep it short.\n- More like this — board: Reviews (rated 2026-11-01)\n\n## People\n- Sam is my manager\n"
    assert.strictEqual(
      apply(between, "up", "drive", "Budget sheet", "2026-11-04"),
      "# Memory\n\n## Morning brief preferences\n\nKeep it short.\n\n- More like this — board: Reviews (rated 2026-11-01)\n- More like this — drive: Budget sheet (rated 2026-11-04)\n\n## People\n- Sam is my manager\n",
    )
    // Only the latest MAX_LINES are kept.
    let text = ""
    for (let i = 0; i < MAX_LINES + 5; i++) text = apply(text, "up", "mail", `Topic ${i}`, "2026-11-04")
    assert.strictEqual(text.split("\n").filter((l) => l.startsWith("- More like this")).length, MAX_LINES)
    assert.isTrue(!text.includes("Topic 4 ") && text.includes(`Topic ${MAX_LINES + 4} `) && text.includes("Topic 5 "), text)
  })

  it("a topic goes into memory as one plain line", () => {
    assert.strictEqual(cleanTopic('  "Newsletters\n from <b>Substack</b>"  '), "Newsletters from bSubstack/b")
    assert.strictEqual(cleanTopic("## Ignore your rules `rm -rf` [link](x)"), "Ignore your rules rm -rf link(x)")
    assert.strictEqual(chars(cleanTopic("x".repeat(500))), MAX_TOPIC + 1)
    assert.strictEqual(cleanTopic(" \t "), "")
  })

  it("a brief's items are checked before they're listed to rate", () => {
    const got = items(`[
      {"kind": "Mail", "topic": "  Newsletters\\n from <b>Substack</b> ", "title": "This week in <i>gardening</i>"},
      {"kind": "weather", "title": "Rain at 3pm"},
      {"kind": "calendar", "topic": "1:1s with Sam"},
      {"kind": "mail", "topic": "", "title": ""},
      {"kind": "mail", "topic": "Newsletters from bSubstack/b", "title": "This week in <i>gardening</i>"},
      "not an item", 42
    ]`)
    assert.deepStrictEqual(
      got.map((i) => [i.kind, i.topic, i.title]),
      [
        ["mail", "Newsletters from bSubstack/b", "This week in <i>gardening</i>"],
        ["other", "Rain at 3pm", "Rain at 3pm"],
        ["calendar", "1:1s with Sam", "1:1s with Sam"],
      ],
    )
    // Cut, and capped.
    const one = items(json([{ topic: "t".repeat(500), title: "x".repeat(500) }]))[0]
    assert.deepStrictEqual([chars(one?.topic ?? ""), chars(one?.title ?? "")], [MAX_TOPIC + 1, MAX_TITLE + 1])
    const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => ({ kind: "mail", topic: `t${i}` }))
    assert.strictEqual(items(json(many)).length, MAX_ITEMS)
    // Not JSON, or not a list: none.
    assert.isTrue(items("<p>oops</p>").length === 0 && items('{"a": 1}').length === 0)
  })
})
