import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HostId } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Identity } from "../platform/Identity.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { CopyConfig } from "./CopyConfig.ts"

// Copying a config between hosts, what is refused before anything is asked of the target (the old
// `copy_claude_config`'s checks). The copy between two whole servers is in tests/e2e/hosts-sync.test.ts.

const reason = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (e) => e._tag)

describe("CopyConfig", () => {
  it.effect("refuses one host twice, no config, a profile, an unknown host and a config the source hasn't", () =>
    Effect.gen(function* () {
      const copy = yield* CopyConfig
      const me = (yield* Identity).hostId
      const other = HostId.make("elsewhere")
      yield* Effect.orDie((yield* AgentConfigs).create({ name: "work", config_dir: "/claude/work" }))
      assert.strictEqual(yield* reason(copy.copy({ from_host: me, to_host: me, config: "work" })), "Invalid")
      assert.strictEqual(yield* reason(copy.copy({ from_host: me, to_host: other })), "Invalid")
      assert.strictEqual(yield* reason(copy.copy({ from_host: me, to_host: other, profile: "work" })), "Invalid")
      assert.strictEqual(yield* reason(copy.copy({ from_host: me, to_host: other, config: "work" })), "HostOffline")
      assert.strictEqual(yield* reason(copy.copy({ from_host: other, to_host: me, config: "work" })), "HostOffline")
    }).pipe(Effect.provide(TestBoard())),
  )
})
