import { assert, describe, it } from "@effect/vitest"
import { joinTexts, MAX_PCM_BYTES, pcmProblem, pcmToFloat, splitAtPauses } from "./audio.ts"

describe("a dictation's audio", () => {
  it("takes 16-bit PCM of up to five minutes", () => {
    assert.strictEqual(pcmProblem(new Uint8Array(0)), "the recording is empty")
    assert.strictEqual(pcmProblem(new Uint8Array(3)), "the recording isn't 16-bit PCM")
    assert.strictEqual(pcmProblem(new Uint8Array(MAX_PCM_BYTES + 2)), "the recording is longer than 5 minutes")
    assert.isNull(pcmProblem(new Uint8Array(MAX_PCM_BYTES)))
  })

  it("reads little-endian samples as floats between -1 and 1", () => {
    const bytes = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0x00, 0x40, 0xff, 0x7f])
    assert.deepStrictEqual([...pcmToFloat(bytes)], [-1, 0, 0.5, 32767 / 32768])
  })

  it("cuts long audio at its quietest stretch, never into more than the limit", () => {
    // 10,000 samples of sound with a pause at 7,000–7,400.
    const pcm = new Float32Array(10_000).map((_, i) => (i >= 7000 && i < 7400 ? 0 : 0.5))
    const pieces = splitAtPauses(pcm, 8000)
    assert.strictEqual(pieces.length, 2)
    const first = pieces[0]?.length ?? 0
    assert.isAtLeast(first, 7000)
    assert.isAtMost(first, 7400)
    assert.strictEqual(
      pieces.reduce((n, p) => n + p.length, 0),
      pcm.length,
    )
    // Short audio is one piece; very long audio is many, each within the limit.
    assert.strictEqual(splitAtPauses(pcm, 20_000).length, 1)
    const many = splitAtPauses(new Float32Array(100_000).fill(0.1), 8000)
    assert.isTrue(many.every((p) => p.length <= 8000))
    assert.strictEqual(
      many.reduce((n, p) => n + p.length, 0),
      100_000,
    )
  })

  it("joins the pieces' texts with one space", () => {
    assert.strictEqual(joinTexts([" Hello there. ", "", "How are you? "]), "Hello there. How are you?")
  })
})
