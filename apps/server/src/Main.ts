import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import type { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import {
  ApprovalRulesRpcs,
  AttachmentRpcs,
  BoardRpcs,
  ConfigRpcs,
  HostRpcGroup,
  PenRpcs,
  ProfileRpcs,
  ProjectRpcs,
  PublicRpcs,
  TaskRpcs,
  ThreadRpcs,
} from "@huntaway/contracts"
import { ApprovalRules } from "./agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "./agents/ApprovalRulesRepo.ts"
import { Prompts } from "./agents/Prompts.ts"
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
import { RecoveryLive } from "./lifecycle/Recovery.ts"
import { RunDir } from "./runs/RunDir.ts"
import { RunFollower } from "./runs/RunFollower.ts"
import { RunOutput } from "./runs/RunOutput.ts"
import { RunRepo } from "./runs/RunRepo.ts"
import { Shim } from "./runs/Shim.ts"
import { AgentConfigRepo } from "./profiles/AgentConfigRepo.ts"
import { AgentConfigs } from "./profiles/AgentConfigs.ts"
import { ProfileRepo } from "./profiles/ProfileRepo.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { ProjectRepo } from "./projects/ProjectRepo.ts"
import { Projects } from "./projects/Projects.ts"
import { ApprovalRulesHandlers } from "./rpc/approvalRules.ts"
import { AttachmentHandlers } from "./rpc/attachments.ts"
import { AuthLive } from "./rpc/AuthLive.ts"
import { BoardHandlers } from "./rpc/board.ts"
import { HostHandlers } from "./rpc/host.ts"
import { PenHandlers } from "./rpc/pens.ts"
import { ConfigHandlers, ProfileHandlers } from "./rpc/profiles.ts"
import { ProjectHandlers } from "./rpc/projects.ts"
import { PublicHandlers } from "./rpc/public.ts"
import { TaskHandlers } from "./rpc/tasks.ts"
import { ThreadHandlers } from "./rpc/threads.ts"
import { About } from "./settings/About.ts"
import { Folders } from "./settings/Folders.ts"
import { HostSettings } from "./settings/HostSettings.ts"
import { SettingsRepo } from "./settings/SettingsRepo.ts"
import { Attachments } from "./tasks/Attachments.ts"
import { Dependencies } from "./tasks/Dependencies.ts"
import { PenRepo } from "./tasks/PenRepo.ts"
import { Pens } from "./tasks/Pens.ts"
import { TaskRefs } from "./tasks/TaskRefs.ts"
import { TaskRepo } from "./tasks/TaskRepo.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { ThreadReaders } from "./threads/ThreadReaders.ts"
import { Threads } from "./threads/Threads.ts"
import { ThreadStore } from "./threads/ThreadStore.ts"

// The composition root (docs/plan/06-server.md, Startup): every layer, in startup order. Nothing else wires layers,
// so a test can replace any of them. An area adds its layer to its line below, in the dependency order of
// docs/plan/06-server.md; a transport adds its handlers and its group.

/** Steps 1 and 2: the data folder, identity, the database brought up to date. `db` is swapped for tests. */
export const platformLayer = <E, R>(db: Layer.Layer<Db | SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(Events.layer, Changes.layer, KeyedLock.layer, Proc.layer, Migrations.layer).pipe(
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(db),
    Layer.provideMerge(Identity.layer),
    Layer.provideMerge(DataDir.layer),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  )

export const PlatformLive = platformLayer(Db.layer)

// Step 4: every area, bottom up. Each line provides the ones above it.
const SettingsLive = Layer.mergeAll(About.layer, HostSettings.layer, Folders.layer).pipe(Layer.provideMerge(SettingsRepo.layer))
const ProfilesLive = Profiles.ensureFromConfig.pipe(
  Layer.provideMerge(Profiles.layer),
  Layer.provideMerge(AgentConfigs.layer),
  Layer.provideMerge(Layer.mergeAll(ProfileRepo.layer, AgentConfigRepo.layer)),
  Layer.provideMerge(SettingsLive),
)
const ProjectsLive = Projects.layer.pipe(Layer.provideMerge(ProjectRepo.layer), Layer.provideMerge(ProfilesLive))
const TasksLive = Layer.mergeAll(Pens.layer, Attachments.pruner).pipe(
  Layer.provideMerge(Layer.mergeAll(Tasks.layer, TaskRefs.layer, Attachments.layer)),
  Layer.provideMerge(Layer.mergeAll(TaskRepo.layer, PenRepo.layer)),
  Layer.provideMerge(ProjectsLive),
)
const ThreadsLive = Threads.pruner.pipe(
  Layer.provideMerge(Layer.mergeAll(Threads.layer, ThreadReaders.layer)),
  Layer.provideMerge(ThreadStore.layer),
  Layer.provideMerge(TasksLive),
)
const AgentsLive = Layer.mergeAll(ApprovalRules.layer, Prompts.layer).pipe(Layer.provideMerge(ApprovalRulesRepo.layer), Layer.provideMerge(ThreadsLive))
/** The runs area over what is above it, with `output` handling runs' lines (tests give their own). */
export const runsLayer = <E, R>(output: Layer.Layer<RunOutput, E, R>) =>
  RunFollower.layer.pipe(Layer.provideMerge(output), Layer.provideMerge(Shim.layer), Layer.provideMerge(Layer.mergeAll(RunRepo.layer, RunDir.layer)))
const RunsLive = runsLayer(RunOutput.layerLog).pipe(Layer.provideMerge(AgentsLive))
// The demo board is seeded once every area is built, before Recovery runs.
const LifecycleLive = Layer.mergeAll(Reactor.layer, RecoveryLive, Board.layer).pipe(
  Layer.provideMerge(DemoLive),
  Layer.provideMerge(Dependencies.layer),
  Layer.provideMerge(RunsLive),
)

/** Every area's services. */
export const AreasLive = LifecycleLive

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
).pipe(Layer.provideMerge(AuthLive))

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`. */
export const RpcLive = Layer.mergeAll(
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(HandlersLive), Layer.provide(RpcSerialization.layerNdjson))

/** The routes the server answers, `/api` first, then the UI. */
export const RoutesLive = Layer.mergeAll(RpcLive, HealthRoute, ApiNotFound, StaticUi, HttpRouter.cors({ maxAge: 86400 }), BodyLimit)

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
