import { Context, Effect, Layer, Ref, Result, Schema } from "effect"
import type { UsageLimit } from "@huntaway/contracts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import type { CodexModel, CodexSkill } from "./codex/queries.ts"
import type { TitleAnswer } from "./TitleModel.ts"

// One-off questions to Codex (huntaway's agent/codex/queries.ts; inventory 01 §2 Housekeeping, inventory 02): a
// config's models (cached 10 minutes), its skills in a folder (a minute), its account's plan and rate limits, and a
// task's title, each asked of a short-lived `codex app-server` with the config's `CODEX_HOME`. Replaceable, so tests
// never start a Codex (`CodexQueries.layerTest`). The live layer is `agents/codex/CodexQueriesLive.ts`.

/** Codex couldn't be asked: it isn't installed, didn't start, or didn't answer in time. */
export class CodexUnavailable extends Schema.TaggedError<CodexUnavailable, { readonly brand: unique symbol }>()("CodexUnavailable", {
  reason: Schema.String,
}) {}

export interface CodexRateLimits {
  /** The account's plan (`planType`). */
  readonly plan: string | null
  readonly limits: ReadonlyArray<UsageLimit>
}

export interface CodexQueriesShape {
  /** The models config `config` can use. */
  readonly models: (config: AgentConfigRow) => Effect.Effect<ReadonlyArray<CodexModel>, CodexUnavailable>
  /** The skills config `config` has in folder `cwd` (none: its own). */
  readonly skills: (config: AgentConfigRow, cwd: string | null) => Effect.Effect<ReadonlyArray<CodexSkill>, CodexUnavailable>
  /** The config's account's plan and rate limits. */
  readonly rateLimits: (config: AgentConfigRow) => Effect.Effect<CodexRateLimits, CodexUnavailable>
  /** A reply to `input` under `instructions` from the config's cheapest model, in an ephemeral thread with no tools, in `cwd`. */
  readonly title: (config: AgentConfigRow, cwd: string, instructions: string, input: string) => Effect.Effect<TitleAnswer>
}

/** What tests list as a Codex config's models (the old `set_test_models`). */
export class CodexModelsScript extends Context.Service<
  CodexModelsScript,
  {
    readonly get: Effect.Effect<ReadonlyArray<CodexModel>>
    readonly set: (models: ReadonlyArray<CodexModel>) => Effect.Effect<void>
  }
>()("huntaway-server/agents/CodexQueries/CodexModelsScript") {}

export class CodexQueries extends Context.Service<CodexQueries, CodexQueriesShape>()("huntaway-server/agents/CodexQueries") {
  /** For tests: the models given (settable through `CodexModelsScript`), no skills, no rate limits, no titles. */
  static readonly layerTest = Layer.effect(
    CodexQueries,
    Effect.gen(function* () {
      const script = yield* CodexModelsScript
      return CodexQueries.of({
        models: () => script.get,
        skills: () => Effect.succeed([]),
        rateLimits: () => Effect.fail(new CodexUnavailable({ reason: "no Codex in tests" })),
        title: () => Effect.succeed({ reply: Result.fail("no Codex titles in tests"), spent: null } satisfies TitleAnswer),
      })
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        CodexModelsScript,
        Effect.map(Ref.make<ReadonlyArray<CodexModel>>([]), (models) => CodexModelsScript.of({ get: Ref.get(models), set: (list) => Ref.set(models, list) })),
      ),
    ),
  )
}
