import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { RpcSerialization } from "effect/rpc"
import { RPC_MAX_MESSAGE, RpcNdjson } from "@huntaway/contracts"

// A board's snapshot is one message: past effect's 16 MiB default, a client turned it down and subscribed again for ever.
const bigLine = (size: number) => `${JSON.stringify({ _tag: "Chunk", requestId: "1", values: ["x".repeat(size)] })}\n`

describe("RpcNdjson", () => {
  it.effect("reads a message longer than effect's default 16 MiB", () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization
      const size = 17 * 1024 * 1024
      const line = bigLine(size)
      // Whole, and in pieces as a socket hands it over.
      expect(serialization.makeUnsafe().decode(line)).toHaveLength(1)
      const parser = serialization.makeUnsafe()
      const pieces = [line.slice(0, 5_000_000), line.slice(5_000_000, 12_000_000), line.slice(12_000_000)]
      const out = pieces.flatMap((piece) => parser.decode(piece))
      expect(out).toHaveLength(1)
      expect((out[0] as { values: Array<string> }).values[0]).toHaveLength(size)
    }).pipe(Effect.provide(RpcNdjson)),
  )

  it.effect("effect's own default turns the same message down", () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization
      expect(() => serialization.makeUnsafe().decode(bigLine(17 * 1024 * 1024))).toThrow()
      expect(RPC_MAX_MESSAGE).toBeGreaterThan(17 * 1024 * 1024)
    }).pipe(Effect.provide(RpcSerialization.layerNdjson)),
  )
})
