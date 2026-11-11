import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid } from "../errors.ts"
import { BoardMessage } from "../events.ts"
import { Auth, RequiredScope } from "../session.ts"

/** Whether a preview answered 200: its status, or null and why it couldn't be asked. */
export const PreviewStatus = Schema.Struct({ up: Schema.Boolean, status: Schema.NullOr(Schema.Int), error: Schema.optional(Schema.String) })
export type PreviewStatus = typeof PreviewStatus.Type

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
  /**
   * Whether a task's preview URL answers 200 (the old `GET /preview-status`), asked from the server: a browser can't
   * read a cross-origin response's status. `Invalid` (`url`) for one that isn't http(s).
   */
  Rpc.make("board.previewStatus", { payload: { url: Schema.String }, success: PreviewStatus, error: Invalid }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
