import { Context, Deferred, Effect, Exit, Layer, Option, Redacted, Ref, Result, Schema } from "effect"
import type { Agent } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { CodexQueries } from "./CodexQueries.ts"
import { claudeCallEnv } from "./configEnv.ts"
import type { Spent } from "./tokens/calls.ts"
import { spentFromClaude } from "./tokens/calls.ts"
import { field } from "./tokens/counts.ts"

// The model call behind task titles (huntaway's agent/title.ts `call_model`): Haiku through `claude -p`, with the
// task's config, away from its repository. Replaceable, so tests never call a model (`TitleModel.layerScripted`).

/** What a call gave: its reply as it is (not yet cleaned to a title), or why it failed; and what it used, when it says, failed or not. */
export interface TitleAnswer {
  readonly reply: Result.Result<string, string>
  readonly spent: Spent | null
}

export interface TitleModelShape {
  /** Ask the model of `config` (none: Claude Code's default folder) for a reply to `input` under `system`. */
  readonly ask: (config: AgentConfigRow | null, system: string, input: string) => Effect.Effect<TitleAnswer>
}

/** How long a title may take. */
export const TITLE_TIMEOUT = "60 seconds"

const ResultJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// ---- the script tests answer from -------------------------------------------------------------------------------

/** A reply for a coming call: given once `gate` (if any) is done; `took` (if any) is done as a call takes it. */
interface Queued {
  readonly reply: string
  readonly gate: Deferred.Deferred<void> | null
  readonly took: Deferred.Deferred<void> | null
}

interface ScriptState {
  /** The reply when no queued one is left; null fails the call. */
  readonly reply: string | null
  /** Replies for the next calls, in turn, before `reply`: each once its gate (if any) opens. */
  readonly queued: ReadonlyArray<Queued>
  /** What each call was asked (its input). */
  readonly asked: ReadonlyArray<string>
  /** The agent each call would have gone to. */
  readonly runtimes: ReadonlyArray<Agent>
  /** What each call says it used. */
  readonly spent: Spent | null
}

export interface TitleScriptShape {
  readonly ask: TitleModelShape["ask"]
  /** The reply once the queued ones are used up; null makes calls fail. */
  readonly setReply: (reply: string | null) => Effect.Effect<void>
  /** A reply for a coming call, given once `gate` (if any) is done; `took` (if any) is done as a call takes it. */
  readonly push: (reply: string, options?: { readonly gate?: Deferred.Deferred<void>; readonly took?: Deferred.Deferred<void> }) => Effect.Effect<void>
  readonly setSpent: (spent: Spent | null) => Effect.Effect<void>
  readonly asked: Effect.Effect<ReadonlyArray<string>>
  readonly runtimes: Effect.Effect<ReadonlyArray<Agent>>
}

/** Stands in for the model in tests (the old `title.TEST`): what it is asked, and what it replies. */
export class TitleScript extends Context.Service<TitleScript, TitleScriptShape>()("huntaway-server/agents/TitleModel/TitleScript") {}

const makeScript = Effect.gen(function* () {
  const state = yield* Ref.make<ScriptState>({ reply: null, queued: [], asked: [], runtimes: [], spent: null })
  const ask = (cfg: AgentConfigRow | null, _system: string, input: string) =>
    Effect.gen(function* () {
      const s = yield* Ref.modify(state, (now): readonly [ScriptState, ScriptState] => {
        const next = { ...now, queued: now.queued.slice(1), asked: [...now.asked, input], runtimes: [...now.runtimes, cfg?.agent ?? "claude"] }
        return [now, next]
      })
      const queued = s.queued[0]
      if (queued !== undefined) {
        if (queued.took !== null) yield* Deferred.done(queued.took, Exit.void)
        if (queued.gate !== null) yield* Deferred.await(queued.gate)
        return { reply: Result.succeed(queued.reply), spent: s.spent } satisfies TitleAnswer
      }
      return { reply: s.reply === null ? Result.fail("no title in tests") : Result.succeed(s.reply), spent: s.spent } satisfies TitleAnswer
    })
  return TitleScript.of({
    ask,
    setReply: (reply) => Ref.update(state, (s) => ({ ...s, reply })),
    push: (reply, options = {}) =>
      Ref.update(state, (s) => ({ ...s, queued: [...s.queued, { reply, gate: options.gate ?? null, took: options.took ?? null }] })),
    setSpent: (spent) => Ref.update(state, (s) => ({ ...s, spent })),
    asked: Effect.map(Ref.get(state), (s) => s.asked),
    runtimes: Effect.map(Ref.get(state), (s) => s.runtimes),
  })
})

export class TitleModel extends Context.Service<TitleModel, TitleModelShape>()("huntaway-server/agents/TitleModel") {
  /**
   * `claude -p --model haiku --output-format json` with no tools, no MCP servers, no session kept and no slash commands,
   * the input on stdin, in the data folder, with the config's folder and proxy; killed after 60 seconds. A Codex config's
   * title is its cheapest model's, in an ephemeral thread (`CodexQueries.title`, 5.3).
   */
  static readonly layer = Layer.effect(
    TitleModel,
    Effect.gen(function* () {
      const proc = yield* Proc
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const configs = yield* AgentConfigRepo
      const codex = yield* CodexQueries

      const ask = Effect.fn("TitleModel.ask")(function* (cfg: AgentConfigRow | null, system: string, input: string) {
        // A Codex config's title comes from its own cheapest model (5.3).
        if (cfg !== null && cfg.agent === "codex") return yield* codex.title(cfg, dataDir.root, system, input)
        const args = ["-p", "--model", "haiku", "--output-format", "json", "--tools", "", "--strict-mcp-config"]
        args.push("--no-session-persistence", "--disable-slash-commands", "--system-prompt", system)
        const apiKey = cfg === null ? null : (yield* configs.keys(cfg.id)).api_key
        const env = { ...config.agentEnv, ...(cfg === null ? {} : claudeCallEnv(cfg, apiKey === null ? null : Redacted.value(apiKey), config.home)) }
        const run = yield* proc.run(config.claudeBin, args, { cwd: dataDir.root, env, stdin: input, timeout: TITLE_TIMEOUT }).pipe(Effect.result)
        if (Result.isFailure(run)) return { reply: Result.fail(run.failure.reason), spent: null } satisfies TitleAnswer
        const out = run.success
        // Its `result`, with the title and the tokens it took.
        const parsed = ResultJson(out.stdout)
        const result = Option.isSome(parsed) && field(parsed.value, "type") === "result" ? parsed.value : null
        const spent = result === null ? null : spentFromClaude(result)
        const failed = (reason: string): TitleAnswer => ({ reply: Result.fail(reason), spent })
        if (out.code !== 0) return failed(`claude exited with exit status: ${out.code}: ${out.stderr.trim()}`)
        if (result === null) return failed("claude's reply isn't a result")
        const text = field(result, "result")
        if (field(result, "is_error") === true) return failed(`claude failed: ${typeof text === "string" ? text : ""}`)
        return { reply: Result.succeed(typeof text === "string" ? text : ""), spent } satisfies TitleAnswer
      })

      return TitleModel.of({ ask })
    }),
  )

  /** For tests: a model that answers from `TitleScript`. */
  static readonly layerScripted = Layer.effect(
    TitleModel,
    Effect.map(Effect.service(TitleScript), (script) => TitleModel.of({ ask: script.ask })),
  ).pipe(Layer.provideMerge(Layer.effect(TitleScript, makeScript)))
}
