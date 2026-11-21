import { Context, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import type { AgentConfigId, AgentModel } from "@huntaway/contracts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { AgentConfigNotFound } from "../profiles/AgentConfigs.ts"
import { commandLine, DEFAULT_ACP_PROGRAM } from "./acp/spec.ts"

// What an ACP agent's config offers (HE-69; docs/plan/07-agents.md, ACP agents): its models and efforts, which
// `huntaway acp-run --list-models <spec.json>` asks the agent for (a session in a fresh temp folder) and prints as one
// JSON line. Replaceable, so tests never start an agent (`AcpQueries.layerTest`). The live layer is
// `agents/acp/AcpQueriesLive.ts`.

/** The agent couldn't be asked: it isn't installed, isn't signed in, didn't start, or didn't answer in time. */
export class AcpUnavailable extends Schema.TaggedError<AcpUnavailable, { readonly brand: unique symbol }>()("AcpUnavailable", {
  reason: Schema.String,
}) {}

/** What `acp-run --list-models` prints: the agent's models, the one it runs now, and the efforts it offers. */
export const ModelListing = Schema.Struct({
  models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.NullOr(Schema.String) })),
  current: Schema.NullOr(Schema.String),
  efforts: Schema.Array(Schema.String),
  default_effort: Schema.NullOr(Schema.String),
})
export type ModelListing = typeof ModelListing.Type

const decodeListing = Schema.decodeUnknownOption(Schema.fromJsonString(ModelListing))

/** The models in `acp-run --list-models`' output (its first line that reads), each with the agent's efforts; null if none reads. */
export const modelsFromListing = (stdout: string): ReadonlyArray<AgentModel> | null => {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    const listing = Option.getOrNull(decodeListing(line))
    if (listing === null) continue
    return listing.models.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      is_default: m.id === listing.current,
      efforts: listing.efforts,
      default_effort: listing.default_effort,
    }))
  }
  return null
}

/** What to say when `acp-run --list-models` exits 3: the agent needs a sign-in, which is the agent's own. */
export const signInReason = (command: string | null): string => {
  const { program } = commandLine(command)
  return program === DEFAULT_ACP_PROGRAM
    ? `Antigravity isn't signed in: sign in by running \`${DEFAULT_ACP_PROGRAM}\` once`
    : `${program} isn't signed in: sign in by running it once by itself`
}

export interface AcpQueriesShape {
  /** The models an ACP config `config` offers (cached 10 minutes per config). */
  readonly models: (config: AgentConfigRow) => Effect.Effect<ReadonlyArray<AgentModel>, AcpUnavailable>
  /** `configs.models` for config `id` if it is an ACP agent's; null for another agent's (whose models are Codex's to list, or none). */
  readonly configModels: (id: AgentConfigId) => Effect.Effect<ReadonlyArray<AgentModel> | null, AgentConfigNotFound | AcpUnavailable>
}

/** `configModels` over a layer's `models`. */
export const acpConfigModelsWith =
  (repo: AgentConfigRepo["Service"], models: AcpQueriesShape["models"]) =>
  (id: AgentConfigId): Effect.Effect<ReadonlyArray<AgentModel> | null, AgentConfigNotFound | AcpUnavailable> =>
    Effect.gen(function* () {
      const row = yield* repo.get(id)
      if (Option.isNone(row)) return yield* new AgentConfigNotFound({ id })
      if (row.value.agent !== "acp") return null
      return yield* models(row.value)
    })

/** What tests list as an ACP config's models, or why they can't be listed. */
export class AcpModelsScript extends Context.Service<
  AcpModelsScript,
  {
    readonly get: Effect.Effect<ReadonlyArray<AgentModel>, AcpUnavailable>
    /** The models to list, or why they can't be. */
    readonly set: (models: Result.Result<ReadonlyArray<AgentModel>, AcpUnavailable>) => Effect.Effect<void>
  }
>()("huntaway-server/agents/AcpQueries/AcpModelsScript") {}

/** A read-only server's answer: it starts no agent. */
const noAgent = () => Effect.fail(new AcpUnavailable({ reason: "a read-only server starts no agent" }))

export class AcpQueries extends Context.Service<AcpQueries, AcpQueriesShape>()("huntaway-server/agents/AcpQueries") {
  /** A read-only server's: no agent is started, so an ACP config's models are unavailable. */
  static readonly readOnly = Layer.effect(
    AcpQueries,
    Effect.gen(function* () {
      const repo = yield* AgentConfigRepo
      return AcpQueries.of({ models: noAgent, configModels: acpConfigModelsWith(repo, noAgent) })
    }),
  )

  /** For tests: the models `AcpModelsScript` sets (none at first). */
  static readonly layerTest = Layer.effect(
    AcpQueries,
    Effect.gen(function* () {
      const script = yield* AcpModelsScript
      const repo = yield* AgentConfigRepo
      return AcpQueries.of({ models: () => script.get, configModels: acpConfigModelsWith(repo, () => script.get) })
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        AcpModelsScript,
        Effect.map(Ref.make<Result.Result<ReadonlyArray<AgentModel>, AcpUnavailable>>(Result.succeed([])), (ref) =>
          AcpModelsScript.of({ get: Effect.flatMap(Ref.get(ref), Effect.fromResult), set: (v) => Ref.set(ref, v) }),
        ),
      ),
    ),
  )
}
