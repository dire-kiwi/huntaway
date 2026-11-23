import { describe, expect, it } from "@effect/vitest"
import { Timestamp, type Turn } from "@huntaway/contracts"
import { isRewindCommand, rewindChoices } from "../../src/components/task/rewindCommand"

// HE-101: the composer's `/rewind`, and the messages it offers to go back to before.

const turn = (n: number, message_id: number | null, fields: Partial<Turn> = {}): Turn => ({
  turn: n,
  n,
  before_n: n - 1,
  run_id: null,
  message_id,
  text: `message ${message_id}`,
  auto: false,
  review_round: null,
  status: "done",
  stale: false,
  at: Timestamp.make("2026-11-24T00:00:00.000Z"),
  head: null,
  before_head: null,
  stats: null,
  diff: false,
  rewind: { ok: true, conversation: { ok: true, fresh: false } },
  ...fields,
})

describe("rewindCommand", () => {
  it("knows /rewind on its own, and nothing else", () => {
    expect([
      isRewindCommand("/rewind"),
      isRewindCommand("  /rewind \n"),
      isRewindCommand("/rewind me"),
      isRewindCommand("/rewinds"),
      isRewindCommand("rewind"),
    ]).toStrictEqual([true, true, false, false, false])
  })

  it("offers each message's first turn, newest first, without the turns rewound past or the agent's own", () => {
    const turns = [turn(1, 10), turn(2, null), turn(3, 12), turn(4, 12), turn(5, 14, { stale: true }), turn(6, 15)]
    expect(rewindChoices(turns).map((t) => t.turn)).toStrictEqual([6, 3, 1])
    expect(rewindChoices([])).toStrictEqual([])
  })
})
