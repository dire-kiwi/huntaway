import { Clock, Effect, Layer, Ref, Result } from "effect"
import type { Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ServerConfig, VERSION } from "../../platform/ServerConfig.ts"
import type { AgentConfigRow } from "../../profiles/AgentConfigRepo.ts"
import { CodexQueries, CodexUnavailable } from "../CodexQueries.ts"
import { configDir } from "../configEnv.ts"
import type { TitleAnswer } from "../TitleModel.ts"
import type { Spent } from "../tokens/calls.ts"
import { spentFromCodex } from "../tokens/calls.ts"
import { field, strField } from "./items.ts"
import { parseModels, parseSkills, planType, rateLimits, titleModel } from "./queries.ts"
import type { CodexModel, CodexSkill } from "./queries.ts"
import { appServer, errorText } from "./rpc.ts"
import type { AppServer, AppServerError } from "./rpc.ts"

// `CodexQueries` against the real `codex app-server` (huntaway's agent/codex/queries.ts): each question is a
// short-lived app-server with the config's `CODEX_HOME`, killed when it has answered or after 20 seconds (60 for a
// title). The models are cached for 10 minutes and the skills for a minute, per config folder (and folder asked about),
// in memory: lost on a restart, as before.

/** How long the models and the skills are kept. */
const MODELS_FOR_MS = 600_000
const SKILLS_FOR_MS = 60_000
const QUERY_TIMEOUT = "20 seconds"
const TITLE_TIMEOUT = "60 seconds"

interface Cached<A> {
  readonly at: number
  readonly value: A
}

export const CodexQueriesLive = Layer.effect(
  CodexQueries,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const models = yield* Ref.make<ReadonlyMap<string, Cached<ReadonlyArray<CodexModel>>>>(new Map())
    const skills = yield* Ref.make<ReadonlyMap<string, Cached<ReadonlyArray<CodexSkill>>>>(new Map())

    const homeOf = (cfg: AgentConfigRow) => configDir(cfg, config.home)

    /** An app-server for `cfg`, in `cwd`, for as long as the scope lasts, its handshake done. */
    const start = (cfg: AgentConfigRow, cwd: string): Effect.Effect<AppServer, AppServerError, Scope.Scope> =>
      Effect.gen(function* () {
        const server = yield* appServer({
          program: config.codexBin,
          cwd,
          env: { ...config.agentEnv, CODEX_HOME: homeOf(cfg) },
          stderr: "ignore",
        })
        yield* server.initialize(config.version || VERSION)
        return server
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

    /** `work` against a short-lived app-server, given up after `QUERY_TIMEOUT`. */
    const query = <A>(cfg: AgentConfigRow, work: (server: AppServer) => Effect.Effect<A, AppServerError>) =>
      Effect.scoped(Effect.flatMap(start(cfg, config.tmpDir), work)).pipe(
        Effect.timeoutOrElse({
          duration: QUERY_TIMEOUT,
          orElse: () => Effect.fail(new CodexUnavailable({ reason: "codex app-server didn't answer" })),
        }),
        Effect.mapError((e) => (e._tag === "CodexUnavailable" ? e : new CodexUnavailable({ reason: errorText(e) }))),
      )

    /** A fresh cache entry, if there is one. */
    const fresh = <A>(cache: Ref.Ref<ReadonlyMap<string, Cached<A>>>, key: string, forMs: number) =>
      Effect.gen(function* () {
        const hit = (yield* Ref.get(cache)).get(key)
        const now = yield* Clock.currentTimeMillis
        return hit !== undefined && now - hit.at < forMs ? hit.value : null
      })
    const keep = <A>(cache: Ref.Ref<ReadonlyMap<string, Cached<A>>>, key: string, value: A) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.update(cache, (all) => new Map([...all, [key, { at, value }]])))

    /** The models of `cfg` in a reply to `model/list`, kept. */
    const saveModels = Effect.fnUntraced(function* (cfg: AgentConfigRow, reply: unknown) {
      const list = parseModels(reply)
      yield* keep(models, homeOf(cfg), list)
      return list
    })

    const listModels = Effect.fn("CodexQueries.models")(function* (cfg: AgentConfigRow) {
      const hit = yield* fresh(models, homeOf(cfg), MODELS_FOR_MS)
      if (hit !== null) return hit
      const reply = yield* query(cfg, (server) => server.request("model/list", {}))
      return yield* saveModels(cfg, reply)
    })

    const listSkills = Effect.fn("CodexQueries.skills")(function* (cfg: AgentConfigRow, cwd: string | null) {
      const key = `${homeOf(cfg)}\0${cwd ?? ""}`
      const hit = yield* fresh(skills, key, SKILLS_FOR_MS)
      if (hit !== null) return hit
      const reply = yield* query(cfg, (server) => server.request("skills/list", { cwds: cwd === null ? [] : [cwd] }))
      const list = parseSkills(reply)
      yield* keep(skills, key, list)
      return list
    })

    const readLimits = Effect.fn("CodexQueries.rateLimits")(function* (cfg: AgentConfigRow) {
      const reply = yield* query(cfg, (server) => server.request("account/rateLimits/read", null))
      const rl = field(reply, "rateLimits")
      return { plan: planType(rl), limits: rateLimits(rl) }
    })

    /** A title: a cheap model, at low effort, in an ephemeral thread with no tools and none of the user's MCP servers. */
    const writeTitle = (cfg: AgentConfigRow, cwd: string, instructions: string, input: string, spent: Ref.Ref<Spent | null>) =>
      Effect.gen(function* () {
        const server = yield* start(cfg, cwd)
        // Config overrides merge maps, so an empty map alone would keep the user's servers.
        const read = yield* server.request("config/read", { includeLayers: false, cwd })
        const cached = yield* fresh(models, homeOf(cfg), MODELS_FOR_MS)
        const list =
          cached ??
          (yield* server.request("model/list", {}).pipe(
            Effect.flatMap((reply) => saveModels(cfg, reply)),
            Effect.catch((e) => Effect.logWarning(`codex: listing models for a title: ${errorText(e)}`).pipe(Effect.as([]))),
          ))
        const pick = titleModel(list)
        const have = field(field(read, "config"), "mcp_servers")
        const servers = Object.fromEntries(Object.keys(have !== null && typeof have === "object" ? have : {}).map((name) => [name, { enabled: false }]))
        const started = yield* server.request("thread/start", {
          cwd,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: instructions,
          developerInstructions: "",
          ...(pick.model === null ? {} : { model: pick.model }),
          config: {
            mcp_servers: servers,
            project_doc_max_bytes: 0,
            web_search: "disabled",
            "features.shell_tool": false,
            "features.apply_patch_freeform": false,
            "features.multi_agent": false,
            "features.apps": false,
          },
        })
        const thread = strField(field(started, "thread"), "id")
        if (thread === null) return Result.fail("no title thread id")
        const m = strField(started, "model")
        const model = m !== null && m !== "" ? m : "codex"
        yield* server.request("turn/start", { threadId: thread, effort: pick.effort, input: [{ type: "text", text: input, text_elements: [] }] })
        let title = ""
        while (true) {
          const msg = yield* server.next
          if (msg === null) return Result.fail("codex app-server exited before writing a title")
          // A title never needs tools or approvals.
          if ("id" in msg) {
            yield* server.respondError(msg["id"], "Tools are unavailable while writing a task title")
            continue
          }
          const p = msg["params"]
          if (strField(p, "threadId") !== thread) continue
          const method = msg["method"]
          // Its thread's totals so far: Codex sends the last of them just before `turn/completed`.
          if (method === "thread/tokenUsage/updated") yield* Ref.set(spent, spentFromCodex(model, field(p, "tokenUsage")))
          else if (method === "item/completed" && strField(field(p, "item"), "type") === "agentMessage") title = strField(field(p, "item"), "text") ?? ""
          else if (method === "turn/completed") {
            const turn = field(p, "turn")
            return strField(turn, "status") === "completed" ? Result.succeed(title) : Result.fail("codex title turn failed")
          }
        }
      }).pipe(Effect.scoped)

    const title = Effect.fn("CodexQueries.title")(function* (cfg: AgentConfigRow, cwd: string, instructions: string, input: string) {
      const spent = yield* Ref.make<Spent | null>(null)
      const reply = yield* writeTitle(cfg, cwd, instructions, input, spent).pipe(
        Effect.timeoutOrElse({ duration: TITLE_TIMEOUT, orElse: () => Effect.succeed(Result.fail("codex title timed out: deadline has elapsed")) }),
        Effect.catch((e) => Effect.succeed(Result.fail(errorText(e)))),
      )
      const answer: TitleAnswer = { reply, spent: yield* Ref.get(spent) }
      return answer
    })

    return CodexQueries.of({ models: listModels, skills: listSkills, rateLimits: readLimits, title })
  }),
)
