import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BoardMessage } from "../events.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * The board's subscription (docs/plan/05-protocol.md, The board): `hello`, then a `snapshot` (or, with a `since` this
 * boot can still replay, only the events after it), then every event. A subscriber that falls too far behind gets
 * `resync` and the stream ends.
 */
export class BoardRpcs extends RpcGroup.make(
  Rpc.make("board.watch", {
    payload: { since: Schema.optional(Schema.Struct({ boot: Schema.String, seq: Schema.Int })) },
    success: BoardMessage,
    stream: true,
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
