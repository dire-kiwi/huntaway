import { describe, expect, it } from "vite-plus/test"
import { allCode, child, isFunction, parse, parseFailure, walk } from "./sources.ts"

// docs/effect.md, Structural tests, rule 2: no `yield*` inside a `try` block. A failed Effect ends the generator; it is
// not thrown into it, so the `catch` never runs (docs/plan/12-conventions.md, Errors). Reads every app's and package's
// sources, tests and migrations. A `yield*` in a function nested in the block belongs to that function and is not
// counted; one in the `catch` or `finally` clause is not in the `try` block.

const violations = (path: string): ReadonlyArray<string> => {
  const parsed = parse(path)
  if (parsed.program === undefined) return parseFailure(parsed)
  const found = new Map<number, string>()
  walk(parsed.program, (node) => {
    const block = node.type === "TryStatement" ? child(node, "block") : undefined
    if (block === undefined) return true
    walk(block, (inner) => {
      if (inner.type === "YieldExpression" && inner["delegate"] === true) {
        found.set(inner.start, `${path}:${parsed.line(inner.start)}: yield* inside the try block at line ${parsed.line(node.start)}`)
      }
      return !isFunction(inner)
    })
    return true
  })
  return [...found.values()]
}

describe("try", () => {
  it("no yield* inside a try block", () => {
    expect(allCode().flatMap(violations)).toEqual([])
  })
})
