import { describe, expect, it } from "vite-plus/test"
import { exists, importGraph, parse, parseFailure } from "./sources.ts"

// docs/effect.md, Structural tests, rule 11: `ReadOnlyMain`'s import graph reaches nothing under `lifecycle/`
// (docs/plan/06-server.md, A read-only server). ReadOnlyMain.ts arrives with M9; until then there is nothing to walk
// and the test passes. The graph follows every import, `import type` included: a read-only server that names the
// Reactor's types is one edit from building it. "No loop's layer" is not checked here: a loop is a layer that forks,
// which an import graph cannot tell; the rehearsal test of docs/plan/11-migration.md holds that.

const ENTRY = "apps/server/src/ReadOnlyMain.ts"

describe("read-only server", () => {
  it(`ReadOnlyMain's import graph reaches nothing under lifecycle/${exists(ENTRY) ? "" : " (ReadOnlyMain.ts arrives in M9: nothing to walk)"}`, () => {
    const reached = exists(ENTRY) ? importGraph([ENTRY], () => true) : []
    expect(
      reached.flatMap(({ path, chain }) =>
        parseFailure(parse(path)).concat(path.startsWith("apps/server/src/lifecycle/") ? [`${path}:1: reached by ReadOnlyMain (${chain})`] : []),
      ),
    ).toEqual([])
  })
})
