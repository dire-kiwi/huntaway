import { spawnSync } from "node:child_process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Pty } from "./Pty.ts"

// The pty helper on a real python3.

const hasPython = spawnSync("python3", ["-V"]).status === 0

describe("Pty", () => {
  // HE-74: the child set the first size after the fork, which could undo a resize the helper had already taken, so a
  // terminal whose first resize came at once (a relayed one, with no size in its URL) stayed at the first size.
  it.live.skipIf(!hasPython)("a resize as soon as it's spawned is the size its command gets", () =>
    Effect.gen(function* () {
      const pty = yield* Pty
      // Says its size once it's no longer the first one.
      const term = yield* pty.spawn("sh", ["-c", 'while [ "$(stty size)" = "24 80" ]; do sleep 0.05; done; echo "size: $(stty size)"'], {
        env: {},
        cols: 80,
        rows: 24,
      })
      yield* term.resize(150, 40)
      const out = yield* term.output.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (all, chunk) => all + chunk,
        ),
        Effect.timeout("10 seconds"),
      )
      assert.include(out, "size: 40 150")
    }).pipe(Effect.scoped, Effect.provide(Pty.layer.pipe(Layer.provide(NodeServices.layer)))),
  )
})
