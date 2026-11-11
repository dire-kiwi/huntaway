import { describe, expect, it } from "vite-plus/test"
import { imports, isTest, listFiles, member, parse, parseFailure, resolveImport, walk } from "./sources.ts"
import type { Import } from "./sources.ts"

// docs/effect.md, Structural tests, rule 10: a repository (`*Repo.ts`, `*Store.ts`, files under a `store/` folder)
// imports no process, network or file-system module and does not sleep, so a transaction (database statements and
// pure code only, docs/plan/12-conventions.md, Concurrency and state) cannot contain a wait. Reads apps/server/src.

const isRepository = (path: string) => !isTest(path) && (/(?:Repo|Store)\.tsx?$/.test(path) || path.includes("/store/"))

/** Modules that do I/O: processes, sockets, HTTP, the file system. */
const ioModule =
  /^(?:effect\/(?:process|http|socket|FileSystem)|@effect\/platform-node|(?:node:)?(?:fs|fs\/promises|child_process|net|http|https|http2|dgram|tls))(?:\/|$)/

/** Services that do I/O, imported by name from the `effect` barrel or elsewhere. */
const ioServices = new Set(["FileSystem", "ChildProcess", "ChildProcessSpawner", "HttpClient", "Socket"])

const ioImport = (path: string, imported: Import): string | undefined => {
  if (ioModule.test(imported.specifier)) return imported.specifier
  const names = imported.names.filter((name) => ioServices.has(name))
  if (names.length > 0) return `${names.join(", ")} from ${imported.specifier}`
  if (resolveImport(path, imported.specifier) === "apps/server/src/platform/Proc.ts") return imported.specifier
  return undefined
}

const violations = (path: string): ReadonlyArray<string> => {
  const parsed = parse(path)
  if (parsed.program === undefined) return parseFailure(parsed)
  const found = imports(path).flatMap((imported) => {
    const io = ioImport(path, imported)
    return io === undefined ? [] : [`${path}:${imported.line}: a repository imports ${io}`]
  })
  walk(parsed.program, (node) => {
    const name = member(node)
    if (name?.[0] === "Effect" && (name[1] === "sleep" || name[1] === "delay"))
      found.push(`${path}:${parsed.line(node.start)}: a repository waits (${name.join(".")})`)
    return true
  })
  return found
}

describe("repositories", () => {
  it("a repository does no I/O and does not sleep", () => {
    expect(listFiles("apps/server/src").filter(isRepository).flatMap(violations)).toEqual([])
  })
})
