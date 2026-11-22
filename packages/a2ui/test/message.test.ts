import { describe, expect, it } from "@effect/vitest"
import { actionMessage, actionOf, closeOf, hasBlock, segments } from "../src/index.ts"

describe("segments", () => {
  it("leaves a reply without a block as Markdown", () => {
    expect(segments("Just **text**.")).toEqual([{ kind: "markdown", text: "Just **text**." }])
  })

  it("splits prose and a block", () => {
    const text = 'Pick one:\n<a2ui>\nsurface("pick")\nroot = Text("Hi")\n</a2ui>\nThanks.'
    expect(segments(text)).toEqual([
      { kind: "markdown", text: "Pick one:\n" },
      { kind: "a2ui", source: 'surface("pick")\nroot = Text("Hi")', closed: true, offset: 10 },
      { kind: "markdown", text: "\nThanks." },
    ])
  })

  it("keeps two blocks apart", () => {
    const text = '<a2ui>\nroot = Text("a")\n</a2ui>\nand\n<a2ui>\nroot = Text("b")\n</a2ui>'
    expect(segments(text).map((s) => s.kind)).toEqual(["a2ui", "markdown", "a2ui"])
  })

  it("gives a block still streaming in as unclosed", () => {
    const s = segments('Here:\n<a2ui>\nroot = Card(Text("half')
    expect(s[1]).toMatchObject({ kind: "a2ui", closed: false })
  })

  it("doesn't end a block at a tag inside an Express string or comment", () => {
    const text = '<a2ui>\nroot = Text("</a2ui> is the tag") # not </a2ui> here\nx = Text("""\n</a2ui>\n""")\n</a2ui>\nafter'
    const [block, after] = segments(text)
    expect(block).toMatchObject({ kind: "a2ui", closed: true })
    expect(block?.kind === "a2ui" && block.source.endsWith('</a2ui>\n""")')).toBe(true)
    expect(after).toEqual({ kind: "markdown", text: "\nafter" })
  })

  it("leaves a block shown in a code fence, or mid-line, as Markdown", () => {
    const fenced = 'Write it like this:\n```\n<a2ui>\nroot = Text("x")\n</a2ui>\n```\n~~~md\n<a2ui>\n~~~'
    expect(segments(fenced)).toEqual([{ kind: "markdown", text: fenced }])
    expect(hasBlock(fenced)).toBe(false)
    const inline = "The tag is `<a2ui>`, then the Express."
    expect(segments(inline)).toEqual([{ kind: "markdown", text: inline }])
  })

  it("finds a block after a fence closes", () => {
    const text = '```js\nconst a = "<a2ui>"\n```\n<a2ui>\nroot = Text("x")\n</a2ui>'
    expect(segments(text).map((s) => s.kind)).toEqual(["markdown", "a2ui"])
  })

  it("skips raw strings, which have no escapes", () => {
    const src = 'root = Text(r"a\\") </a2ui>'
    expect(closeOf(src, 0)).toBe(src.indexOf("</a2ui>"))
  })
})

describe("actions", () => {
  const action = { surfaceId: "pick", name: "choose", sourceComponentId: "b1", context: { option: "b", n: 2 } }

  it("round-trips the message a click sends", () => {
    const text = actionMessage(action, "Chose B")
    expect(text.startsWith("Chose B\n\n```a2ui-action\n")).toBe(true)
    expect(actionOf(text)).toEqual({ label: "Chose B", action })
  })

  it("labels it with the action's name by default", () => {
    expect(actionOf(actionMessage(action))?.label).toBe("Chose “choose”")
  })

  it("reads no action from any other message", () => {
    expect(actionOf("hello")).toBeNull()
    expect(actionOf("x\n\n```a2ui-action\nnot json\n```")).toBeNull()
    expect(actionOf('x\n\n```a2ui-action\n{"name":"a"}\n```')).toBeNull()
  })
})
