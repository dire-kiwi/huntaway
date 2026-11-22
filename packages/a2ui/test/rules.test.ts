import { describe, expect, it } from "@effect/vitest"
import { basicCatalog, check, NOT_A_BLOCK, rules } from "../src/express.ts"

const catalogs = [basicCatalog()]

describe("rules", () => {
  it("are the board's, then the Express contract with the basic components", () => {
    const text = rules(catalogs)
    expect(text.startsWith("# Interactive replies on the Huntaway board")).toBe(true)
    expect(text).toContain("a2ui-action")
    expect(text).toContain("A2UI Express")
    expect(text).toContain("• Button(")
  })
})

describe("check", () => {
  it("passes a good reply and names its surfaces", () => {
    const reply = 'Pick:\n<a2ui>\nsurface("pick")\nroot = Button(Text("Go"), action=Event("go"))\n</a2ui>'
    expect(check(reply, catalogs)).toEqual({ ok: true, blocks: 1, surfaces: ["pick"] })
  })

  it("says what's wrong with a bad block", () => {
    const result = check('<a2ui>\nroot = Nope("x")\n</a2ui>', catalogs)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/Nope/)
  })

  it("refuses an unclosed block", () => {
    expect(check('<a2ui>\nroot = Text("x")', catalogs)).toMatchObject({ ok: false, block: 1 })
  })

  it("checks bare Express as one block", () => {
    expect(check('root = Text("x")', catalogs)).toMatchObject({ ok: true, surfaces: ["reply-block-0"] })
  })

  it("checks an update against the thread's earlier blocks", () => {
    const first = 'surface("pick")\nroot = Text("a")'
    const update = '<a2ui>\nsurface("pick", update=true)\nroot = Text("b")\n</a2ui>'
    expect(check(update, catalogs, [first])).toMatchObject({ ok: true, surfaces: ["pick"] })
    const again = '<a2ui>\nsurface("pick")\nroot = Text("b")\n</a2ui>'
    expect(check(again, catalogs, [first])).toMatchObject({ ok: false })
  })

  it("gives each block that names no surface its own, as the board does (HE-77 review)", () => {
    const unnamed = '<a2ui>\nroot = Text("Hi")\n</a2ui>'
    expect(check(`${unnamed}\nand\n${unnamed}`, catalogs)).toMatchObject({ ok: true, blocks: 2 })
    expect(check(unnamed, catalogs, ['root = Text("earlier")'])).toMatchObject({ ok: true })
    // An update of the fallback name isn't a surface the board drew.
    expect(check('<a2ui>\nsurface("reply", update=true)\nroot = Text("x")\n</a2ui>', catalogs, ['root = Text("earlier")']).ok).toBe(false)
  })

  it("fails a reply whose <a2ui> the board shows as text", () => {
    expect(check("Here: <a2ui>\nroot = Nope()\n</a2ui>", catalogs)).toMatchObject({ ok: false, error: NOT_A_BLOCK })
    expect(check("```\n<a2ui>\nroot = Nope()\n</a2ui>\n```", catalogs)).toMatchObject({ ok: false, error: NOT_A_BLOCK })
  })
})
