import { describe, expect, it } from "vite-plus/test"
import { importGraph, imports, isEffect, isNodeModule, isTest, listFiles, parse, parseFailure, resolveImport } from "./sources.ts"
import type { Import } from "./sources.ts"

// docs/effect.md, Structural tests, rule 6: the hook commands' import graphs do not reach `effect`. `approval-hook`,
// `gh-hook` and `gh-run` start per tool call and must start in tens of milliseconds, so they import only `node:`
// modules and `@huntaway/shared` (docs/plan/06-server.md, Hook commands). The entry files are
// apps/server/src/hooks/*.ts; the graph follows every import that loads something (`import type` is erased).

const entries = listFiles("apps/server/src/hooks").filter((path) => !isTest(path) && path.split("/").length === 5)

const loads = (_: string, imported: Import) => !imported.typeOnly

const refusal = (path: string, imported: Import): string | undefined => {
  if (isEffect(imported.specifier)) return "a hook does not load effect"
  if (isNodeModule(imported.specifier)) return undefined
  if (resolveImport(path, imported.specifier) === undefined) return "a hook imports only node: modules, @huntaway/shared and its own files"
  if (imported.specifier.startsWith("@huntaway/") && imported.specifier !== "@huntaway/shared") return "a hook imports only @huntaway/shared of the packages"
  return undefined
}

/** The graph stops at a refused import: it is reported once, not with everything behind it. */
const follow = (path: string, imported: Import) => loads(path, imported) && refusal(path, imported) === undefined

const violations = (): ReadonlyArray<string> =>
  importGraph(entries, follow).flatMap(({ path, chain }) =>
    parseFailure(parse(path)).concat(
      imports(path).flatMap((imported) => {
        const why = loads(path, imported) ? refusal(path, imported) : undefined
        return why === undefined ? [] : [`${path}:${imported.line}: imports ${imported.specifier} (${chain}): ${why}`]
      }),
    ),
  )

describe("hook commands", () => {
  it(`the hooks' import graphs do not reach effect${entries.length === 0 ? " (no hooks yet)" : ""}`, () => {
    expect(violations()).toEqual([])
  })
})
