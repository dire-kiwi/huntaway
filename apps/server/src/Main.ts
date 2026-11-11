import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { HostRpcs, PublicRpcs } from "@huntaway/contracts"
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
// so a test can replace any of them.

/** Step 1 and 2: the data folder, identity, the database brought up to date. */
export const PlatformLive = Layer.mergeAll(Events.layer, KeyedLock.layer, Proc.layer, Migrations.layer).pipe(
  Layer.provideMerge(Backup.layer),
  Layer.provideMerge(Db.layer),
  Layer.provideMerge(Identity.layer),
  Layer.provideMerge(DataDir.layer),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
)

/** Step 4: every area, bottom up. */
export const AreasLive = Layer.mergeAll(About.layer)

/** The RPC groups over a websocket and over HTTP POST, on `/api/rpc`. */
export const RpcLive = Layer.mergeAll(
  RpcServer.layerHttp({ group: PublicRpcs.merge(HostRpcs), path: "/api/rpc", protocol: "websocket" }),
  RpcServer.layerHttp({ group: PublicRpcs.merge(HostRpcs), path: "/api/rpc", protocol: "http" }),
).pipe(Layer.provide(Layer.mergeAll(PublicHandlers, HostHandlers, AuthLive)), Layer.provide(RpcSerialization.layerNdjson))

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
