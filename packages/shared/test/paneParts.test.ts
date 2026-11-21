import { describe, expect, it } from "vite-plus/test"
import { PANE_MAX_PARTS, PANE_PART, PaneJoin, paneParts } from "../src/paneParts.ts"

// A desktop pane's big answers in parts (HE-71): what `paneParts` splits, `PaneJoin` gives back as it was.

const joined = (frames: ReadonlyArray<string | Uint8Array>) => {
  const join = new PaneJoin()
  return frames.flatMap((f) => {
    const whole = join.push(f)
    return whole === undefined ? [] : [whole]
  })
}

describe("paneParts", () => {
  it("sends a message that fits as it is", () => {
    expect(paneParts('{"id":1,"result":{}}')).toEqual(['{"id":1,"result":{}}'])
    expect(joined(['{"id":1,"result":{}}'])).toEqual(['{"id":1,"result":{}}'])
  })

  it("splits a big one into binary parts that join again, characters split across parts and all", () => {
    // "é" is two bytes and "😀" four, so the parts' edges fall inside characters.
    const text = JSON.stringify({ id: 7, result: { value: "é😀x".repeat(PANE_PART / 2) } })
    const parts = paneParts(text) ?? []
    expect(parts[0]).toBe(`{"parts":${parts.length - 1}}`)
    expect(parts.length - 1).toBeGreaterThan(2)
    expect(parts.slice(1).every((p) => p instanceof Uint8Array && p.byteLength <= PANE_PART)).toBe(true)
    expect(joined(parts)).toEqual([text])
  })

  it("passes on the messages before and after one in parts", () => {
    const big = JSON.stringify({ id: 2, result: { value: "a".repeat(PANE_PART * 2) } })
    const event = '{"method":"Page.loadEventFired","params":{}}'
    expect(joined([event, ...(paneParts(big) ?? []), event])).toEqual([event, big, event])
  })

  it("won't split one over the most parts", () => {
    expect(paneParts("a".repeat(PANE_PART * PANE_MAX_PARTS + 1))).toBeNull()
  })
})
