import { describe, expect, it } from "@effect/vitest"
import { basicCatalog, boardCatalogs, boardTransform, check, rules, ThreadSurfaces } from "../src/express.ts"

// The board's macros (HE-77): taught, checked, and lowered to basic components before they're drawn.

const choice = 'surface("approach")\nroot = Choice("Which approach?", [{label: "Small", value: "small"}, {label: "Big", value: "big"}], event="pick")'
const confirm = 'surface("go")\nroot = Confirm("Merge it?", detail="Its checks passed.")'

describe("the board's macros", () => {
  it("are in the rules", () => {
    const text = rules(boardCatalogs())
    expect(text).toContain("Choice(")
    expect(text).toContain("Confirm(")
  })

  it("check, and a wrong call doesn't", () => {
    const catalogs = boardCatalogs()
    expect(check(`<a2ui>\n${choice}\n</a2ui>`, catalogs, [], boardTransform())).toMatchObject({ ok: true, surfaces: ["approach"] })
    expect(check(`<a2ui>\n${confirm}\n</a2ui>`, catalogs, [], boardTransform())).toMatchObject({ ok: true, surfaces: ["go"] })
    expect(check('<a2ui>\nroot = Choice("No options")\n</a2ui>', catalogs, [], boardTransform()).ok).toBe(false)
  })

  it("draw as basic components on a renderer that knows only the basic catalog", () => {
    const t = new ThreadSurfaces({ render: [basicCatalog()], inference: boardCatalogs(), transform: boardTransform() })
    t.sync([
      { kind: "block", key: "m1@0", source: choice },
      { kind: "block", key: "m2@0", source: confirm },
    ])
    expect(t.block("m1@0")).toMatchObject({ ok: true, surfaces: [{ id: "approach" }] })
    expect(t.block("m2@0")).toMatchObject({ ok: true, surfaces: [{ id: "go" }] })
    expect(t.surface("approach")?.componentsModel.get("root")?.type).toBe("Card")
  })
})
