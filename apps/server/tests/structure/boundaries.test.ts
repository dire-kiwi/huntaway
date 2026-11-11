import { posix } from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { exists, imports, isNodeModule, listFiles, parse, parseFailure, resolveImport } from "./sources.ts"
import type { Import } from "./sources.ts"

// docs/effect.md, Structural tests, rule 5: the package boundaries of docs/plan/02-repository.md (What goes in which
// package). The lint config holds most of them per folder; this holds them for every import form, relative paths
// that leave the package included. Each reads the package's `src`; a folder that does not exist yet passes.

/** For each import of each file under `dir` that `allowed` refuses: `file:line: imports x (why)`. */
const check = (dir: string, allowed: (from: string, imported: Import) => boolean, why: string): ReadonlyArray<string> =>
  listFiles(dir).flatMap((path) =>
    parseFailure(parse(path)).concat(
      imports(path)
        .filter((imported) => !allowed(path, imported))
        .map((imported) => `${path}:${imported.line}: imports ${imported.specifier} (${why})`),
    ),
  )

/** A relative import that stays inside `dir`. */
const staysIn = (dir: string) => (from: string, imported: Import) =>
  imported.specifier.startsWith(".") && (resolveImport(from, imported.specifier)?.startsWith(`${dir}/`) ?? false)

/** Where a relative import lands, whether or not the file is there. */
const target = (from: string, specifier: string) => posix.normalize(posix.join(posix.dirname(from), specifier))

const leavesFor = (from: string, specifier: string, dir: string) => specifier.startsWith(".") && target(from, specifier).startsWith(dir)

const contractsMayImport = (from: string, imported: Import) =>
  imported.specifier === "effect" ||
  (imported.specifier.startsWith("effect/") && !imported.specifier.startsWith("effect/internal")) ||
  imported.specifier === "@huntaway/shared" ||
  staysIn("packages/contracts")(from, imported)

const clientMayImport = (from: string, imported: Import) =>
  !isNodeModule(imported.specifier) && !/^huntaway-(?:server|web)(?:\/|$)/.test(imported.specifier) && !leavesFor(from, imported.specifier, "apps/")

const componentsMayImport = (from: string, imported: Import) =>
  !/^effect\/(?:rpc|http)(?:\/|$)/.test(imported.specifier) &&
  !imported.specifier.startsWith("@huntaway/client/") &&
  !leavesFor(from, imported.specifier, "packages/client/")

describe("package boundaries", () => {
  it("packages/contracts imports only effect, @huntaway/shared and itself", () => {
    expect(check("packages/contracts/src", contractsMayImport, "contracts import only effect, @huntaway/shared and themselves")).toEqual([])
  })

  it("packages/client imports no app and no Node module", () => {
    expect(check("packages/client/src", clientMayImport, "the client runs anywhere and imports no app")).toEqual([])
  })

  it(`apps/web/src/components imports no RPC or HTTP module and no client internal${exists("apps/web/src/components") ? "" : " (no components yet)"}`, () => {
    expect(check("apps/web/src/components", componentsMayImport, "components read @huntaway/client's public atoms; they do not call the server")).toEqual([])
  })

  it("packages/shared imports nothing but itself", () => {
    expect(check("packages/shared/src", staysIn("packages/shared"), "shared is plain TypeScript the hooks load per tool call")).toEqual([])
  })
})
