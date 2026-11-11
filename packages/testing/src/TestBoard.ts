import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { AreasLive, platformLayer } from "huntaway-server/src/Main.ts"
import { Db } from "huntaway-server/src/platform/Db.ts"
import { ServerConfig } from "huntaway-server/src/platform/ServerConfig.ts"
import type { ServerConfigShape } from "huntaway-server/src/platform/ServerConfig.ts"

/** A temp folder for the scope, under `$TMPDIR`, removed when the scope closes. */
export const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-test-" })
}).pipe(Effect.orDie)

/** The server's configuration on a fresh temp data folder; `overrides` change any of it. */
export const testConfig = (overrides: Partial<ServerConfigShape> = {}) =>
  Layer.unwrap(Effect.map(tempDir, (dataDir) => ServerConfig.layerTest({ dataDir, ...overrides })))

/** The platform: an in-memory database brought up to date, the identity and data folder in a temp folder. */
export const TestPlatform = (overrides: Partial<ServerConfigShape> = {}) =>
  platformLayer(Db.layerMemory).pipe(Layer.provideMerge(testConfig(overrides)), Layer.provideMerge(NodeServices.layer))

/**
 * The whole server's services (docs/plan/10-testing.md, `packages/testing`): every area on an in-memory database and
 * a scoped temp data folder. Replace a service by providing its layer over this one.
 */
export const TestBoard = (overrides: Partial<ServerConfigShape> = {}) => AreasLive.pipe(Layer.provideMerge(TestPlatform(overrides)))
