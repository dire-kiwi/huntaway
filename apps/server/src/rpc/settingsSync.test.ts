import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Redacted } from "effect"
import { RpcMiddleware, RpcTest } from "effect/rpc"
import { Auth, SettingsSyncRpcs } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Identity } from "../platform/Identity.ts"
import { AuthLive } from "./AuthLive.ts"
import { SettingsSyncHandlers } from "./settingsSync.ts"

// Review of HE-6: `settingsSync.merge` writes the host's synced settings (approval rules, agents' access, terminal
// tools), so it needs `settings`, as the old `/api/settings-sync/merge` needed the board token. The hub token, which every
// host that dials in holds and which gives `link` alone, is refused; the hub's own sealed session to a host carries every
// board scope, so its exchange still merges.

/** Each request carries the headers it is given. */
const AsGiven = RpcMiddleware.layerClient(Auth, ({ next, request }) => next(request))

/** A call's options carrying `token`. */
const as = (token: Redacted.Redacted) => ({ headers: { authorization: `Bearer ${Redacted.value(token)}` } })

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SettingsSyncHandlers, AuthLive, AsGiven).pipe(Layer.provideMerge(TestBoard()))))

describe("settingsSync.merge", () => {
  it.effect("is Forbidden with the hub token, and taken with the board token", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* Identity
        const client = yield* RpcTest.makeClient(SettingsSyncRpcs)
        const hub = yield* Effect.exit(client["settingsSync.merge"]({ entries: [] }, as(identity.hubToken)))
        assert.isTrue(Exit.isFailure(hub))
        assert.strictEqual(Exit.isFailure(hub) ? Exit.findErrorOption(hub).pipe((e) => (e._tag === "Some" ? e.value._tag : "defect")) : "ok", "Forbidden")
        // With the board token it is the service that answers (sync is off on a fresh board), not Auth.
        const board = yield* Effect.exit(client["settingsSync.merge"]({ entries: [] }, as(identity.token)))
        const tag = Exit.isFailure(board) ? Exit.findErrorOption(board).pipe((e) => (e._tag === "Some" ? e.value._tag : "defect")) : "ok"
        assert.notInclude(["Forbidden", "Unauthorized"], tag)
      }),
    ),
  )
})
