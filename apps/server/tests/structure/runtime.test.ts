import { describe, expect, it } from "vite-plus/test"
import { imports, isTest, member, parse, parseFailure, sourceFiles, walk } from "./sources.ts"

// docs/effect.md, Structural tests, rule 1: nothing outside the entry points and packages/testing runs an Effect or
// makes a runtime (docs/plan/12-conventions.md, Services: no runtime inside a service). Reads apps/*/src and
// packages/*/src.

const isEntryPoint = (path: string) =>
  path === "apps/server/src/bin.ts" ||
  path === "apps/web/src/main.tsx" ||
  path.startsWith("apps/desktop/src/main/") ||
  path.startsWith("packages/testing/") ||
  isTest(path)

/** `Effect.runPromise`, `Effect.runForkWith`…, the same methods on a runtime made elsewhere, `ManagedRuntime.make`, `NodeRuntime.runMain`. */
const runsAnEffect = (object: string, property: string) =>
  (object === "Effect" && /^run[A-Z]/.test(property)) ||
  /^run(?:Promise|PromiseExit|Fork|Sync|SyncExit|Callback)$/.test(property) ||
  (object === "ManagedRuntime" && property === "make") ||
  (object.endsWith("Runtime") && property === "runMain")

/** The same, imported by name: `import { runPromise } from "effect/Effect"`. */
const importsARunner = (specifier: string, name: string) =>
  (specifier === "effect/Effect" && /^run[A-Z]/.test(name)) ||
  (specifier === "effect/ManagedRuntime" && name === "make") ||
  (specifier.endsWith("Runtime") && name === "runMain")

const violations = (path: string): ReadonlyArray<string> => {
  const parsed = parse(path)
  if (parsed.program === undefined) return parseFailure(parsed)
  const found: Array<string> = []
  walk(parsed.program, (node) => {
    const name = member(node)
    if (name !== undefined && runsAnEffect(...name)) found.push(`${path}:${parsed.line(node.start)}: ${name.join(".")} outside an entry point`)
    return true
  })
  for (const imported of imports(path)) {
    for (const name of imported.names.filter((candidate) => importsARunner(imported.specifier, candidate))) {
      found.push(`${path}:${imported.line}: imports ${name} from ${imported.specifier} outside an entry point`)
    }
  }
  return found
}

describe("runtimes", () => {
  it("only the entry points, packages/testing and tests run an Effect or make a runtime", () => {
    expect(
      sourceFiles()
        .filter((path) => !isEntryPoint(path))
        .flatMap(violations),
    ).toEqual([])
  })
})
