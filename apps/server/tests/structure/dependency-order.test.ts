import { describe, expect, it } from "vite-plus/test"
import { imports, isTest, listFiles, parse, parseFailure, resolveImport } from "./sources.ts"

// docs/effect.md, Structural tests, rule 9: imports under apps/server/src follow the dependency order of
// docs/plan/06-server.md (Dependency order): an area imports the platform and the areas above it, never one below.
// Every relative import between two files under apps/server/src is checked, `import type` included (a type from
// below is a dependency on below). Tests are not: they compose areas freely. A folder that is not in the order fails,
// so a new area is placed in it here and on that page.
//
// Two folders the page does not list: `hooks/` (plain TypeScript that imports no area: below everything) and
// `prompts/` (the prompts as text: just after the platform).

const SRC = "apps/server/src/"

/** Top to bottom; a layer may import itself and the layers before it. */
const order: ReadonlyArray<ReadonlyArray<string>> = [
  ["hooks"],
  ["platform"],
  ["prompts"],
  ["settings"],
  ["profiles"],
  ["projects"],
  ["tasks"],
  ["threads"],
  ["git"],
  ["github"],
  ["agents"],
  ["runs"],
  ["permissions"],
  ["review"],
  ["merge"],
  ["workflows"],
  ["automations"],
  ["docs"],
  ["assistant"],
  ["mcp"],
  ["push"],
  ["hosts"],
  ["terminal"],
  ["desktop"],
  ["update"],
  ["analytics"],
  // The board's subscription, which reads every area (moved out of lifecycle/ in 9.1, so a read-only server serves it).
  ["board"],
  ["lifecycle"],
  // The transports.
  ["rpc", "http", "mcp/transport", "cli"],
  // The entry files.
  ["Main.ts", "ReadOnlyMain.ts", "bin.ts", "codex-run.ts"],
]

/** A file's place: its folder (`mcp/transport` before `mcp`) or, at the top of src, its name. */
const placeOf = (path: string): { readonly name: string; readonly rank: number } => {
  const inner = path.slice(SRC.length)
  const name = inner.startsWith("mcp/transport/") ? "mcp/transport" : (inner.split("/")[0] ?? inner)
  return { name, rank: order.findIndex((layer) => layer.includes(name)) }
}

const violations = (path: string): ReadonlyArray<string> => {
  const from = placeOf(path)
  if (from.rank === -1) return [`${path}:1: ${from.name} is not in the dependency order (docs/plan/06-server.md; add it there and here)`]
  return [
    ...parseFailure(parse(path)),
    ...imports(path).flatMap((imported) => {
      const target = resolveImport(path, imported.specifier)
      if (target === undefined || !target.startsWith(SRC)) return []
      const to = placeOf(target)
      if (to.rank === -1) return [`${path}:${imported.line}: imports ${imported.specifier}: ${to.name} is not in the dependency order`]
      if (to.rank > from.rank)
        return [`${path}:${imported.line}: ${from.name} imports ${imported.specifier}: ${to.name} is below ${from.name} in the dependency order`]
      return []
    }),
  ]
}

describe("dependency order", () => {
  it("an area imports the platform and the areas above it, never one below", () => {
    expect(
      listFiles("apps/server/src")
        .filter((path) => !isTest(path))
        .flatMap(violations),
    ).toEqual([])
  })
})
