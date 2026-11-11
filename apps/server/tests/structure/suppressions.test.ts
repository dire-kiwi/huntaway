import { describe, expect, it } from "vite-plus/test"
import { listFiles, read } from "./sources.ts"

// docs/effect.md, Structural tests, rule 4: the number of lint suppressions in the code base equals the number of rows
// in the table under "## Suppressions" in docs/effect.md, where each has its reason. Reads every code file in the
// workspace (apps, packages, scripts and the root's configs; tests included), less what is installed or built.

const directives = ["@effect-diagnostics", "oxlint-disable", "eslint-disable"]

/** A directive right after the opening of a line or block comment, as the linters read them. */
const suppression = new RegExp(`(?:\\/\\/|\\/\\*+)\\s*(?:${directives.join("|")})`)

const skip = new Set(["node_modules", "dist", "target", "coverage", ".git", ".vite", ".vite-temp", ".cargo", "docs", "rust"])

const codeFiles = (): ReadonlyArray<string> => listFiles(".", skip).map((path) => path.slice("./".length))

const suppressions = (): ReadonlyArray<string> =>
  codeFiles().flatMap((path) =>
    read(path)
      .split("\n")
      .flatMap((text, index) => (suppression.test(text) ? [`${path}:${index + 1}: ${text.trim()}`] : [])),
  )

/** The rows of the table under "## Suppressions", less its header and separator. */
const listed = (): ReadonlyArray<string> => {
  const lines = read("docs/effect.md").split("\n")
  const start = lines.findIndex((line) => line.trim() === "## Suppressions")
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line))
  const table = lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim().startsWith("|"))
  return table.slice(1).filter((line) => !/^\|[\s:|-]+\|$/.test(line.trim()))
}

describe("suppressions", () => {
  it("docs/effect.md has a section Suppressions", () => {
    expect(read("docs/effect.md").split("\n")).toContain("## Suppressions")
  })

  it("every lint suppression is listed in docs/effect.md, Suppressions", () => {
    const rows = listed()
    const found = suppressions()
    expect(found.length, `docs/effect.md, Suppressions, has ${rows.length} row(s); the sources have:\n${found.join("\n")}\n`).toBe(rows.length)
  })
})
