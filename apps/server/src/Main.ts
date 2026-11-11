import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
// 6.8: Web Push's cryptography; 6.10: the SHA-256 of a Cua Driver download.
import { Aead, Digest, Kdf, KeyAgreement, Signature } from "effect/crypto"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import type { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import {
  // 6.4
  AgentToolsRpcs,
  ApprovalRulesRpcs,
  // 6.11
  AsanaRpcs,
  ConfigArchiveRpcs,
  FanoutRpcs,
  GithubRepoRpcs,
  AttachmentRpcs,
  BoardRpcs,
  CheckpointRpcs,
  ConfigRpcs,
  // 6.10: computer use.
  DesktopRpcs,
  GitRpcs,
  HostRpcGroup,
  PenRpcs,
  PermissionRpcs,
  ProfileRpcs,
  ProjectRpcs,
  PublicRpcs,
  PushRpcs,
  TaskDocumentRpcs,
  TaskRpcs,
  // 6.1
  TerminalRpcs,
  ThreadRpcs,
} from "@huntaway/contracts"
// 6.4: skills and MCP servers.
import { AgentTools } from "./agents/AgentTools.ts"
import { AgentToolsRepo } from "./agents/AgentToolsRepo.ts"
import { ApprovalRules } from "./agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "./agents/ApprovalRulesRepo.ts"
import { CodexQueriesLive } from "./agents/codex/CodexQueriesLive.ts"
import { CodexQueries } from "./agents/CodexQueries.ts"
import { ContextMeter } from "./agents/ContextMeter.ts"
import { ContextStatsRepo } from "./agents/ContextStatsRepo.ts"
import { Prompts } from "./agents/Prompts.ts"
import { SideCalls } from "./agents/SideCalls.ts"
import { TitleModel } from "./agents/TitleModel.ts"
import { Titles } from "./agents/Titles.ts"
// 4.8: stack titles.
import { StackTitleRepo } from "./agents/StackTitleRepo.ts"
import { StackTitles } from "./agents/StackTitles.ts"
import { TokenRepo } from "./agents/TokenRepo.ts"
import { Tokens } from "./agents/Tokens.ts"
import { UsageWindow } from "./agents/UsageWindow.ts"
import { WindowPrompt } from "./agents/WindowPrompt.ts"
// 6.10: computer use.
import { CuaDriver } from "./desktop/CuaDriver.ts"
import { CuaInstall } from "./desktop/CuaInstall.ts"
import { Desktop } from "./desktop/Desktop.ts"
import { DesktopClaims } from "./desktop/DesktopClaims.ts"
import { DesktopOpRepo } from "./desktop/DesktopOpRepo.ts"
import { DesktopTools } from "./desktop/DesktopTools.ts"
import { ChangesTab } from "./git/ChangesTab.ts"
import { CheckpointRepo } from "./git/CheckpointRepo.ts"
import { Checkpoints } from "./git/Checkpoints.ts"
import { Git } from "./git/Git.ts"
import { Gh } from "./github/Gh.ts"
import { GhStacks } from "./github/GhStacks.ts"
import { GithubRemote } from "./github/GithubRemote.ts"
// 6.11: adding a project from GitHub.
import { GithubRepos } from "./github/GithubRepos.ts"
import { GitHubAccessStacked } from "./github/GitHubAccessLive.ts"
import { PrWatch } from "./github/PrWatch.ts"
import { PrWatchRepo } from "./github/PrWatchRepo.ts"
import { PullRequests } from "./github/PullRequests.ts"
import { Restack } from "./git/Restack.ts"
// 6.11: relocation.
import { Relocation } from "./git/Relocation.ts"
import { RelocationRepo } from "./git/RelocationRepo.ts"
import { StatusScripts } from "./git/StatusScripts.ts"
import { TaskBase } from "./git/TaskBase.ts"
import { Worktrees } from "./git/Worktrees.ts"
import { ApiNotFound, BodyLimit, HealthRoute, StaticUi } from "./http/routes.ts"
import { Backup } from "./platform/Backup.ts"
import { Changes } from "./platform/Changes.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Db } from "./platform/Db.ts"
import { Events } from "./platform/Events.ts"
import { Identity } from "./platform/Identity.ts"
import { KeyedLock } from "./platform/KeyedLock.ts"
import { Listening } from "./platform/Listening.ts"
import { Migrations } from "./platform/Migrations.ts"
import { Proc } from "./platform/Proc.ts"
import { Secrets } from "./platform/Secrets.ts"
import type { ServerConfig } from "./platform/ServerConfig.ts"
import { Board } from "./lifecycle/Board.ts"
import { DemoLive } from "./lifecycle/Demo.ts"
import { Reactor } from "./lifecycle/Reactor.ts"
import { McpCallRepo } from "./mcp/McpCallRepo.ts"
import { askRuleWith, cancelledWith, McpHooks } from "./mcp/McpHooks.ts"
import { McpServers } from "./mcp/McpServers.ts"
import { MergeGate } from "./merge/MergeGate.ts"
import { MergedWatcher } from "./merge/MergedWatcher.ts"
import { Merges } from "./merge/Merges.ts"
import { MergeTargets } from "./merge/MergeTargets.ts"
import { InReview } from "./review/InReview.ts"
import { ToolCalls } from "./mcp/ToolCalls.ts"
import { Wait } from "./mcp/Wait.ts"
import { CommandApproval } from "./mcp/wait/CommandApproval.ts"
import { McpCodexRegistered } from "./mcp/transport/codex.ts"
import { McpControlLive, McpControlRegistered } from "./mcp/transport/control.ts"
import { McpHttpRoute } from "./mcp/transport/http.ts"
import { BoardTools } from "./mcp/tools/board.ts"
import { GhTools } from "./mcp/tools/gh.ts"
import { Approvals } from "./permissions/Approvals.ts"
import { PermissionRepo } from "./permissions/PermissionRepo.ts"
import { Permissions } from "./permissions/Permissions.ts"
import { Questions } from "./permissions/Questions.ts"
import { RecoveryLive } from "./lifecycle/Recovery.ts"
import { ReviewRepo } from "./review/ReviewRepo.ts"
import { Reviews } from "./review/Reviews.ts"
import { ReviewStats } from "./review/ReviewStats.ts"
// 6.11: fan-outs.
import { Fanout } from "./review/Fanout.ts"
import { FanoutRepo } from "./review/FanoutRepo.ts"
import { Summaries } from "./review/Summaries.ts"
import { DevServers } from "./runs/DevServers.ts"
import { AgentRequests } from "./runs/AgentRequests.ts"
import { ClaudeOutput } from "./runs/claude/output.ts"
import { CodexOutput } from "./runs/codex/output.ts"
import { LaunchFacts } from "./runs/LaunchFacts.ts"
import { RunDir } from "./runs/RunDir.ts"
import { RunFollower } from "./runs/RunFollower.ts"
import type { RunOutput } from "./runs/RunOutput.ts"
import { RunInput } from "./runs/RunInput.ts"
import { RunRepo } from "./runs/RunRepo.ts"
import { BackgroundWork } from "./runs/BackgroundWork.ts"
import { Compaction } from "./runs/Compaction.ts"
import { RunEnds } from "./runs/RunEnds.ts"
import { SetupThread } from "./runs/SetupThread.ts"
import { TaskDeletion } from "./runs/TaskDeletion.ts"
import { Runs } from "./runs/Runs.ts"
import { RunWaits } from "./runs/RunWaits.ts"
import { TurnHooks } from "./runs/TurnHooks.ts"
import { TaskDocumentRepo } from "./docs/TaskDocumentRepo.ts"
import { TaskDocuments } from "./docs/TaskDocuments.ts"
import { Shim } from "./runs/Shim.ts"
import { AgentConfigRepo } from "./profiles/AgentConfigRepo.ts"
import { AgentConfigs } from "./profiles/AgentConfigs.ts"
// 6.11: Asana, config archives.
import { Asana } from "./profiles/Asana.ts"
import { ConfigArchives } from "./profiles/ConfigArchives.ts"
import { ProfileRepo } from "./profiles/ProfileRepo.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { Usage } from "./profiles/Usage.ts"
import { ProjectRepo } from "./projects/ProjectRepo.ts"
import { Projects } from "./projects/Projects.ts"
// 6.4
import { AgentToolsHandlers } from "./rpc/agentTools.ts"
import { ApprovalRulesHandlers } from "./rpc/approvalRules.ts"
// 6.11
import { AsanaHandlers } from "./rpc/asana.ts"
import { ConfigArchiveHandlers } from "./rpc/configArchives.ts"
import { FanoutHandlers } from "./rpc/fanout.ts"
import { GithubRepoHandlers } from "./rpc/githubRepos.ts"
import { AttachmentHandlers } from "./rpc/attachments.ts"
import { AuthLive } from "./rpc/AuthLive.ts"
import { BoardHandlers } from "./rpc/board.ts"
import { CheckpointHandlers } from "./rpc/checkpoints.ts"
// 6.10: computer use.
import { DesktopHandlers } from "./rpc/desktop.ts"
import { GitHandlers } from "./rpc/git.ts"
import { HostHandlers } from "./rpc/host.ts"
import { PenHandlers } from "./rpc/pens.ts"
import { TaskDocumentHandlers } from "./rpc/taskDocuments.ts"
import { PermissionHandlers } from "./rpc/permissions.ts"
import { ConfigHandlers, ProfileHandlers } from "./rpc/profiles.ts"
import { ProjectHandlers } from "./rpc/projects.ts"
import { PublicHandlers } from "./rpc/public.ts"
import { PushHandlers } from "./rpc/push.ts"
import { Push } from "./push/Push.ts"
import { PushRepo } from "./push/PushRepo.ts"
import { WebPush } from "./push/WebPush.ts"
import { TaskHandlers } from "./rpc/tasks.ts"
import { ThreadHandlers } from "./rpc/threads.ts"
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
import { TaskTmp } from "./tasks/TaskTmp.ts"
import { TaskRepo } from "./tasks/TaskRepo.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { ThreadReaders } from "./threads/ThreadReaders.ts"
import { Threads } from "./threads/Threads.ts"
import { ThreadStore } from "./threads/ThreadStore.ts"
// 6.1: terminals.
import { TerminalRoute } from "./http/terminal.ts"
import { TerminalHandlers } from "./rpc/terminal.ts"
import { Pty } from "./terminal/Pty.ts"
import { Terminals } from "./terminal/Terminals.ts"

// The composition root (docs/plan/06-server.md, Startup): every layer, in startup order. Nothing else wires layers,
// so a test can replace any of them. An area adds its layer to its line below, in the dependency order of
// docs/plan/06-server.md; a transport adds its handlers and its group.

/**
 * Steps 1 and 2: the data folder, identity, the database brought up to date, and the HTTP client (`profiles/Usage`
 * reads Anthropic's usage endpoint). `db` is swapped for tests.
 */
export const platformLayer = <E, R>(db: Layer.Layer<Db | SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(Events.layer, Changes.layer, KeyedLock.layer, Proc.layer, Migrations.layer, FetchHttpClient.layer, Listening.layer, Secrets.layer).pipe(
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(db),
    Layer.provideMerge(Identity.layer),
    Layer.provideMerge(DataDir.layer),
    Layer.provideMerge(Mac.layerWebCrypto),
    // 6.8: Web Push's cryptography; 6.10: the SHA-256 of a Cua Driver download.
    Layer.provideMerge(Layer.mergeAll(KeyAgreement.layerWebCrypto, Kdf.layerWebCrypto, Aead.layerWebCrypto, Signature.layerWebCrypto, Digest.layerWebCrypto)),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  )

export const PlatformLive = platformLayer(Db.layer)

// Step 4: every area, bottom up. Each line provides the ones above it.
const SettingsLive = Layer.mergeAll(About.layer, HostSettings.layer, Folders.layer).pipe(Layer.provideMerge(SettingsRepo.layer))
const ProfilesLive = Profiles.ensureFromConfig.pipe(
  Layer.provideMerge(Layer.mergeAll(Profiles.layer, Usage.layer, ConfigArchives.layer)),
  Layer.provideMerge(AgentConfigs.layer),
  // 6.11: Asana (connecting a profile, its search) and config archives.
  Layer.provideMerge(Layer.mergeAll(ProfileRepo.layer, AgentConfigRepo.layer, Asana.layer)),
  Layer.provideMerge(SettingsLive),
)
const ProjectsLive = Projects.layer.pipe(Layer.provideMerge(ProjectRepo.layer), Layer.provideMerge(ProfilesLive))
const TasksLive = Layer.mergeAll(Pens.layer, Attachments.pruner, TaskTmp.sweeper).pipe(
  Layer.provideMerge(Layer.mergeAll(Tasks.layer, TaskRefs.layer, Attachments.layer, TaskTmp.layer)),
  Layer.provideMerge(Layer.mergeAll(TaskRepo.layer, PenRepo.layer, Leftovers.layer, Dependencies.layer, MergeFacts.layer)),
  Layer.provideMerge(ProjectsLive),
)
const ThreadsLive = Threads.pruner.pipe(
  Layer.provideMerge(Layer.mergeAll(Threads.layer, ThreadReaders.layer)),
  Layer.provideMerge(ThreadStore.layer),
  Layer.provideMerge(TasksLive),
)
/**
 * The git area: running git; a task's base and worktrees, status scripts (4.1), checkpoints (4.3), the Changes tab
 * (4.2). What it needs of GitHub is `GitHubAccess`, whose live layer is the github area's (4.4), built here under the
 * git area's services since it only needs `Gh`, which only needs `Git`.
 */
const GitLive = Restack.layer.pipe(
  // 4.8: restacking stack levels, over their worktrees.
  Layer.provideMerge(Layer.mergeAll(Worktrees.layer, StatusScripts.layer, ChangesTab.layer)),
  // 6.11: a project's folder moved or followed, which a worktree setup holds where it is.
  Layer.provideMerge(Relocation.layer.pipe(Layer.provideMerge(RelocationRepo.layer))),
  Layer.provideMerge(Layer.mergeAll(TaskBase.layer, Checkpoints.layer)),
  Layer.provideMerge(Layer.mergeAll(GitHubAccessStacked, CheckpointRepo.layer)),
  // 4.8: GitHub's stacks, which `GitHubAccess` offers the restack (it needs only `Gh` and the task rows).
  Layer.provideMerge(GhStacks.layer),
  Layer.provideMerge(Gh.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(ThreadsLive),
)
/**
 * The github area: gh as one account (`Gh`, on the git line), where a task's pull request goes (`GithubRemote`), reading
 * pull requests and what agents were told of them (`PrWatch`), and a task's pull request (`PullRequests`, 4.5).
 */
const GithubLive = Layer.mergeAll(GithubRemote.layer, PrWatch.layer, PullRequests.layer, GithubRepos.layer).pipe(
  Layer.provideMerge(PrWatchRepo.layer),
  Layer.provideMerge(GitLive),
)
/**
 * What asks a model besides runs: titles, window restarts, and Codex's one-off questions (its models, skills, rate limits
 * and titles). Tests give scripted ones, so no test calls a model or starts a Codex.
 */
export interface ModelCalls<T, E1, R1, E2, R2, C = never, E3 = never, R3 = never> {
  /** `TitleModel`, and what a test drives it with (`TitleScript`). */
  readonly titles: Layer.Layer<TitleModel | T, E1, R1>
  readonly window: Layer.Layer<WindowPrompt, E2, R2>
  /** `CodexQueries`: a config's models, skills, rate limits and titles from a short-lived `codex app-server` (5.3). */
  readonly codex: Layer.Layer<CodexQueries | C, E3, R3>
}
/** The agents area over what is above it. */
const agentsLayer = <T, E1, R1, E2, R2, C, E3, R3>(models: ModelCalls<T, E1, R1, E2, R2, C, E3, R3>) =>
  UsageWindow.loop.pipe(
    Layer.provideMerge(
      Layer.mergeAll(ApprovalRules.layer, Prompts.layer, Tokens.layer, ContextMeter.layer, Titles.layer, UsageWindow.layer, CodexQueries.registered),
    ),
    // 4.8: stack titles, over the same model as task titles.
    Layer.provideMerge(StackTitles.layer),
    // 6.4: skills and MCP servers (Prompts reads a project's gh switch), over Codex's skills.
    Layer.provideMerge(AgentTools.layer),
    Layer.provideMerge(AgentToolsRepo.layer),
    Layer.provideMerge(
      Layer.mergeAll(ApprovalRulesRepo.layer, TokenRepo.layer, ContextStatsRepo.layer, SideCalls.layer, StackTitleRepo.layer, models.titles, models.window),
    ),
    // A Codex config's titles are asked of Codex, as its models are (5.3).
    Layer.provideMerge(models.codex),
    Layer.provideMerge(GithubLive),
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
  // The line handler: Codex runs' lines to the Codex handler (5.2), the others to Claude's.
  Layer.provideMerge(CodexOutput.pipe(Layer.provide(ClaudeOutput))),
  Layer.provideMerge(Layer.mergeAll(RunInput.layer, AgentRequests.layer, RunWaits.layer, TurnHooks.layer)),
  Layer.provideMerge(BackgroundWork.layer),
  Layer.provideMerge(Shim.layer),
  Layer.provideMerge(Layer.mergeAll(RunRepo.layer, RunDir.layer)),
)
/**
 * The board's MCP servers over what is above them, with `hooks` (tests give their own): the calls, the server on Claude
 * runs' files and Codex runs' dynamic tools (5.2), and each area's tools (an area's `McpServers.register` layer joins the first line). Fresh, so that a
 * test's own, built over the whole board's services, is not the one those already have.
 */
export const mcpLayer = <E, R>(hooks: Layer.Layer<McpHooks, E, R>) =>
  Layer.mergeAll(McpControlRegistered, McpCodexRegistered).pipe(
    Layer.provideMerge(Layer.mergeAll(Layer.fresh(McpControlLive), BoardTools, GhTools)),
    Layer.provideMerge(Layer.fresh(ToolCalls.layer)),
    Layer.provideMerge(Layer.mergeAll(Layer.fresh(McpServers.layer), McpCallRepo.layer, hooks)),
  )

/**
 * The permissions area: prompts (with their sweeper, and Claude's `can_use_tool` requests registered), questions, and the
 * board's changes that always ask (with a deleted project's approvals expiring).
 */
const PermissionsLive = Layer.mergeAll(Permissions.sweeper, Permissions.registered, Questions.layer, Approvals.layer, Approvals.projectsDeleted).pipe(
  Layer.provideMerge(Permissions.layer),
  Layer.provideMerge(PermissionRepo.layer),
)

/** The review area (4.6): reviews, summaries of the changes, and what reviewers reported. */
const ReviewLive = Reviews.layer.pipe(
  // 6.11: comparing and picking among tasks made from one prompt.
  Layer.provideMerge(Fanout.layer),
  Layer.provideMerge(Layer.mergeAll(Summaries.layer, ReviewStats.layer)),
  Layer.provideMerge(Layer.mergeAll(ReviewRepo.layer, FanoutRepo.layer)),
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

/**
 * 6.10: computer use: the host's one Cua Driver, who drives the desktop, the journal, installing the driver, and the
 * `desktop` MCP server's tools, which it registers with the MCP area below it (desktop sits below mcp in the
 * dependency order, so mcp/ doesn't import it).
 */
const DesktopLive = DesktopTools.pipe(
  Layer.provideMerge(Desktop.layer),
  Layer.provideMerge(CuaInstall.layer),
  Layer.provideMerge(Layer.mergeAll(CuaDriver.layer, DesktopClaims.layer, DesktopOpRepo.layer)),
)

/**
 * The areas of M2 to M5 over the agents area: runs and their ends, permissions, reviews, the merge queue and pull
 * requests. `areasLayer` puts M6's on top (a `pipe` takes twenty steps at most).
 */
const runAreasLayer = <T, E1, R1, E2, R2, C, E3, R3>(models: ModelCalls<T, E1, R1, E2, R2, C, E3, R3>) =>
  // Pull requests' news for agents in review, Fix broken checks, and pull requests merged or closed on GitHub (4.5).
  Layer.mergeAll(InReview.layer, MergedWatcher.layer).pipe(
    // The merge queue and its gate (4.7): the gh tools ask the gate before a merge; the gate decides approval cards, and
    // the merge area reads `Tasks.update`'s git and GitHub facts (both registered below the areas they serve).
    Layer.provideMerge(Layer.mergeAll(Merges.registered, MergeGate.registered)),
    // 4.8: where held tasks go now, a whole stack's merge, and the agent asked to restack.
    Layer.provideMerge(Layer.mergeAll(Merges.layer, MergeTargets.layer)),
    Layer.provideMerge(MergeGate.layer),
    // Reviews and summaries (4.6), over the runs they start.
    Layer.provideMerge(ReviewLive),
    Layer.provideMerge(PermissionsLive),
    // The end of a run, which the reactor calls: over the runs area and what a run's end tells (tokens, dev servers).
    Layer.provideMerge(RunEnds.layer),
    // DevServers reads tasks, which the runs area's own tests (`TestRuns`) don't build: it goes on top of the area.
    Layer.provideMerge(DevServers.layer),
    // What deleting a task and a project's setup thread are made of: runs, tasks and worktrees (4.1).
    Layer.provideMerge(Layer.mergeAll(TaskDeletion.layer, SetupThread.layer)),
    Layer.provideMerge(RunsArea),
    Layer.provideMerge(agentsLayer(models)),
  )

/** Every area's services, with `models` for the board's own model calls. */
export const areasLayer = <T, E1, R1, E2, R2, C, E3, R3>(models: ModelCalls<T, E1, R1, E2, R2, C, E3, R3>) =>
  // The demo board is seeded once every area is built, before Recovery runs.
  Layer.mergeAll(Reactor.layer, RecoveryLive, Board.layer).pipe(
    Layer.provideMerge(DemoLive),
    // 6.1: terminals (a tmux session per task and per terminal tool), ended with a worktree's teardown.
    Layer.provideMerge(Terminals.registered.pipe(Layer.provideMerge(Terminals.layer), Layer.provideMerge(Pty.layer))),
    // 6.10: computer use, over the MCP area it registers its server with.
    Layer.provideMerge(DesktopLive),
    // 6.8: push, watching the board's events for what devices want.
    Layer.provideMerge(Push.watcher),
    Layer.provideMerge(Push.layer),
    Layer.provideMerge(Layer.mergeAll(PushRepo.layer, WebPush.layer)),
    // The board's hooks: `Wait`'s and `Permissions`' (3.3) in one.
    Layer.provideMerge(mcpLayer(BoardHooks)),
    // The waits, and the approval of a wait's command (a `Bash` prompt, `Permissions`').
    Layer.provideMerge(Layer.mergeAll(Wait.layer, CommandApproval.layerPermissions)),
    // 6.2: a task's documents, kept as its runs write them (`TurnHooks`).
    Layer.provideMerge(TaskDocuments.registered),
    Layer.provideMerge(TaskDocuments.layer.pipe(Layer.provideMerge(TaskDocumentRepo.layer))),
    // M2 to M5's areas.
    Layer.provideMerge(runAreasLayer(models)),
  )

/** Every area's services. */
/**
 * The runs area's loops: tasks whose usage limit reset carry on (every 30 s), idle sessions are compacted (every
 * minute), the task's dev servers are looked for in `/proc` (every 4 s). Not in `areasLayer`, so a test board's clock
 * moves without them (a day on the test clock was 20,000 scans of the machine's `/proc`); tests run a pass themselves.
 */
export const RunLoops = Layer.mergeAll(Runs.limitResets, Compaction, DevServers.scanner)

/**
 * The pull requests' loops (4.5): the in-review watcher (every 15 s) and the merged watcher (30 s after start, then every
 * 3 minutes). Not in `areasLayer`, as `RunLoops`: tests run `InReview.sweep` and `MergedWatcher.check` themselves.
 */
export const PrLoops = Layer.mergeAll(InReview.watcher, MergedWatcher.loop)

/** Every area's services, and their loops. */
/** 6.11: the fingerprint recorder: what each project's folder is, until its history is known (now, then hourly). */
export const ProjectLoops = Projects.recorder

export const AreasLive = Layer.mergeAll(RunLoops, PrLoops, ProjectLoops, Terminals.reaper /* 6.1 */).pipe(
  Layer.provideMerge(areasLayer({ titles: TitleModel.layer, window: WindowPrompt.layer, codex: CodexQueriesLive })),
)

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
  CheckpointRpcs,
  GitRpcs,
  // 6.1
  TerminalRpcs,
  // 6.11
  AsanaRpcs,
  ConfigArchiveRpcs,
  FanoutRpcs,
  GithubRepoRpcs,
  // 6.10: computer use.
  DesktopRpcs,
  // 6.4
  AgentToolsRpcs,
  PushRpcs,
  TaskDocumentRpcs,
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
  CheckpointHandlers,
  GitHandlers,
  // 6.1
  TerminalHandlers,
  // 6.11
  AsanaHandlers,
  ConfigArchiveHandlers,
  FanoutHandlers,
  GithubRepoHandlers,
  // 6.10: computer use.
  DesktopHandlers,
  // 6.4
  AgentToolsHandlers,
  PushHandlers,
  TaskDocumentHandlers,
).pipe(Layer.provideMerge(AuthLive))

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`. */
export const RpcLive = Layer.mergeAll(
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(HandlersLive), Layer.provide(RpcSerialization.layerNdjson))

/** The routes the server answers, `/api` first, then the UI. */
export const RoutesLive = Layer.mergeAll(
  RpcLive,
  HealthRoute,
  McpHttpRoute,
  TerminalRoute /* 6.1 */,
  ApiNotFound,
  StaticUi,
  HttpRouter.cors({ maxAge: 86400 }),
  BodyLimit,
)

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
