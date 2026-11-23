import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Paired, PIN_DIGITS } from "../device.ts"
import { Invalid, NotFound, Unavailable } from "../errors.ts"
import { Health } from "../host.ts"

/** What needs no session (docs/plan/05-protocol.md): part of the stable core that never changes shape. */
export class PublicRpcs extends RpcGroup.make(
  /** Who this host is and what it speaks. The desktop shell, discovery and deploy checks read it. */
  Rpc.make("public.health", { success: Health }),
  /**
   * The board token, for any browser that asks: only on a server started with `--open-token` (previews and test
   * servers), and on a loopback-only one only for a loopback `Host` header. Otherwise `NotFound`.
   */
  Rpc.make("public.openToken", { success: Schema.Struct({ token: Schema.String }), error: NotFound }),
  /**
   * A phone pairs with the board (HE-91): the PIN the board shows in pairing mode (Settings → Network access), and what
   * the phone calls itself. Gives the device's own token, with `read` and `operate`. A wrong PIN is `Invalid` (`pin`)
   * and uses up one of its tries; with none left, or none showing, pairing mode is off: `Unavailable` (`pairing`).
   */
  Rpc.make("public.pair", {
    payload: { pin: Schema.String.check(Schema.isMaxLength(PIN_DIGITS * 4)), name: Schema.String.check(Schema.isMaxLength(200)) },
    success: Paired,
    error: Schema.Union([Invalid, Unavailable]),
  }),
) {}
