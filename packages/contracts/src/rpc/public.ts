import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound } from "../errors.ts"
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
) {}
