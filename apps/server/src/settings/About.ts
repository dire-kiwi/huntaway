import { Context, Effect, Layer } from "effect"
import { PROTOCOL } from "@huntaway/contracts"
import type { Health, HostInfo } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"

export interface AboutShape {
  /** `public.health` and `GET /api/health`: part of the stable core. */
  readonly health: Effect.Effect<Health>
  /** `host.info`. */
  readonly info: Effect.Effect<HostInfo>
}

/** What this host says of itself. */
export class About extends Context.Service<About, AboutShape>()("huntaway-server/settings/About") {
  static readonly layer = Layer.effect(
    About,
    Effect.gen(function* () {
      const identity = yield* Identity
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const capabilities: ReadonlyArray<string> = []
      const health: Health = { ok: true, host_id: identity.hostId, version: config.version, protocol: PROTOCOL, capabilities, commit: config.commit }
      const info: HostInfo = {
        host_id: identity.hostId,
        host_name: identity.hostName,
        build_id: config.commit ?? config.version,
        version: config.version,
        protocol: PROTOCOL,
        capabilities,
        read_only: false,
        commit: config.commit,
        updates_from: null,
        agents: false,
        agent_clis: [],
        data_dir: dataDir.root,
        hostname: identity.hostName,
        home: config.home,
      }
      return About.of({ health: Effect.succeed(health), info: Effect.succeed(info) })
    }),
  )
}
