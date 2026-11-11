import { Config, Context, Effect, FileSystem, Layer } from "effect"
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
      const fs = yield* FileSystem.FileSystem
      const path = yield* Config.String("PATH").pipe(Config.withDefault(""))
      /** Whether a program is there: a path that exists, or a name on `PATH` (the old `on_path`). */
      const onPath = (program: string) => {
        const places = program.includes("/") ? [program] : path.split(":").flatMap((d) => (d === "" ? [] : [`${d}/${program}`]))
        return Effect.map(
          Effect.forEach(places, (p) => fs.exists(p).pipe(Effect.orElseSucceed(() => false)), { concurrency: 1 }),
          (found) => found.some((x) => x),
        )
      }
      // Codex runs where its CLI is installed (5.2): looked for once, as the server starts.
      const codex = yield* onPath(config.codexBin)
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
        // It runs agents unless started with --no-agents (the old `can_run_agents`): Claude Code, and Codex where its CLI
        // is installed. The web app offers Start, and starts a fresh task moved into In progress, only where this is true.
        agents: !config.noAgents,
        agent_clis: config.noAgents ? [] : codex ? ["claude", "codex"] : ["claude"],
        data_dir: dataDir.root,
        hostname: identity.hostName,
        home: config.home,
      }
      return About.of({ health: Effect.succeed(health), info: Effect.succeed(info) })
    }),
  )
}
