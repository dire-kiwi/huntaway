import { describe, expect, it } from "@effect/vitest"
import { completionAt, findTokens, insertCompletion, lastValue, resolveTokens, STYLE_PREFIX, stripTokens } from "../../src/components/layout/taskTokens"

// HE-124: the new task dialog's `/output-style <name>`, one token, beside the other `/` words.

const vocab = { "/": ["plan", "scratch"], [STYLE_PREFIX]: ["default", "Explanatory", "Concise"] }

describe("/output-style in a new task's description", () => {
  it("is one token, the name its value in Claude Code's spelling", () => {
    const text = "Fix the login /output-style explanatory /plan"
    const tokens = resolveTokens(findTokens(text), vocab)
    expect(tokens.map((t) => [t.prefix, t.word, t.value])).toEqual([
      [STYLE_PREFIX, "explanatory", "Explanatory"],
      ["/", "plan", "plan"],
    ])
    expect(lastValue(tokens, STYLE_PREFIX)).toBe("Explanatory")
    expect(lastValue(tokens, "/")).toBe("plan")
    expect(stripTokens(text, tokens)).toBe("Fix the login")
  })

  it("is no style without a name on its line, nor in code", () => {
    expect(findTokens("/output-style\nConcise").map((t) => [t.prefix, t.word])).toEqual([["/", "output-style"]])
    expect(findTokens("`/output-style Concise`")).toEqual([])
  })

  it("lists the styles once the command is typed, and puts the one picked in", () => {
    const text = "Do it /output-style Con"
    const at = completionAt(text, text.length)
    expect(at).toEqual({ prefix: STYLE_PREFIX, query: "Con", start: 6, end: text.length })
    expect(at && insertCompletion(text, at, STYLE_PREFIX, "Concise")).toEqual({ text: "Do it /output-style Concise ", caret: 28 })
    // `/output-style` itself is a `/` word, which once picked opens the styles' list.
    expect(completionAt("/output", 7)).toEqual({ prefix: "/", query: "output", start: 0, end: 7 })
    expect(completionAt("/output-style ", 14)).toEqual({ prefix: STYLE_PREFIX, query: "", start: 0, end: 14 })
  })
})
