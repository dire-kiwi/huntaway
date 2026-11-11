import { describe, expect, it } from "vite-plus/test"
import { allCode, child, children, isTest, member, nameOf, parse, parseFailure, walk } from "./sources.ts"
import type { Node } from "./sources.ts"

// docs/effect.md, Structural tests, rule 3: every call that takes a `concurrency` option passes it, `1` included.
// The default is sequential, the opposite of `Promise.all` (docs/plan/12-conventions.md, Concurrency and state).
// Reads every app's and package's sources and migrations (not tests).
//
// The functions are those of effect 4.1.4 whose options take `concurrency` and that run several effects at once:
// Effect's `all`, `forEach`, `validate`, `partition`, `filter`, `filterMapEffect` and `replicateEffect`; Stream's
// `mapEffect`, `flatMap`, `flatten` and `mergeAll`. (Stream's `tap`, `switchMap`, `groupBy`… also take one; add them
// here if their default bites.) The option is written inline, as an object literal after the first argument, so this
// test can see it; passed as a function value (`pipe(effects, Effect.all)`) it cannot be given, so that fails too.

const takesConcurrency: Readonly<Record<string, ReadonlySet<string>>> = {
  Effect: new Set(["all", "forEach", "validate", "partition", "filter", "filterMapEffect", "replicateEffect"]),
  Stream: new Set(["mapEffect", "flatMap", "flatten", "mergeAll"]),
}

const statesConcurrency = (call: Node) =>
  children(call, "arguments")
    .slice(1)
    .some(
      (argument) =>
        argument.type === "ObjectExpression" &&
        children(argument, "properties").some((property) => property.type === "Property" && nameOf(child(property, "key")) === "concurrency"),
    )

const violations = (path: string): ReadonlyArray<string> => {
  const parsed = parse(path)
  if (parsed.program === undefined) return parseFailure(parsed)
  const found: Array<string> = []
  walk(parsed.program, (node, parents) => {
    const name = member(node)
    if (name === undefined || takesConcurrency[name[0]]?.has(name[1]) !== true) return true
    const parent = parents.at(-1)
    const called = parent?.type === "CallExpression" && parent["callee"] === node
    if (!called) found.push(`${path}:${parsed.line(node.start)}: ${name.join(".")} passed as a value: call it with { concurrency }`)
    else if (!statesConcurrency(parent)) found.push(`${path}:${parsed.line(node.start)}: ${name.join(".")} without { concurrency }`)
    return true
  })
  return found
}

describe("concurrency", () => {
  it("every call that takes a concurrency option passes it", () => {
    expect(
      allCode()
        .filter((path) => !isTest(path))
        .flatMap(violations),
    ).toEqual([])
  })
})
