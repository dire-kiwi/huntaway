import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import type { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import {
  ApprovalRulesRpcs,
  AttachmentRpcs,
  BoardRpcs,
  ConfigRpcs,
  HostRpcGroup,
  HubHostRpcs,
  LinkRpcs,
  PenRpcs,
  PermissionRpcs,
  ProfileRpcs,
  ProjectRpcs,
  PublicRpcs,
  SettingsSyncRpcs,
  TaskRpcs,
  ThreadRpcs,
} from "@huntaway/contracts"
import { ApprovalRules } from "./agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "./agents/ApprovalRulesRepo.ts"
import { ContextMeter } from "./agents/ContextMeter.ts"
import { ContextStatsRepo } from "./agents/ContextStatsRepo.ts"
import { Prompts } from "./agents/Prompts.ts"
import { SideCalls } from "./agents/SideCalls.ts"
import { TitleModel } from "./agents/TitleModel.ts"
import { Titles } from "./agents/Titles.ts"
import { TokenRepo } from "./agents/TokenRepo.ts"
import { Tokens } from "./agents/Tokens.ts"
import { UsageWindow } from "./agents/UsageWindow.ts"
import { WindowPrompt } from "./agents/WindowPrompt.ts"
import { LinkConnections } from "./hosts/LinkConnections.ts"
import { LinkRepo } from "./hosts/LinkRepo.ts"
import { Links } from "./hosts/Links.ts"
import { Relay } from "./hosts/Relay.ts"
import { SessionSeal } from "./hosts/SessionSeal.ts"
import { SettingsSync } from "./hosts/SettingsSync.ts"
import { SettingsSyncExchange } from "./hosts/SettingsSyncExchange.ts"
import { SettingsSyncRepo } from "./hosts/SettingsSyncRepo.ts"
import { RelayRoute } from "./http/relay.ts"
import { ApiNotFound, BodyLimit, HealthRoute, StaticUi } from "./http/routes.ts"
import { Backup } from "./platform/Backup.ts"
import { Changes } from "./platform/Changes.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Db } from "./platform/Db.ts"
import { Events } from "./platform/Events.ts"
import { Identity } from "./platform/Identity.ts"
import { KeyedLock } from "./platform/KeyedLock.ts"
import { Migrations } from "./platform/Migrations.ts"
import { Proc } from "./platform/Proc.ts"
import type { ServerConfig } from "./platform/ServerConfig.ts"
import { Board } from "./lifecycle/Board.ts"
import { DemoLive } from "./lifecycle/Demo.ts"
import { Reactor } from "./lifecycle/Reactor.ts"
import { McpCallRepo } from "./mcp/McpCallRepo.ts"
import { askRuleWith, cancelledWith, McpHooks } from "./mcp/McpHooks.ts"
import { McpServers } from "./mcp/McpServers.ts"
import { ToolCalls } from "./mcp/ToolCalls.ts"
import { Wait } from "./mcp/Wait.ts"
import { CommandApproval } from "./mcp/wait/CommandApproval.ts"
import { McpControlLive, McpControlRegistered } from "./mcp/transport/control.ts"
import { McpHttpRoute } from "./mcp/transport/http.ts"
import { BoardTools } from "./mcp/tools/board.ts"
import { Approvals } from "./permissions/Approvals.ts"
import { PermissionRepo } from "./permissions/PermissionRepo.ts"
import { Permissions } from "./permissions/Permissions.ts"
import { Questions } from "./permissions/Questions.ts"
import { RecoveryLive } from "./lifecycle/Recovery.ts"
import { DevServers } from "./runs/DevServers.ts"
import { AgentRequests } from "./runs/AgentRequests.ts"
import { ClaudeOutput } from "./runs/claude/output.ts"
import { LaunchFacts } from "./runs/LaunchFacts.ts"
import { RunDir } from "./runs/RunDir.ts"
import { RunFollower } from "./runs/RunFollower.ts"
import type { RunOutput } from "./runs/RunOutput.ts"
import { RunInput } from "./runs/RunInput.ts"
import { RunRepo } from "./runs/RunRepo.ts"
import { BackgroundWork } from "./runs/BackgroundWork.ts"
import { Compaction } from "./runs/Compaction.ts"
import { RunEnds } from "./runs/RunEnds.ts"
import { Runs } from "./runs/Runs.ts"
import { RunWaits } from "./runs/RunWaits.ts"
import { Shim } from "./runs/Shim.ts"
import { AgentConfigRepo } from "./profiles/AgentConfigRepo.ts"
import { AgentConfigs } from "./profiles/AgentConfigs.ts"
import { ProfileRepo } from "./profiles/ProfileRepo.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { Usage } from "./profiles/Usage.ts"
import { ProjectRepo } from "./projects/ProjectRepo.ts"
import { Projects } from "./projects/Projects.ts"
import { ApprovalRulesHandlers } from "./rpc/approvalRules.ts"
import { AttachmentHandlers } from "./rpc/attachments.ts"
import { AuthLive } from "./rpc/AuthLive.ts"
import { BoardHandlers } from "./rpc/board.ts"
import { HostHandlers } from "./rpc/host.ts"
import { HubHostHandlers } from "./rpc/hub.ts"
import { LinkHandlers } from "./rpc/link.ts"
import { PenHandlers } from "./rpc/pens.ts"
import { PermissionHandlers } from "./rpc/permissions.ts"
import { ConfigHandlers, ProfileHandlers } from "./rpc/profiles.ts"
import { ProjectHandlers } from "./rpc/projects.ts"
import { PublicHandlers } from "./rpc/public.ts"
import { SettingsSyncHandlers } from "./rpc/settingsSync.ts"
import { TaskHandlers } from "./rpc/tasks.ts"
import { ThreadHandlers } from "./rpc/threads.ts"
import { About } from "./settings/About.ts"
import { Folders } from "./settings/Folders.ts"
import { HostSettings } from "./settings/HostSettings.ts"
import { SettingsRepo } from "./settings/SettingsRepo.ts"
import { Attachments } from "./tasks/Attachments.ts"
import { Dependencies } from "./tasks/Dependencies.ts"
import { Leftovers } from "./tasks/Leftovers.ts"
import { PenRepo } from "./tasks/PenRepo.ts"
import { Pens } from "./tasks/Pens.ts"
import { TaskRefs } from "./tasks/TaskRefs.ts"
import { TaskTmp } from "./tasks/TaskTmp.ts"
import { TaskRepo } from "./tasks/TaskRepo.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { ThreadReaders } from "./threads/ThreadReaders.ts"
import { Threads } from "./threads/Threads.ts"
import { ThreadStore } from "./threads/ThreadStore.ts"

// The composition root (docs/plan/06-server.md, Startup): every layer, in startup order. Nothing else wires layers,
// so a test can replace any of them. An area adds its layer to its line below, in the dependency order of
// docs/plan/06-server.md; a transport adds its handlers and its group.

/**
 * Steps 1 and 2: the data folder, identity, the database brought up to date, and the HTTP client (`profiles/Usage`
 * reads Anthropic's usage endpoint). `db` is swapped for tests.
 */
export const platformLayer = <E, R>(db: Layer.Layer<Db | SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(Events.layer, Changes.layer, KeyedLock.layer, Proc.layer, Migrations.layer, FetchHttpClient.layer).pipe(
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(db),
    Layer.provideMerge(Identity.layer),
    Layer.provideMerge(DataDir.layer),
    Layer.provideMerge(Mac.layerWebCrypto),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  )

export const PlatformLive = platformLayer(Db.layer)

// Step 4: every area, bottom up. Each line provides the ones above it.
const SettingsLive = Layer.mergeAll(About.layer, HostSettings.layer, Folders.layer).pipe(Layer.provideMerge(SettingsRepo.layer))
const ProfilesLive = Profiles.ensureFromConfig.pipe(
  Layer.provideMerge(Layer.mergeAll(Profiles.layer, Usage.layer)),
  Layer.provideMerge(AgentConfigs.layer),
  Layer.provideMerge(Layer.mergeAll(ProfileRepo.layer, AgentConfigRepo.layer)),
  Layer.provideMerge(SettingsLive),
)
const ProjectsLive = Projects.layer.pipe(Layer.provideMerge(ProjectRepo.layer), Layer.provideMerge(ProfilesLive))
const TasksLive = Layer.mergeAll(Pens.layer, Attachments.pruner, TaskTmp.sweeper).pipe(
  Layer.provideMerge(Layer.mergeAll(Tasks.layer, TaskRefs.layer, Attachments.layer, TaskTmp.layer)),
  Layer.provideMerge(Layer.mergeAll(TaskRepo.layer, PenRepo.layer, Leftovers.layer, Dependencies.layer)),
  Layer.provideMerge(ProjectsLive),
)
const ThreadsLive = Threads.pruner.pipe(
  Layer.provideMerge(Layer.mergeAll(Threads.layer, ThreadReaders.layer)),
  Layer.provideMerge(ThreadStore.layer),
  Layer.provideMerge(TasksLive),
)
/** What asks a model besides runs: titles and window restarts. Tests give scripted ones, so no test calls a model. */
export interface ModelCalls<T, E1, R1, E2, R2> {
  /** `TitleModel`, and what a test drives it with (`TitleScript`). */
  readonly titles: Layer.Layer<TitleModel | T, E1, R1>
  readonly window: Layer.Layer<WindowPrompt, E2, R2>
}
/** The agents area over what is above it. */
const agentsLayer = <T, E1, R1, E2, R2>(models: ModelCalls<T, E1, R1, E2, R2>) =>
  UsageWindow.loop.pipe(
    Layer.provideMerge(Layer.mergeAll(ApprovalRules.layer, Prompts.layer, Tokens.layer, ContextMeter.layer, Titles.layer, UsageWindow.layer)),
    Layer.provideMerge(Layer.mergeAll(ApprovalRulesRepo.layer, TokenRepo.layer, ContextStatsRepo.layer, SideCalls.layer, models.titles, models.window)),
    Layer.provideMerge(ThreadsLive),
  )
/** The runs area over what is above it, with `output` handling runs' lines (tests give their own). */
export const runsLayer = <E, R>(output: Layer.Layer<RunOutput, E, R>) =>
  RunFollower.layer.pipe(Layer.provideMerge(output), Layer.provideMerge(Shim.layer), Layer.provideMerge(Layer.mergeAll(RunRepo.layer, RunDir.layer)))
/**
 * The runs area: the commands (`Runs`) and what a launch is made of, the follower with the Claude line handler, what
 * the server writes to a run's input, and the registry the areas below answer agents' requests through.
 */
const RunsArea = Runs.layer.pipe(
  Layer.provideMerge(LaunchFacts.layer),
  Layer.provideMerge(RunFollower.layer),
  Layer.provideMerge(ClaudeOutput),
  Layer.provideMerge(Layer.mergeAll(RunInput.layer, AgentRequests.layer, RunWaits.layer)),
  Layer.provideMerge(BackgroundWork.layer),
  Layer.provideMerge(Shim.layer),
  Layer.provideMerge(Layer.mergeAll(RunRepo.layer, RunDir.layer)),
)
/**
 * The board's MCP servers over what is above them, with `hooks` (tests give their own): the calls, the server on Claude
 * runs' files, and each area's tools (an area's `McpServers.register` layer joins the first line). Fresh, so that a
 * test's own, built over the whole board's services, is not the one those already have.
 */
export const mcpLayer = <E, R>(hooks: Layer.Layer<McpHooks, E, R>) =>
  McpControlRegistered.pipe(
    Layer.provideMerge(Layer.mergeAll(Layer.fresh(McpControlLive), BoardTools)),
    Layer.provideMerge(Layer.fresh(ToolCalls.layer)),
    Layer.provideMerge(Layer.mergeAll(Layer.fresh(McpServers.layer), McpCallRepo.layer, hooks)),
  )

/** The hosts area (docs/plan/08-hosts.md): the links, their connections, the relay, settings sync. */
const HostsLive = Layer.mergeAll(Links.layer, Relay.layer, SettingsSyncExchange.layer, SettingsSync.observer).pipe(
  Layer.provideMerge(Layer.mergeAll(LinkConnections.layer, SettingsSync.layer)),
  Layer.provideMerge(Layer.mergeAll(LinkRepo.layer, SessionSeal.layer, SettingsSyncRepo.layer)),
)

/**
 * The permissions area: prompts (with their sweeper, and Claude's `can_use_tool` requests registered), questions, and the
 * board's changes that always ask (with a deleted project's approvals expiring).
 */
const PermissionsLive = Layer.mergeAll(Permissions.sweeper, Permissions.registered, Questions.layer, Approvals.layer, Approvals.projectsDeleted).pipe(
  Layer.provideMerge(Permissions.layer),
  Layer.provideMerge(PermissionRepo.layer),
)

/**
 * What a board call needs of the areas built after `ToolCalls`' (`McpHooks`): `Wait`'s `callMade` (any call but `wait`
 * ends the run's wait), `Permissions`' `askRule` (an approval rule's ask is the user's), and both `cancelled` (a call
 * the agent gave up on has its wait end and its prompt expire). Tests that need neither build `mcpLayer(Wait.hooks)`.
 */
export const BoardHooks = Layer.effect(
  McpHooks,
  Effect.gen(function* () {
    const waits = yield* Wait
    const permissions = yield* Permissions
    const expire = cancelledWith(permissions)
    return McpHooks.of({
      callMade: waits.callMade,
      askRule: askRuleWith(permissions),
      cancelled: (run, call) => Effect.andThen(waits.cancelled(run, call), expire(run, call)),
    })
  }),
)

/** Every area's services, with `models` for the board's own model calls. */
export const areasLayer = <T, E1, R1, E2, R2>(models: ModelCalls<T, E1, R1, E2, R2>) =>
  // The demo board is seeded once every area is built, before Recovery runs.
  Layer.mergeAll(Reactor.layer, RecoveryLive, Board.layer).pipe(
    Layer.provideMerge(DemoLive),
    // Hosts: links, the relay, tools across hosts (M7).
    Layer.provideMerge(HostsLive),
    // The board's hooks: `Wait`'s and `Permissions`' (3.3) in one.
    Layer.provideMerge(mcpLayer(BoardHooks)),
    // The waits, and the approval of a wait's command (a `Bash` prompt, `Permissions`').
    Layer.provideMerge(Layer.mergeAll(Wait.layer, CommandApproval.layerPermissions)),
    Layer.provideMerge(PermissionsLive),
    // The end of a run, which the reactor calls: over the runs area and what a run's end tells (tokens, dev servers).
    Layer.provideMerge(RunEnds.layer),
    // DevServers reads tasks, which the runs area's own tests (`TestRuns`) don't build: it goes on top of the area.
    Layer.provideMerge(DevServers.layer),
    Layer.provideMerge(RunsArea),
    Layer.provideMerge(agentsLayer(models)),
  )

/** Every area's services. */
/**
 * The runs area's loops: tasks whose usage limit reset carry on (every 30 s), idle sessions are compacted (every
 * minute), the task's dev servers are looked for in `/proc` (every 4 s). Not in `areasLayer`, so a test board's clock
 * moves without them (a day on the test clock was 20,000 scans of the machine's `/proc`); tests run a pass themselves.
 */
export const RunLoops = Layer.mergeAll(Runs.limitResets, Compaction, DevServers.scanner)

/** Every area's services, and their loops. */
export const AreasLive = RunLoops.pipe(Layer.provideMerge(areasLayer({ titles: TitleModel.layer, window: WindowPrompt.layer })))

/** The groups served (`HostRpcs` once every area has its handlers). One line per area. */
export const Served = PublicRpcs.merge(
  HostRpcGroup,
  ProfileRpcs,
  ConfigRpcs,
  ProjectRpcs,
  TaskRpcs,
  BoardRpcs,
  PenRpcs,
  AttachmentRpcs,
  ApprovalRulesRpcs,
  ThreadRpcs,
  PermissionRpcs,
  HubHostRpcs,
  LinkRpcs,
  SettingsSyncRpcs,
)

/** Their handlers. One line per area. */
export const HandlersLive = Layer.mergeAll(
  PublicHandlers,
  HostHandlers,
  ProfileHandlers,
  ConfigHandlers,
  ProjectHandlers,
  TaskHandlers,
  BoardHandlers,
  PenHandlers,
  AttachmentHandlers,
  ApprovalRulesHandlers,
  ThreadHandlers,
  PermissionHandlers,
  HubHostHandlers,
  LinkHandlers,
  SettingsSyncHandlers,
).pipe(Layer.provideMerge(AuthLive))

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`. */
export const RpcLive = Layer.mergeAll(
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(HandlersLive), Layer.provide(RpcSerialization.layerNdjson))

/** The routes the server answers, `/api` first, then the UI. */
export const RoutesLive = Layer.mergeAll(RpcLive, HealthRoute, RelayRoute, McpHttpRoute, ApiNotFound, StaticUi, HttpRouter.cors({ maxAge: 86400 }), BodyLimit)

/**
 * The whole server. The listener binds last, once every area is built and recovery has run, so no request reaches a
 * server that is still starting (the old server bound first and held requests at a gate instead).
 */
export const serverLayer = (config: ServerConfig["Service"]) =>
  HttpRouter.serve(RoutesLive, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: config.port, host: config.host })),
    Layer.provideMerge(AreasLive),
    Layer.provideMerge(PlatformLive),
    Layer.provideMerge(NodeServices.layer),
  )
