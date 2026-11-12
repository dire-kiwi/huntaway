import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { Aead, Digest, Kdf, KeyAgreement, Mac, SecureRandom, Signature } from "effect/crypto"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import {
  AdminRpcs,
  AgentToolsRpcs,
  AnalyticsRpcs,
  ApprovalRulesRpcs,
  AsanaRpcs,
  AssistantRpcs,
  AttachmentRpcs,
  AutomationRpcs,
  BoardRpcs,
  CheckpointRpcs,
  ConfigArchiveRpcs,
  ConfigRpcs,
  DesktopRpcs,
  DocRpcs,
  FanoutRpcs,
  GithubRepoRpcs,
  GitRpcs,
  HostRpcGroup,
  HubHostRpcs,
  LinkRpcs,
  PenRpcs,
  PermissionRpcs,
  ProfileRpcs,
  ProjectRpcs,
  PublicRpcs,
  PushRpcs,
  SettingsSyncRpcs,
  TaskDocumentRpcs,
  TaskRpcs,
  TelemetryRpcs,
  TerminalRpcs,
  ThreadRpcs,
  ToolRpcs,
  WorkflowRpcs,
} from "@huntaway/contracts"
import { AgentTools } from "./agents/AgentTools.ts"
import { AgentToolsRepo } from "./agents/AgentToolsRepo.ts"
import { ApprovalRules } from "./agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "./agents/ApprovalRulesRepo.ts"
import { CodexQueries } from "./agents/CodexQueries.ts"
import { ContextMeter } from "./agents/ContextMeter.ts"
import { ContextStatsRepo } from "./agents/ContextStatsRepo.ts"
import { Prompts } from "./agents/Prompts.ts"
import { SideCalls } from "./agents/SideCalls.ts"
import { StackTitleRepo } from "./agents/StackTitleRepo.ts"
import { StackTitles } from "./agents/StackTitles.ts"
import { TitleModel } from "./agents/TitleModel.ts"
import { Titles } from "./agents/Titles.ts"
import { TokenRepo } from "./agents/TokenRepo.ts"
import { Tokens } from "./agents/Tokens.ts"
import { UsageWindow } from "./agents/UsageWindow.ts"
import { WindowPrompt } from "./agents/WindowPrompt.ts"
import { WorkflowFacts } from "./agents/WorkflowFacts.ts"
import { Analytics } from "./analytics/Analytics.ts"
import { AnalyticsRepo } from "./analytics/AnalyticsRepo.ts"
import { Disk } from "./analytics/Disk.ts"
import { Assistant } from "./assistant/Assistant.ts"
import { Brief } from "./assistant/Brief.ts"
import { Google } from "./assistant/Google.ts"
import { Memory } from "./assistant/Memory.ts"
import { Tracked } from "./assistant/Tracked.ts"
import { AutomationRepo } from "./automations/AutomationRepo.ts"
import { Automations } from "./automations/Automations.ts"
import { RoutineHost } from "./automations/RoutineHost.ts"
import { Routines } from "./automations/Routines.ts"
import { Board } from "./board/Board.ts"
import { DocImages } from "./docs/DocImages.ts"
import { DocRepo } from "./docs/DocRepo.ts"
import { Docs } from "./docs/Docs.ts"
import { DocsRender } from "./docs/DocsRender.ts"
import { DocsSiteRepo } from "./docs/DocsSiteRepo.ts"
import { HostedDocs } from "./docs/HostedDocs.ts"
import { TaskDocumentRepo } from "./docs/TaskDocumentRepo.ts"
import { TaskDocuments } from "./docs/TaskDocuments.ts"
import { ChangesTab } from "./git/ChangesTab.ts"
import { CheckpointRepo } from "./git/CheckpointRepo.ts"
import { Checkpoints } from "./git/Checkpoints.ts"
import { Git } from "./git/Git.ts"
import { Relocation } from "./git/Relocation.ts"
import { RelocationRepo } from "./git/RelocationRepo.ts"
import { Restack } from "./git/Restack.ts"
import { StatusScripts } from "./git/StatusScripts.ts"
import { TaskBase } from "./git/TaskBase.ts"
import { Worktrees } from "./git/Worktrees.ts"
import { Gh } from "./github/Gh.ts"
import { GhStacks } from "./github/GhStacks.ts"
import { GitHubAccessStacked } from "./github/GitHubAccessLive.ts"
import { GithubRemote } from "./github/GithubRemote.ts"
import { GithubRepos } from "./github/GithubRepos.ts"
import { PrWatch } from "./github/PrWatch.ts"
import { PrWatchRepo } from "./github/PrWatchRepo.ts"
import { PullRequests } from "./github/PullRequests.ts"
import { LinkRepo } from "./hosts/LinkRepo.ts"
import { ApiNotFound, BodyLimit, HealthRoute, StaticUi } from "./http/routes.ts"
import { MergeGate } from "./merge/MergeGate.ts"
import { Merges } from "./merge/Merges.ts"
import { MergeTargets } from "./merge/MergeTargets.ts"
import { PermissionRepo } from "./permissions/PermissionRepo.ts"
import { Permissions } from "./permissions/Permissions.ts"
import { Questions } from "./permissions/Questions.ts"
import { Backup } from "./platform/Backup.ts"
import { Changes } from "./platform/Changes.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Db } from "./platform/Db.ts"
import { Events } from "./platform/Events.ts"
import { Identity } from "./platform/Identity.ts"
import { KeyedLock } from "./platform/KeyedLock.ts"
import { Lag } from "./platform/Lag.ts"
import { Listening } from "./platform/Listening.ts"
import { Migrations } from "./platform/Migrations.ts"
import { Proc } from "./platform/Proc.ts"
import { ReadOnlySpawner, RefusingHttpClient } from "./platform/ReadOnly.ts"
import { Secrets } from "./platform/Secrets.ts"
import type { ServerConfig } from "./platform/ServerConfig.ts"
import { Telemetry } from "./platform/Telemetry.ts"
import { AgentConfigRepo } from "./profiles/AgentConfigRepo.ts"
import { AgentConfigs } from "./profiles/AgentConfigs.ts"
import { Asana } from "./profiles/Asana.ts"
import { ProfileRepo } from "./profiles/ProfileRepo.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { Usage } from "./profiles/Usage.ts"
import { ProjectRepo } from "./projects/ProjectRepo.ts"
import { Projects } from "./projects/Projects.ts"
import { Push } from "./push/Push.ts"
import { PushRepo } from "./push/PushRepo.ts"
import { WebPush } from "./push/WebPush.ts"
import { Fanout } from "./review/Fanout.ts"
import { FanoutRepo } from "./review/FanoutRepo.ts"
import { InReview } from "./review/InReview.ts"
import { ReviewRepo } from "./review/ReviewRepo.ts"
import { Reviews } from "./review/Reviews.ts"
import { ReviewStats } from "./review/ReviewStats.ts"
import { Summaries } from "./review/Summaries.ts"
import { AgentToolsHandlers } from "./rpc/agentTools.ts"
import { AnalyticsHandlers } from "./rpc/analytics.ts"
import { ApprovalRulesHandlers } from "./rpc/approvalRules.ts"
import { AsanaHandlers } from "./rpc/asana.ts"
import { AssistantHandlers } from "./rpc/assistant.ts"
import { AttachmentHandlers } from "./rpc/attachments.ts"
import { AuthReadOnly } from "./rpc/AuthLive.ts"
import { AutomationHandlers } from "./rpc/automations.ts"
import { BoardHandlers } from "./rpc/board.ts"
import { CheckpointHandlers } from "./rpc/checkpoints.ts"
import { DocHandlers } from "./rpc/docs.ts"
import { FanoutHandlers } from "./rpc/fanout.ts"
import { GitHandlers } from "./rpc/git.ts"
import { GithubRepoHandlers } from "./rpc/githubRepos.ts"
import { HostHandlers } from "./rpc/host.ts"
import { PenHandlers } from "./rpc/pens.ts"
import { PermissionHandlers } from "./rpc/permissions.ts"
import { ConfigHandlers, ProfileHandlers } from "./rpc/profiles.ts"
import { ProjectHandlers } from "./rpc/projects.ts"
import { PushHandlers } from "./rpc/push.ts"
import { ReadOnlyHubHandlers, ReadOnlyPublicHandlers, refuseAll, refuseChanges } from "./rpc/readOnly.ts"
import { TaskDocumentHandlers } from "./rpc/taskDocuments.ts"
import { TaskHandlers } from "./rpc/tasks.ts"
import { ThreadHandlers } from "./rpc/threads.ts"
import { WorkflowHandlers } from "./rpc/workflows.ts"
import { AgentRequests } from "./runs/AgentRequests.ts"
import { AssistantLaunch } from "./runs/AssistantLaunch.ts"
import { BackgroundWork } from "./runs/BackgroundWork.ts"
import { ClaudeOutput } from "./runs/claude/output.ts"
import { CodexOutput } from "./runs/codex/output.ts"
import { DevServers } from "./runs/DevServers.ts"
import { LaunchFacts } from "./runs/LaunchFacts.ts"
import { RunDir } from "./runs/RunDir.ts"
import { RunFollower } from "./runs/RunFollower.ts"
import { RunInput } from "./runs/RunInput.ts"
import { RunRepo } from "./runs/RunRepo.ts"
import { Runs } from "./runs/Runs.ts"
import { RunWaits } from "./runs/RunWaits.ts"
import { SetupThread } from "./runs/SetupThread.ts"
import { Shim } from "./runs/Shim.ts"
import { TaskDeletion } from "./runs/TaskDeletion.ts"
import { TurnHooks } from "./runs/TurnHooks.ts"
import { About } from "./settings/About.ts"
import { Folders } from "./settings/Folders.ts"
import { HostSettings } from "./settings/HostSettings.ts"
import { SettingsRepo } from "./settings/SettingsRepo.ts"
import { Attachments } from "./tasks/Attachments.ts"
import { Dependencies } from "./tasks/Dependencies.ts"
import { Leftovers } from "./tasks/Leftovers.ts"
import { MergeFacts } from "./tasks/MergeFacts.ts"
import { PenRepo } from "./tasks/PenRepo.ts"
import { Pens } from "./tasks/Pens.ts"
import { TaskRefs } from "./tasks/TaskRefs.ts"
import { TaskRepo } from "./tasks/TaskRepo.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { TaskTmp } from "./tasks/TaskTmp.ts"
import { ThreadReaders } from "./threads/ThreadReaders.ts"
import { Threads } from "./threads/Threads.ts"
import { ThreadStore } from "./threads/ThreadStore.ts"
import { WorkflowEngine } from "./workflows/WorkflowEngine.ts"
import { Workflows } from "./workflows/Workflows.ts"
import { WorkflowStore } from "./workflows/WorkflowStore.ts"

// The read-only server's composition root (docs/plan/06-server.md, `ImportGuard` and a read-only server; 11-migration.md,
// Rehearsal): what a rehearsal folder (`import.json` with `rehearsal: true`) is served by, and in no other way. Its rule:
// it reads; it starts nothing, changes nothing outside its own folder, and calls nothing on the network. Held at four
// places, so that one mistake in one of them is not enough:
//
// 1. Sessions: `AuthReadOnly` gives the board token `read` and no other scope (every change is `Forbidden`), and the
//    handlers of every RPC that is not a read die without acting (`refuseChanges`).
// 2. Nothing is started: the same services as `Main.ts`, and none of their loops, registrations with other areas,
//    reactor, recovery, demo, links, discovery, hub, update, terminals, desktop, MCP, webhooks, relay or telemetry export.
//    Building a layer here starts nothing (a structural test holds that no loop's layer is named in this graph).
// 3. Processes: `Proc.readOnly`, over `ReadOnlySpawner`: git with a reading subcommand, under `GIT_OPTIONAL_LOCKS=0`.
// 4. The network: `RefusingHttpClient`; no socket but the listener's.
//
// The services are the board's own, so every read answers as it does on the board; what only a change needs is built
// but unreachable. A service `Main.ts` adds that a handler here needs fails the type check until it is added here.

/**
 * The platform, read-only: the data folder, identity and database are this folder's own (the importer wrote the
 * database; the identity is made on first start, never the old host's). Over the environment's file system and
 * spawner, which `ReadOnlySpawner` narrows; the HTTP client is `RefusingHttpClient` whatever the environment has.
 */
export const ReadOnlyPlatform = Layer.mergeAll(Events.layer, Changes.layer, KeyedLock.layer, Migrations.layer, Listening.layer, Secrets.layer).pipe(
  Layer.provideMerge(Telemetry.layer),
  Layer.provideMerge(Lag.layer),
  Layer.provideMerge(Backup.layer),
  Layer.provideMerge(Db.layer),
  Layer.provideMerge(Identity.layer),
  Layer.provideMerge(DataDir.layer),
  Layer.provideMerge(Proc.readOnly),
  Layer.provideMerge(ReadOnlySpawner),
  Layer.provideMerge(RefusingHttpClient),
  Layer.provideMerge(Mac.layerWebCrypto),
  Layer.provideMerge(Layer.mergeAll(KeyAgreement.layerWebCrypto, Kdf.layerWebCrypto, Aead.layerWebCrypto, Signature.layerWebCrypto, Digest.layerWebCrypto)),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
)

// The areas, bottom up as in `Main.ts`, without their loops (pruners, sweepers, watchers, the scheduler's loop, usage's),
// without `Profiles.ensureFromConfig`, and without the layers that register one area with another.
const SettingsArea = Layer.mergeAll(About.readOnly, HostSettings.layer, Folders.layer).pipe(Layer.provideMerge(SettingsRepo.layer))
const ProfilesArea = Layer.mergeAll(Profiles.layer, Usage.layer).pipe(
  Layer.provideMerge(AgentConfigs.layer),
  Layer.provideMerge(Layer.mergeAll(ProfileRepo.layer, AgentConfigRepo.layer, Asana.layer)),
  Layer.provideMerge(SettingsArea),
)
const TasksArea = Pens.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Tasks.layer, TaskRefs.layer, Attachments.layer, TaskTmp.layer)),
  Layer.provideMerge(Layer.mergeAll(TaskRepo.layer, PenRepo.layer, Leftovers.layer, Dependencies.layer, MergeFacts.layer)),
  Layer.provideMerge(Projects.layer.pipe(Layer.provideMerge(ProjectRepo.layer), Layer.provideMerge(ProfilesArea))),
)
const GitArea = Restack.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Worktrees.layer, StatusScripts.layer, ChangesTab.layer)),
  Layer.provideMerge(Relocation.layer.pipe(Layer.provideMerge(RelocationRepo.layer))),
  Layer.provideMerge(Layer.mergeAll(TaskBase.layer, Checkpoints.layer)),
  Layer.provideMerge(Layer.mergeAll(GitHubAccessStacked, CheckpointRepo.layer)),
  Layer.provideMerge(GhStacks.layer),
  Layer.provideMerge(Gh.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(Layer.mergeAll(Threads.layer, ThreadReaders.layer).pipe(Layer.provideMerge(ThreadStore.layer), Layer.provideMerge(TasksArea))),
)
const AgentsArea = Layer.mergeAll(ApprovalRules.layer, Prompts.layer, Tokens.layer, ContextMeter.layer, Titles.layer, UsageWindow.layer).pipe(
  Layer.provideMerge(StackTitles.layer),
  Layer.provideMerge(AgentTools.layer),
  Layer.provideMerge(AgentToolsRepo.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ApprovalRulesRepo.layer,
      TokenRepo.layer,
      ContextStatsRepo.layer,
      SideCalls.layer,
      StackTitleRepo.layer,
      TitleModel.layer,
      WindowPrompt.layerNone,
    ),
  ),
  Layer.provideMerge(WorkflowFacts.layer),
  // No Codex is started: its models, skills and rate limits are unavailable.
  Layer.provideMerge(CodexQueries.readOnly),
  Layer.provideMerge(Layer.mergeAll(GithubRemote.layer, PrWatch.layer, PullRequests.layer, GithubRepos.layer).pipe(Layer.provideMerge(PrWatchRepo.layer))),
  Layer.provideMerge(GitArea),
)
const RunsArea = Runs.layer.pipe(
  Layer.provideMerge(LaunchFacts.layer),
  Layer.provideMerge(RunFollower.layer),
  Layer.provideMerge(CodexOutput.pipe(Layer.provide(ClaudeOutput))),
  Layer.provideMerge(Layer.mergeAll(RunInput.layer, AgentRequests.layer, RunWaits.layer, TurnHooks.layer, AssistantLaunch.layer)),
  Layer.provideMerge(BackgroundWork.layer),
  Layer.provideMerge(Shim.layer),
  Layer.provideMerge(Layer.mergeAll(RunRepo.layer, RunDir.layer)),
  Layer.provideMerge(AgentsArea),
)
const ActingAreas = InReview.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Merges.layer, MergeTargets.layer)),
  Layer.provideMerge(MergeGate.layer),
  Layer.provideMerge(Automations.layer.pipe(Layer.provideMerge(Routines.layer), Layer.provideMerge(Layer.mergeAll(AutomationRepo.layer, RoutineHost.layer)))),
  Layer.provideMerge(
    Reviews.layer.pipe(
      Layer.provideMerge(Fanout.layer),
      Layer.provideMerge(Layer.mergeAll(Summaries.layer, ReviewStats.layer)),
      Layer.provideMerge(Layer.mergeAll(ReviewRepo.layer, FanoutRepo.layer)),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(Permissions.layer, Questions.layer).pipe(Layer.provideMerge(PermissionRepo.layer))),
  Layer.provideMerge(DevServers.layer),
  Layer.provideMerge(Layer.mergeAll(TaskDeletion.layer, SetupThread.layer)),
  Layer.provideMerge(RunsArea),
)

/** Every service the read-only handlers need, over `ReadOnlyPlatform`. Builds without starting anything. */
export const ReadOnlyAreas = Layer.mergeAll(Board.layer, LinkRepo.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Analytics.layer, Disk.layer).pipe(Layer.provideMerge(AnalyticsRepo.layer))),
  Layer.provideMerge(Push.layer.pipe(Layer.provideMerge(Layer.mergeAll(PushRepo.layer, WebPush.layer)))),
  Layer.provideMerge(Workflows.layer.pipe(Layer.provideMerge(WorkflowEngine.layer), Layer.provideMerge(WorkflowStore.layer))),
  Layer.provideMerge(Layer.mergeAll(Brief.layer, Google.layer, Tracked.layer).pipe(Layer.provideMerge(Assistant.layer), Layer.provideMerge(Memory.layer))),
  Layer.provideMerge(
    Docs.layer.pipe(
      Layer.provideMerge(HostedDocs.layer),
      Layer.provideMerge(Layer.mergeAll(DocRepo.layer, DocsSiteRepo.layer, DocImages.layer, DocsRender.layer)),
    ),
  ),
  Layer.provideMerge(TaskDocuments.layer.pipe(Layer.provideMerge(TaskDocumentRepo.layer))),
  Layer.provideMerge(ActingAreas),
  Layer.provideMerge(ReadOnlyPlatform),
)

/** The groups served: the board's (`Main.Served`), so a client sees the same contract and is refused, not unknown. */
export const ReadOnlyServed = PublicRpcs.merge(
  HostRpcGroup,
  HubHostRpcs,
  LinkRpcs,
  SettingsSyncRpcs,
  AdminRpcs,
  ToolRpcs,
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
  CheckpointRpcs,
  GitRpcs,
  DocRpcs,
  TerminalRpcs,
  AsanaRpcs,
  ConfigArchiveRpcs,
  FanoutRpcs,
  GithubRepoRpcs,
  DesktopRpcs,
  AgentToolsRpcs,
  TelemetryRpcs,
  AnalyticsRpcs,
  PushRpcs,
  TaskDocumentRpcs,
  AutomationRpcs,
  AssistantRpcs,
  WorkflowRpcs,
)

/**
 * The handlers: every RPC refused, under the board's own handlers of the groups that have reads, under a refusal of every
 * RPC that is not a read (later layers win). Groups with no read (admin, desktop, links, settings sync, telemetry,
 * terminals, tools) are only refused, so nothing they would need is built.
 */
export const ReadOnlyHandlers = Layer.mergeAll(
  refuseAll(ReadOnlyServed),
  ReadOnlyPublicHandlers,
  HostHandlers,
  ReadOnlyHubHandlers,
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
  CheckpointHandlers,
  GitHandlers,
  DocHandlers,
  AsanaHandlers,
  FanoutHandlers,
  GithubRepoHandlers,
  AgentToolsHandlers,
  AnalyticsHandlers,
  PushHandlers,
  TaskDocumentHandlers,
  AutomationHandlers,
  AssistantHandlers,
  WorkflowHandlers,
  refuseChanges(ReadOnlyServed),
).pipe(Layer.provideMerge(AuthReadOnly))

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`, as on the board. */
export const ReadOnlyRpc = Layer.mergeAll(
  RpcServer.layerHttp({ group: ReadOnlyServed, path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: ReadOnlyServed, path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(ReadOnlyHandlers), Layer.provide(RpcSerialization.layerNdjson))

/** The routes: the RPC, the health and the UI. No webhook, MCP, hook, OTLP, relay, link-stream or terminal path. */
export const ReadOnlyRoutes = Layer.mergeAll(ReadOnlyRpc, HealthRoute, ApiNotFound, StaticUi, HttpRouter.cors({ maxAge: 86400 }), BodyLimit)

/**
 * The whole read-only server, on `config.host` (which `bin.ts` makes 127.0.0.1 unless `--host` or `HUNTAWAY_HOST` was
 * given): it binds once every service is built, as the board does. `guard` is `ImportGuard`'s answer.
 */
export const readOnlyServerLayer = (config: ServerConfig["Service"]) =>
  HttpRouter.serve(ReadOnlyRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: config.port, host: config.host })),
    Layer.provideMerge(ReadOnlyAreas),
    Layer.provideMerge(NodeServices.layer),
  )
