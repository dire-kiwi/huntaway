import { Config, Context, Effect, FileSystem, Layer } from "effect"
import { Capability, PROTOCOL } from "@huntaway/contracts"
import type { Health, HostInfo } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Identity } from "../platform/Identity.ts"
import { ImportGuard } from "../platform/ImportGuard.ts"
import type { ImportRecord } from "../platform/ImportRecord.ts"
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
  /** Over `rehearsal`, the import record of a read-only server (null for the board's own). */
  static readonly make = Effect.fnUntraced(function* (rehearsal: ImportRecord | null) {
    const identity = yield* Identity
    const config = yield* ServerConfig
    const dataDir = yield* DataDir
    const capabilities: ReadonlyArray<string> = rehearsal === null ? [Capability.settingsSync] : [Capability.readOnly]
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
    const updatesFrom = rehearsal !== null ? null : config.sourceDir !== null ? "checkout" : config.releaseRepo !== null ? "releases" : null
    const health: Health = { ok: true, host_id: identity.hostId, version: config.version, protocol: PROTOCOL, capabilities, commit }
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
    const info: HostInfo = {
      host_id: identity.hostId,
      host_name: identity.hostName,
      build_id: config.commit ?? config.version,
      version: config.version,
      protocol: PROTOCOL,
      capabilities,
      read_only: rehearsal !== null,
      // A rehearsal's banner: the board it is a copy of, and when it was imported.
      ...(rehearsal === null ? {} : { rehearsal: { from: rehearsal.from, imported_at: rehearsal.at } }),
      commit,
      updates_from: updatesFrom,
      // It runs agents unless started with --no-agents (the old `can_run_agents`): Claude Code, and Codex where its CLI
      // is installed. The web app offers Start, and starts a fresh task moved into In progress, only where this is true.
      agents: rehearsal === null && !config.noAgents,
      agent_clis: rehearsal !== null || config.noAgents ? [] : codex ? ["claude", "codex"] : ["claude"],
      data_dir: dataDir.root,
      hostname: identity.hostName,
      home: config.home,
    }
    return About.of({ health: Effect.succeed(health), info: Effect.succeed(info) })
  })

  static readonly layer = Layer.effect(About, About.make(null))

  /**
   * A read-only server's (docs/plan/06-server.md, A read-only server): `read_only`, with the board it rehearses (the
   * folder it was imported from, and when), the `read_only` capability, no agents and no updates.
   */
  static readonly readOnly = Layer.effect(
    About,
    Effect.flatMap(Effect.service(ImportGuard), ({ record }) => About.make(record)),
  )
}
