import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { BUILT_IN_STYLES, fileStyles, launchStyle, outputStyles, reportedStyles, styleNamed, styleOf } from "./outputStyles.ts"

// A Claude task's output styles for the `/output-style` menu (HE-102): what a run's `initialize` answer lists, the
// styles' files, and a typed name matched to one.

/** A task (or a review thread) with its own style, or none. */
const task = (output_style: string | null, kind: "task" | "review" = "task") => ({ kind, output_style })

describe("output styles", () => {
  it("gives a task its own style, else its project's, else its profile's; a review thread only its own (HE-111)", () => {
    const project = { output_style: "Explanatory" }
    const profile = { default_output_style: "Concise" }
    assert.deepStrictEqual(styleOf(task("Learning"), project, profile), { style: "Learning", from: "task" })
    assert.deepStrictEqual(styleOf(task(null), project, profile), { style: "Explanatory", from: "project" })
    assert.deepStrictEqual(styleOf(task(" "), { output_style: null }, profile), { style: "Concise", from: "profile" })
    assert.isNull(launchStyle(task(null), null, { default_output_style: "" }))
    assert.isNull(launchStyle(task(null, "review"), project, profile))
    assert.strictEqual(launchStyle(task("default", "review"), project, profile), "default")
  })

  it("reads the styles from Claude Code's initialize answer, and nothing from one without them", () => {
    assert.deepStrictEqual(reportedStyles({ output_style: "Explanatory", available_output_styles: ["default", "Explanatory", 3, ""] }), {
      current: "Explanatory",
      available: ["default", "Explanatory"],
    })
    assert.isNull(reportedStyles({ commands: [] }))
    assert.isNull(reportedStyles(null))
  })

  it("lists what the run reported, described from the files, else the built-in ones and the files'", () => {
    const files = [{ name: "Terse", description: "Short answers" }]
    assert.deepStrictEqual(outputStyles({ current: "default", available: ["default", "Terse", "plugin:Pirate"] }, files), [
      { name: "default", description: "Claude Code's own: completes coding tasks efficiently" },
      { name: "Terse", description: "Short answers" },
      { name: "plugin:Pirate", description: "" },
    ])
    assert.deepStrictEqual(
      outputStyles(null, files).map((s) => s.name),
      [...BUILT_IN_STYLES.map((s) => s.name), "Terse"],
    )
    // A file named like a built-in one replaces it.
    assert.strictEqual(outputStyles(null, [{ name: "Learning", description: "Mine" }]).find((s) => s.name === "Learning")?.description, "Mine")
  })

  it("matches a typed name exactly, else in any case", () => {
    const styles = [
      { name: "Explanatory", description: "" },
      { name: "explanatory", description: "" },
      { name: "Terse", description: "" },
    ]
    assert.deepStrictEqual([styleNamed(styles, "explanatory"), styleNamed(styles, "TERSE"), styleNamed(styles, "Nope")], ["explanatory", "Terse", null])
  })

  it.effect("finds the styles in folders by their frontmatter's name or the file's, a later folder's winning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${root}/user`)
      yield* fs.makeDirectory(`${root}/project`)
      yield* fs.writeFileString(`${root}/user/terse.md`, "---\nname: Terse\ndescription: Short answers\n---\nBe brief.\n")
      yield* fs.writeFileString(`${root}/user/plain.md`, "Write plainly.\n")
      yield* fs.writeFileString(`${root}/user/notes.txt`, "not a style")
      yield* fs.writeFileString(`${root}/project/terse.md`, "---\nname: Terse\ndescription: The project's\n---\nBe briefer.\n")
      const found = yield* fileStyles(fs, [`${root}/user`, `${root}/project`, `${root}/missing`])
      assert.deepStrictEqual(found, [
        { name: "plain", description: "" },
        { name: "Terse", description: "The project's" },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
