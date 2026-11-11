import { Context, Effect, Layer } from "effect"
import { Proc } from "../../platform/Proc.ts"
import { parseTailscaleStatus } from "./dns.ts"
import type { Peer } from "./dns.ts"

/** How long `tailscale status --json` may take. */
const TIMEOUT = "3 seconds"

export interface TailscaleShape {
  /** This machine's online Tailscale peers, or null without Tailscale (no CLI, or it isn't up). */
  readonly peers: Effect.Effect<ReadonlyArray<Peer> | null>
}

/** Tailscale's view of the network, for discovery: Tailscale carries no multicast, so its peers are asked directly. */
export class Tailscale extends Context.Service<Tailscale, TailscaleShape>()("huntaway-server/hosts/discovery/Tailscale") {
  /** From `tailscale status --json`. */
  static readonly layer = Layer.effect(
    Tailscale,
    Effect.gen(function* () {
      const proc = yield* Proc
      return Tailscale.of({
        peers: proc.run("tailscale", ["status", "--json"], { timeout: TIMEOUT }).pipe(
          Effect.map((r) => (r.code === 0 ? parseTailscaleStatus(r.stdout) : null)),
          Effect.orElseSucceed(() => null),
        ),
      })
    }),
  )

  /** These peers (tests), or none: no Tailscale. */
  static readonly layerTest = (peers: ReadonlyArray<Peer> | null) => Layer.succeed(Tailscale, Tailscale.of({ peers: Effect.succeed(peers) }))
}
