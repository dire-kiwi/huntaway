import { describe, expect, it } from "@effect/vitest"
import { basicCatalog, check, rules } from "../src/express.ts"

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
    expect(check('root = Text("x")', catalogs)).toMatchObject({ ok: true, surfaces: ["reply"] })
  })

  it("checks an update against the thread's earlier blocks", () => {
    const first = 'surface("pick")\nroot = Text("a")'
    const update = '<a2ui>\nsurface("pick", update=true)\nroot = Text("b")\n</a2ui>'
    expect(check(update, catalogs, [first])).toMatchObject({ ok: true, surfaces: ["pick"] })
    const again = '<a2ui>\nsurface("pick")\nroot = Text("b")\n</a2ui>'
    expect(check(again, catalogs, [first])).toMatchObject({ ok: false })
  })
})
