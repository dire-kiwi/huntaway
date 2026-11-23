import { assert, describe, it } from "@effect/vitest"
import { floatToPcm16, insertDictation } from "../../src/speech/recorder"

// Dictation (HE-89): the recording as the PCM the host takes, and what was heard put in at the field's caret.

describe("dictation", () => {
  it("writes samples as 16-bit little-endian PCM, clipped to the range", () => {
    const pcm = floatToPcm16(new Float32Array([0, -1, 1, 0.5, 2, -2]))
    const view = new DataView(pcm.buffer)
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true)),
      [0, -32768, 32767, 16384, 32767, -32768],
    )
  })

  it("puts what was heard at the selection, with a space between it and the words either side", () => {
    assert.deepStrictEqual(insertDictation("", 0, 0, " Hello there. "), { text: "Hello there.", caret: 12 })
    assert.deepStrictEqual(insertDictation("Fix it", 6, 6, "and test it"), { text: "Fix it and test it", caret: 18 })
    assert.deepStrictEqual(insertDictation("Fix  please", 4, 4, "the bug"), { text: "Fix the bug please", caret: 11 })
    assert.deepStrictEqual(insertDictation("Fix the bug.", 4, 11, "it"), { text: "Fix it.", caret: 6 })
    assert.deepStrictEqual(insertDictation("Fixit", 3, 3, "x"), { text: "Fix x it", caret: 5 })
    // Nothing heard changes nothing.
    assert.deepStrictEqual(insertDictation("Fix it", 2, 4, "  "), { text: "Fix it", caret: 4 })
  })
})
