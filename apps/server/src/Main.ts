import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import type { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import { HostRpcGroup, PublicRpcs } from "@huntaway/contracts"
import { ApiNotFound, HealthRoute, StaticUi } from "./http/routes.ts"
import { Backup } from "./platform/Backup.ts"
import { DataDir } from "./platform/DataDir.ts"
import { Db } from "./platform/Db.ts"
import { Events } from "./platform/Events.ts"
import { Identity } from "./platform/Identity.ts"
import { KeyedLock } from "./platform/KeyedLock.ts"
import { Migrations } from "./platform/Migrations.ts"
import { Proc } from "./platform/Proc.ts"
import type { ServerConfig } from "./platform/ServerConfig.ts"
import { AuthLive } from "./rpc/AuthLive.ts"
import { HostHandlers } from "./rpc/host.ts"
import { PublicHandlers } from "./rpc/public.ts"
import { About } from "./settings/About.ts"

// The composition root (docs/plan/06-server.md, Startup): every layer, in startup order. Nothing else wires layers,
// so a test can replace any of them. An area adds its layer to its line below, in the dependency order of
// docs/plan/06-server.md; a transport adds its handlers and its group.

/** Steps 1 and 2: the data folder, identity, the database brought up to date. `db` is swapped for tests. */
export const platformLayer = <E, R>(db: Layer.Layer<Db | SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(Events.layer, KeyedLock.layer, Proc.layer, Migrations.layer).pipe(
    Layer.provideMerge(Backup.layer),
    Layer.provideMerge(db),
    Layer.provideMerge(Identity.layer),
    Layer.provideMerge(DataDir.layer),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  )

export const PlatformLive = platformLayer(Db.layer)

// Step 4: every area, bottom up. Each line provides the ones above it.
const SettingsLive = Layer.mergeAll(About.layer)
const ProfilesLive = Layer.mergeAll(Layer.empty).pipe(Layer.provideMerge(SettingsLive))
const ProjectsLive = Layer.mergeAll(Layer.empty).pipe(Layer.provideMerge(ProfilesLive))
const TasksLive = Layer.mergeAll(Layer.empty).pipe(Layer.provideMerge(ProjectsLive))
const LifecycleLive = Layer.mergeAll(Layer.empty).pipe(Layer.provideMerge(TasksLive))

/** Every area's services. */
export const AreasLive = LifecycleLive

/** The groups served (`HostRpcs` once every area has its handlers), and their handlers. */
export const Served = PublicRpcs.merge(HostRpcGroup)
export const HandlersLive = Layer.mergeAll(PublicHandlers, HostHandlers).pipe(Layer.provideMerge(AuthLive))

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`. */
export const RpcLive = Layer.mergeAll(
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: Served, path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(HandlersLive), Layer.provide(RpcSerialization.layerNdjson))

/** The routes the server answers, `/api` first, then the UI. */
export const RoutesLive = Layer.mergeAll(RpcLive, HealthRoute, ApiNotFound, StaticUi, HttpRouter.cors({ maxAge: 86400 }))

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
