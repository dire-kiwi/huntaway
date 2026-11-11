import { Context, Effect, Layer } from "effect"
import { PROTOCOL } from "@huntaway/contracts"
import type { Health, HostInfo } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Identity } from "../platform/Identity.ts"
import { Proc } from "../platform/Proc.ts"
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
      // The commit it runs: a checkout's HEAD when it started, else the release's or the deployment's (`ServerConfig`).
      const proc = yield* Proc
      const head =
        config.sourceDir === null
          ? null
          : yield* proc.run("git", ["rev-parse", "HEAD"], { cwd: config.sourceDir }).pipe(
              Effect.map((r) => (r.code === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null)),
              Effect.orElseSucceed(() => null),
            )
      const commit = head ?? config.commit
      // How it updates when a hub asks: its checkout, else the releases it follows.
      const updatesFrom = config.sourceDir !== null ? "checkout" : config.releaseRepo !== null ? "releases" : null
      const health: Health = { ok: true, host_id: identity.hostId, version: config.version, protocol: PROTOCOL, capabilities, commit }
      const info: HostInfo = {
        host_id: identity.hostId,
        host_name: identity.hostName,
        build_id: config.commit ?? config.version,
        version: config.version,
        protocol: PROTOCOL,
        capabilities,
        read_only: false,
        commit,
        updates_from: updatesFrom,
        // It runs agents unless started with --no-agents (the old `can_run_agents`), with Claude Code only until Codex
        // comes (M5). The web app offers Start, and starts a fresh task moved into In progress, only where this is true.
        agents: !config.noAgents,
        agent_clis: config.noAgents ? [] : ["claude"],
        data_dir: dataDir.root,
        hostname: identity.hostName,
        home: config.home,
      }
      return About.of({ health: Effect.succeed(health), info: Effect.succeed(info) })
    }),
  )
}
