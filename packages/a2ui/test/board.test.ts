import { describe, expect, it } from "@effect/vitest"
import { BASIC_CATALOG_ID, basicCatalog, boardCatalogs, boardTransform, check, rules, ThreadSurfaces } from "../src/express.ts"

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

/** The components a block lowers to (after the macros), checking that it draws too. */
const lowered = (source: string): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const out: Array<Readonly<Record<string, unknown>>> = []
  const transform = boardTransform()
  const t = new ThreadSurfaces({
    render: [basicCatalog()],
    inference: boardCatalogs(),
    transform: (m) => {
      const messages = transform(m)
      for (const message of messages) {
        const body = typeof message === "object" && message !== null && "createSurface" in message ? message.createSurface : undefined
        const components = typeof body === "object" && body !== null && "components" in body ? body.components : []
        if (Array.isArray(components)) out.push(...components)
      }
      return messages
    },
  })
  t.sync([{ kind: "block", key: "m1@0", source }])
  expect(t.block("m1@0")).toMatchObject({ ok: true })
  return out
}
const of = (components: ReadonlyArray<Readonly<Record<string, unknown>>>, name: string) => components.filter((c) => c["component"] === name)

describe("Choice (HE-77 review)", () => {
  it("keeps the button disabled until there's a pick", () => {
    const [button] = of(lowered('surface("s")\nroot = Choice("Q?", [{label: "A", value: "a"}])'), "Button")
    expect(button?.["checks"]).toEqual([
      { condition: { "@call": "required", args: { value: { "@path": "/choice/root" } }, catalogId: BASIC_CATALOG_ID }, message: "Pick an option first." },
    ])
  })

  it("keeps two Choices' picks on one surface apart", () => {
    const components = lowered('surface("s")\nroot = Column([Choice("Q1?", [{label: "A", value: "a"}]), Choice("Q2?", [{label: "B", value: "b"}])])')
    const paths = of(components, "ChoicePicker").map((p) => JSON.stringify(p["value"]))
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
    // Each button sends its own pick.
    const sent = of(components, "Button").map((b) => JSON.stringify(b["action"]))
    expect(new Set(sent).size).toBe(2)
  })
})
