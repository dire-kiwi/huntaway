import { Clock, Effect, FileSystem, Layer, Ref, Schema } from "effect"
import type { AgentModel } from "@huntaway/contracts"
import { Proc } from "../../platform/Proc.ts"
import { ServerConfig } from "../../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../../profiles/AgentConfigRepo.ts"
import { AcpQueries, AcpUnavailable, acpConfigModelsWith, modelsFromListing, signInReason } from "../AcpQueries.ts"
import { acpHomeEnv } from "../configEnv.ts"
import { AcpSpec, commandLine } from "./spec.ts"

// `AcpQueries` against the agent itself (HE-69): `<launcher> acp-run --list-models <spec.json>`, a spec with a fresh temp
// folder as its working directory, the config's command line and home, and nothing else, given up after 30 seconds. It
// prints one JSON line (`ModelListing`) and exits 0, or exits 3 when the agent needs a sign-in. The models are kept 10
// minutes per config, in memory.

/** How long the models are kept. */
const MODELS_FOR_MS = 600_000
const QUERY_TIMEOUT = "30 seconds"
/** `acp-run --list-models`' exit code for an agent that isn't signed in. */
const SIGNED_OUT = 3

interface Cached {
  readonly at: number
  readonly value: ReadonlyArray<AgentModel>
}

const encodeSpec = Schema.encodeEffect(Schema.fromJsonString(AcpSpec))

/** The last line of what it said, for a failure's reason. */
const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? ""

export const AcpQueriesLive = Layer.effect(
  AcpQueries,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const proc = yield* Proc
    const fs = yield* FileSystem.FileSystem
    const repo = yield* AgentConfigRepo
    const cache = yield* Ref.make<ReadonlyMap<string, Cached>>(new Map())

    /** Asks the agent, in a temp folder that goes once it has answered. */
    const ask = (cfg: AgentConfigRow, exe: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ directory: config.tmpDir, prefix: "huntaway-acp-" })
          const { program, args } = commandLine(cfg.command)
          const spec: AcpSpec = {
            cwd: dir,
            program,
            args,
            session_id: null,
            model: null,
            effort: null,
            mode: "default",
            system_prompt: "",
            input: false,
            requests_on_output: false,
            mcp_servers: [],
          }
          const file = `${dir}/spec.json`
          yield* fs.writeFileString(file, yield* encodeSpec(spec))
          return yield* proc.run(exe, ["acp-run", "--list-models", file], {
            cwd: dir,
            timeout: QUERY_TIMEOUT,
            env: { ...config.agentEnv, ...acpHomeEnv(cfg, config.home) },
          })
        }),
      ).pipe(Effect.mapError((e) => new AcpUnavailable({ reason: e._tag === "ProcFailed" ? e.reason : e.message })))

    const models = Effect.fn("AcpQueries.models")(function* (cfg: AgentConfigRow) {
      const key = `${cfg.id}\0${cfg.command ?? ""}\0${cfg.config_dir}`
      const now = yield* Clock.currentTimeMillis
      const hit = (yield* Ref.get(cache)).get(key)
      if (hit !== undefined && now - hit.at < MODELS_FOR_MS) return hit.value
      if (config.exe === null)
        return yield* new AcpUnavailable({ reason: "this server wasn't started by its launcher (bin/huntaway), so it can't ask an ACP agent" })
      const out = yield* ask(cfg, config.exe)
      if (out.code === SIGNED_OUT) return yield* new AcpUnavailable({ reason: signInReason(cfg.command) })
      if (out.code !== 0) return yield* new AcpUnavailable({ reason: lastLine(out.stderr) || `acp-run --list-models exited with ${out.code}` })
      const list = modelsFromListing(out.stdout)
      if (list === null) return yield* new AcpUnavailable({ reason: "the agent's models didn't read" })
      const at = yield* Clock.currentTimeMillis
      yield* Ref.update(cache, (all) => new Map([...all, [key, { at, value: list }]]))
      return list
    })

    return AcpQueries.of({ models, configModels: acpConfigModelsWith(repo, models) })
  }),
)
