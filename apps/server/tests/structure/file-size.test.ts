import { describe, expect, it } from "vite-plus/test"
import { listFiles, read } from "./sources.ts"

// docs/effect.md, Structural tests, rule 7: no source file passes 1,000 lines. Tests, fixtures and generated files
// are excepted (`*.test.*`, folders `test`, `tests`, `fixtures`, `generated`, `*.gen.*`, declaration files).
// Migrations are hand-written sources and are counted: the initial one is 833 lines, and a migration that would pass
// the limit splits in two like any other file. Reads apps/*, packages/* and scripts.

const LIMIT = 1000

const skip = new Set(["node_modules", "dist", "target", "coverage", ".vite", ".vite-temp", "test", "tests", "__tests__", "fixtures", "generated", "public"])

const sources = (): ReadonlyArray<string> =>
  ["apps", "packages", "scripts"].flatMap((dir) => listFiles(dir, skip)).filter((path) => !/\.(?:test|gen)\.[cm]?[jt]sx?$/.test(path))

const lineCount = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0)

describe("file size", () => {
  it(`no source file passes ${LIMIT} lines`, () => {
    expect(
      sources().flatMap((path) => {
        const lines = lineCount(read(path))
        return lines > LIMIT ? [`${path}:${LIMIT + 1}: ${lines} lines, more than ${LIMIT}: split it`] : []
      }),
    ).toEqual([])
  })
})
