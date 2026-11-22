import { describe, expect, it } from "@effect/vitest"
import { basicCatalog, ThreadSurfaces } from "../src/express.ts"
import type { ThreadEntry } from "../src/express.ts"

const make = () => new ThreadSurfaces({ render: [basicCatalog()], inference: [basicCatalog()] })
const block = (key: string, source: string): ThreadEntry => ({ kind: "block", key, source })

const pick = block("m1@0", 'surface("pick")\nroot = Button(Text("A"), action=Event("a", {n: 1}))')
const update = block("m3@0", 'surface("pick", update=true)\nroot = Text("Picked A")')

describe("ThreadSurfaces", () => {
  it("draws a block's surface, and tells listeners", () => {
    const t = make()
    let told = 0
    t.subscribe(() => (told += 1))
    expect(t.sync([pick])).toBe(true)
    expect(t.sync([pick])).toBe(false)
    expect(told).toBe(1)
    expect(t.block("m1@0")).toEqual({ ok: true, surfaces: [{ id: "pick", answered: false, sending: false }], superseded: false })
    expect(t.surface("pick")).toBeDefined()
  })

  it("passes a click on, locks the surface once the thread has it, and unlocks it with the agent's update", () => {
    const t = make()
    const clicks: Array<string> = []
    t.setOnAction((a) => void clicks.push(`${a.surfaceId}:${a.name}`))
    t.sync([pick])
    t.setSending("pick", true)
    expect(t.block("m1@0")).toMatchObject({ surfaces: [{ sending: true }] })
    t.sync([pick, { kind: "action", surfaceId: "pick" }])
    expect(t.block("m1@0")).toMatchObject({ surfaces: [{ id: "pick", answered: true, sending: false }] })
    t.sync([pick, { kind: "action", surfaceId: "pick" }, update])
    // The earlier copy was updated below; the update is live.
    expect(t.block("m1@0")).toEqual({ ok: true, surfaces: [], superseded: true })
    expect(t.block("m3@0")).toMatchObject({ ok: true, surfaces: [{ id: "pick", answered: false }] })
  })

  it("gives a block that doesn't draw its error, and the rest still draw", () => {
    const t = make()
    t.sync([block("m1@0", 'root = Nope("x")'), block("m2@0", 'root = Text("ok")')])
    const bad = t.block("m1@0")
    expect(bad?.ok).toBe(false)
    expect(t.block("m2@0")).toMatchObject({ ok: true, surfaces: [{ id: "reply-m2@0" }] })
    // An update of a surface the thread hasn't drawn.
    t.sync([update])
    expect(t.block("m3@0")?.ok).toBe(false)
  })

  it("rebuilds when an earlier entry changes", () => {
    const t = make()
    t.sync([pick, update])
    t.sync([block("m0@0", 'root = Text("older")'), pick, update])
    expect(t.block("m0@0")).toMatchObject({ ok: true })
    expect(t.block("m3@0")).toMatchObject({ ok: true, surfaces: [{ id: "pick" }] })
  })

  it("lowers a block's messages with its transform before drawing them", () => {
    const seen: Array<number> = []
    const t = new ThreadSurfaces({
      render: [basicCatalog()],
      inference: [basicCatalog()],
      transform: (m) => (seen.push(m.length), m),
    })
    t.sync([pick])
    expect(seen).toEqual([1])
  })

  it("unlocks a surface the agent draws again even when the click never reached the thread (HE-77 review)", () => {
    const t = make()
    t.sync([pick])
    t.setSending("pick", true)
    t.sync([pick, update])
    expect(t.block("m3@0")).toMatchObject({ surfaces: [{ id: "pick", sending: false, answered: false }] })
  })

  it("names the surface an update can't find, for a thread whose start isn't loaded", () => {
    const t = make()
    t.sync([update])
    expect(t.block("m3@0")).toMatchObject({ ok: false, missing: "pick" })
    t.sync([block("m4@0", 'root = Nope("x")')])
    expect(t.block("m4@0")).toMatchObject({ ok: false, missing: undefined })
  })
})
