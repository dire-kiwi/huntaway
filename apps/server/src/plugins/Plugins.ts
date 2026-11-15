import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { Forbidden, NotFound, PluginFailed } from "@huntaway/contracts"
import type { PluginInfo, PluginPage, PluginPageRequest, RunId, SessionShape } from "@huntaway/contracts"
import { PluginError, pluginIdProblem } from "@huntaway/plugin"
import type { Plugin, PluginParts, PluginRoute, PluginSession, PluginTool, RunContext } from "@huntaway/plugin"
import { McpServers } from "../mcp/McpServers.ts"
import type { RegisteredTool } from "../mcp/McpServers.ts"
import { ownThread, ToolError, toolArguments } from "../mcp/tool.ts"
import type { LocalCaller } from "../mcp/tool.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { asProfile, asProject, asTask, makeHosts } from "./host.ts"
import { InstalledPlugins } from "./InstalledPlugins.ts"
import { IMPORTABLE, start, startMessage } from "./start.ts"

// HE-34: the plugins this host runs (docs/plan/15-plugins.md). Built once as the server starts, in the order they are
// installed: each one's database, migrations and `make` (`start.ts`), then its MCP server defined with `McpServers`
// (its tools wrapped as the board's are, so `ToolCalls` runs them). A plugin that fails to start is kept with its
// error, and has none of its parts. Its pages, calls and routes are reached through here.

/** The largest MCP request a plugin's server takes unless it says otherwise. */
export const PLUGIN_BODY_LIMIT = 32 * 1024 * 1024

/** A plugin as this host has it: its parts, or why it has none. */
interface Loaded {
  readonly plugin: Plugin
  readonly parts: PluginParts | null
  readonly error: string | null
}

const failed = (plugin: string) => (e: PluginError) => new PluginFailed({ plugin, reason: e.reason, message: e.message })

/** A session as a plugin sees it. */
export const pluginSession = (s: SessionShape): PluginSession => ({ kind: s.kind, device_id: s.device_id, scopes: [...s.scopes] })

const info = (l: Loaded): PluginInfo => ({
  id: l.plugin.id,
  name: l.plugin.name,
  version: l.plugin.version,
  description: l.plugin.description ?? null,
  nav: l.parts?.pages?.nav === undefined ? null : { title: l.parts.pages.nav.title },
  settings: l.parts?.pages?.settings === undefined ? null : { title: l.parts.pages.settings.title },
  task: l.parts?.pages?.task === true,
  mcp: l.parts?.mcp === undefined ? null : { tools: l.parts.mcp.tools.map((t) => t.tool.name) },
  error: l.error,
})

export interface PluginsShape {
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  /** One of a plugin's pages for a session (`plugins.page`). */
  readonly page: (request: PluginPageRequest, session: SessionShape) => Effect.Effect<PluginPage, NotFound | PluginFailed>
  /** One of a plugin's calls for a session (`plugins.call`), refused when the session lacks the method's scope. */
  readonly call: (plugin: string, method: string, payload: unknown, session: SessionShape) => Effect.Effect<unknown, NotFound | Forbidden | PluginFailed>
  /** Every started plugin's HTTP routes, with its id. */
  readonly routes: ReadonlyArray<{ readonly plugin: string; readonly route: PluginRoute }>
}

export class Plugins extends Context.Service<Plugins, PluginsShape>()("huntaway-server/plugins/Plugins") {
  static readonly layer = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const { plugins } = yield* InstalledPlugins
      const dataDir = yield* DataDir
      const db = yield* Db
      const servers = yield* McpServers
      const runs = yield* RunRepo
      const tasks = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const projects = yield* ProjectRepo
      const host = yield* makeHosts

      /** Reading a table the board lists for the plugin (`IMPORTABLE`), for its migrations. */
      const importer = (plugin: string) => {
        const tables = IMPORTABLE[plugin] ?? []
        return {
          tables,
          rows: (table: string) =>
            tables.includes(table)
              ? db.sql.unsafe<Readonly<Record<string, unknown>>>(`SELECT * FROM "${table}"`).pipe(Effect.orDie)
              : Effect.fail(PluginError.notFound(`the board has no table ${table} for plugin ${plugin} to copy`)),
        }
      }

      /** What a plugin is told of the run an agent's call or `initialize` came from. */
      const contextOf = Effect.fnUntraced(function* (caller: LocalCaller) {
        const project = caller.task.project_id === null ? Option.none() : yield* projects.get(caller.task.project_id)
        const out: RunContext = {
          run_id: caller.run.id,
          task: asTask(caller.task),
          project: Option.getOrNull(Option.map(project, asProject)),
          profile: { id: caller.task.profile_id, name: caller.profile.name },
          review: caller.task.kind === "review",
        }
        return out
      })
      const contextOfRun = Effect.fnUntraced(function* (id: RunId) {
        const run = Option.getOrUndefined(yield* runs.get(id))
        const task = run === undefined ? null : yield* tasks.get(run.task_id)
        if (run === undefined || task === null) return null
        const profile = Option.getOrUndefined(yield* profiles.get(task.profile_id))
        if (profile === undefined) return null
        const project = task.project_id === null ? Option.none() : yield* projects.get(task.project_id)
        const out: RunContext = {
          run_id: run.id,
          task: asTask(task),
          project: Option.getOrNull(Option.map(project, asProject)),
          profile: asProfile(profile),
          review: task.kind === "review",
        }
        return out
      })

      /** A plugin's tool as the board runs it: for an agent on this host, if its run is offered it. */
      const registered = (t: PluginTool): RegisteredTool => ({
        tool: t.tool,
        args: toolArguments(t.tool),
        run: (args, caller) =>
          Effect.gen(function* () {
            const run = yield* contextOf(yield* ownThread(caller, t.tool.name))
            if (t.offer !== undefined && !(yield* t.offer(run))) return yield* ToolError.other(`${t.tool.name} isn't offered to this run`)
            return yield* t.run(args, { ...run, call_id: caller.call_id }).pipe(Effect.mapError((e) => ToolError.other(e.message)))
          }),
      })

      const defineServer = Effect.fnUntraced(function* (plugin: Plugin, parts: PluginParts) {
        const mcp = parts.mcp
        if (mcp === undefined) return
        const byName = new Map(mcp.tools.map((t) => [t.tool.name, t]))
        const instructions = mcp.instructions
        yield* servers.define(plugin.id, {
          title: plugin.id,
          instructions: (run) =>
            typeof instructions !== "function"
              ? Effect.succeed(instructions ?? null)
              : Effect.flatMap(contextOfRun(run), (c) => (c === null ? Effect.succeed(null) : instructions(c))),
          offers: (run, name) => {
            const offer = byName.get(name)?.offer
            return offer === undefined ? Effect.succeed(true) : Effect.flatMap(contextOfRun(run), (c) => (c === null ? Effect.succeed(false) : offer(c)))
          },
          preApproved: mcp.preApproved === true,
          maxRequestBytes: mcp.maxRequestBytes ?? PLUGIN_BODY_LIMIT,
        })
        yield* servers.add(plugin.id, mcp.tools.map(registered))
      })

      const loaded: Array<Loaded> = []
      for (const plugin of plugins) {
        const problem = pluginIdProblem(plugin.id) ?? (loaded.some((l) => l.plugin.id === plugin.id) ? `another plugin is called ${plugin.id}` : null)
        if (problem !== null) {
          yield* Effect.logError(`plugin ${plugin.id} isn't started: ${problem}`)
          loaded.push({ plugin, parts: null, error: problem })
          continue
        }
        const exit = yield* Effect.exit(start(plugin, { root: dataDir.root, host, importer }))
        if (Exit.isFailure(exit)) {
          const error = Option.match(Cause.findErrorOption(exit.cause), {
            onNone: () => Cause.pretty(exit.cause).split("\n")[0] ?? "it failed",
            onSome: startMessage,
          })
          yield* Effect.logError(`plugin ${plugin.id} failed to start: ${error}`, exit.cause)
          loaded.push({ plugin, parts: null, error })
          continue
        }
        yield* defineServer(plugin, exit.value)
        loaded.push({ plugin, parts: exit.value, error: null })
        yield* Effect.logInfo(`plugin ${plugin.id} ${plugin.version} started`)
      }

      const started = (id: string) => loaded.find((l) => l.plugin.id === id && l.parts !== null)?.parts ?? null

      return Plugins.of({
        list: Effect.succeed(loaded.map(info)),
        page: Effect.fn("Plugins.page")(function* (request, session) {
          const pages = started(request.plugin)?.pages
          const slotted =
            pages !== undefined &&
            (request.slot === "page" || (request.slot === "settings" && pages.settings !== undefined) || (request.slot === "task" && pages.task === true))
          if (pages === undefined || !slotted) return yield* new NotFound({ what: "plugin page", id: `${request.plugin}/${request.slot}` })
          const result = yield* pages
            .render({ slot: request.slot, path: request.path, query: request.query, task_id: request.task_id, session: pluginSession(session) })
            .pipe(Effect.mapError(failed(request.plugin)))
          const page: PluginPage =
            result._tag === "Redirect" ? { type: "redirect", path: result.path } : { type: "html", title: result.title, html: result.html, empty: result.empty }
          return page
        }),
        call: Effect.fn("Plugins.call")(function* (plugin, method, payload, session) {
          const calls = started(plugin)?.calls
          const call = calls === undefined || !Object.hasOwn(calls, method) ? undefined : calls[method]
          if (call === undefined) return yield* new NotFound({ what: "plugin call", id: `${plugin}.${method}` })
          if (!session.scopes.has(call.scope)) return yield* new Forbidden({ scope: call.scope })
          return yield* call.run(payload, pluginSession(session)).pipe(Effect.mapError(failed(plugin)))
        }),
        routes: loaded.flatMap((l) => (l.parts?.routes ?? []).map((route) => ({ plugin: l.plugin.id, route }))),
      })
    }),
  )
}
