import { describe, expect, it } from "vite-plus/test"
import { child, children, importGraph, isFunction, isTest, listFiles, member, nameOf, parse, parseFailure, walk } from "./sources.ts"
import type { Node } from "./sources.ts"

// docs/effect.md, Structural tests, rule 11: `ReadOnlyMain`'s import graph reaches nothing under `lifecycle/` and names
// no loop's layer (docs/plan/06-server.md, A read-only server). The graph follows every import, `import type` included:
// a read-only server that names the Reactor's types is one edit from building it.
//
// A loop's layer cannot be told from an import (it is a static of a service's class, beside the service's own layer),
// so it is told from the sources: a `static readonly x = …` of a class under apps/server/src whose initialiser forks
// (`Effect.forkScoped`, `forkIn`, `forkDetach`, `forkChild`) as it is built,
// outside any function it only defines (a method's body forks when called, not when the layer is built). Every
// `Class.x` naming one, in a file of the graph other than the one that defines it, is a finding. What this cannot see:
// a loop started by a layer built by a function the graph calls under another name. The rehearsal's service test
// (src/ReadOnlyMain.test.ts) holds the rest: nothing it builds spawns or calls out.

const ENTRY = "apps/server/src/ReadOnlyMain.ts"

const FORKS = new Set(["forkScoped", "forkIn", "forkDetach", "forkChild"])

/** Whether `init` forks as it is evaluated: an `Effect.fork*` within at most one function (the layer's own generator). */
const forksWhenBuilt = (init: Node): boolean => {
  let found = false
  walk(init, (node, parents) => {
    if (found) return false
    const name = member(node)
    if (name !== undefined && name[0] === "Effect" && FORKS.has(name[1])) {
      const depth = [...parents, node].filter(isFunction).length
      if (depth <= 1) found = true
    }
    return true
  })
  return found
}

interface LoopLayer {
  readonly name: string
  readonly path: string
  readonly line: number
}

/** Every loop's layer under apps/server/src: `Class.static` whose initialiser forks as it is built. */
const loopLayers = (): ReadonlyArray<LoopLayer> =>
  listFiles("apps/server/src")
    .filter((path) => !isTest(path))
    .flatMap((path) => {
      const parsed = parse(path)
      const found: Array<LoopLayer> = []
      if (parsed.program === undefined) return found
      walk(parsed.program, (node) => {
        if (node.type !== "ClassDeclaration") return true
        const className = nameOf(child(node, "id"))
        const body = child(node, "body")
        if (className === undefined || body === undefined) return false
        for (const property of children(body, "body")) {
          const key = nameOf(child(property, "key"))
          const value = child(property, "value")
          if (property.type !== "PropertyDefinition" || property["static"] !== true || key === undefined || value === undefined) continue
          if (forksWhenBuilt(value)) found.push({ name: `${className}.${key}`, path, line: parsed.line(property.start) })
        }
        return false
      })
      return found
    })

describe("read-only server", () => {
  const reached = importGraph([ENTRY], () => true)

  it("ReadOnlyMain's import graph reaches nothing under lifecycle/", () => {
    expect(
      reached.flatMap(({ path, chain }) =>
        parseFailure(parse(path)).concat(path.startsWith("apps/server/src/lifecycle/") ? [`${path}:1: reached by ReadOnlyMain (${chain})`] : []),
      ),
    ).toEqual([])
  })

  it("the loops' layers are found (Attachments.pruner, Permissions.sweeper, Hubs' dial-in…), and not a service's own layer", () => {
    const names = new Set(loopLayers().map((l) => l.name))
    for (const loop of [
      "Attachments.pruner",
      "Threads.pruner",
      "Permissions.sweeper",
      "UsageWindow.loop",
      "Scheduler.loop",
      "Push.watcher",
      "Telemetry.exporter",
    ])
      expect(names).toContain(loop)
    for (const service of ["Tasks.layer", "Threads.layer", "Permissions.layer", "Proc.readOnly", "About.readOnly"]) expect(names).not.toContain(service)
  })

  it("ReadOnlyMain's graph names no loop's layer", () => {
    const loops = new Map(loopLayers().map((l) => [l.name, l]))
    expect(
      reached.flatMap(({ path, chain }) => {
        const parsed = parse(path)
        const found: Array<string> = []
        if (parsed.program === undefined) return found
        walk(parsed.program, (node) => {
          const name = member(node)
          const loop = name === undefined ? undefined : loops.get(`${name[0]}.${name[1]}`)
          if (loop !== undefined && loop.path !== path)
            found.push(`${path}:${parsed.line(node.start)}: names ${loop.name}, a loop's layer (${loop.path}:${loop.line}), reached by ReadOnlyMain (${chain})`)
          return true
        })
        return found
      }),
    ).toEqual([])
  })
})
