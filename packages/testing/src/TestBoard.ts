import * as NodeServices from "@effect/platform-node/NodeServices"
import { Context, Effect, FileSystem, Layer, Option, Scope } from "effect"
import { AcpQueries } from "huntaway-server/src/agents/AcpQueries.ts"
import { CodexQueries } from "huntaway-server/src/agents/CodexQueries.ts"
import { TitleModel } from "huntaway-server/src/agents/TitleModel.ts"
import { WindowPrompt } from "huntaway-server/src/agents/WindowPrompt.ts"
import { areasLayer, platformLayer } from "huntaway-server/src/Main.ts"
import { Db } from "huntaway-server/src/platform/Db.ts"
import { ServerConfig } from "huntaway-server/src/platform/ServerConfig.ts"
import type { ServerConfigShape } from "huntaway-server/src/platform/ServerConfig.ts"
import { InstalledPlugins } from "huntaway-server/src/plugins/InstalledPlugins.ts"
import type { Plugin } from "@huntaway/plugin"

/**
 * Where a test board's temp folders go: the scope of its bottom layer, closed after every other part of the board.
 * A test's scope closes before the board it runs on (`effect.pipe(Effect.scoped, Effect.provide(TestBoard()))`), so a
 * repository made in the test would be removed while the board's fibers (a run's launch adding its worktree) still run
 * git in it (HE-121). Kept here, it is removed once those fibers are interrupted and their git has exited.
 */
export class TestFolders extends Context.Service<TestFolders, Scope.Scope>()("@huntaway/testing/TestBoard/TestFolders") {
  static readonly layer = Layer.effect(TestFolders, Effect.scope)
}

/**
 * A temp folder under `$TMPDIR`: removed when the test board closes (`TestFolders`) if there is one, else when the
 * scope closes.
 */
export const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const make = fs.makeTempDirectoryScoped({ prefix: "huntaway-test-" })
  const board = yield* Effect.serviceOption(TestFolders)
  return yield* Option.isSome(board) ? Scope.provide(board.value)(make) : make
}).pipe(Effect.orDie)

/** The server's configuration on a fresh temp data folder; `overrides` change any of it. */
export const testConfig = (overrides: Partial<ServerConfigShape> = {}) =>
  Layer.unwrap(Effect.map(tempDir, (dataDir) => ServerConfig.layerTest({ dataDir, ...overrides })))

/** The platform: an in-memory database brought up to date, the identity and data folder in a temp folder. */
export const TestPlatform = (overrides: Partial<ServerConfigShape> = {}) =>
  platformLayer(Db.layerMemory).pipe(Layer.provideMerge(testConfig(overrides)), Layer.provideMerge(NodeServices.layer), Layer.provideMerge(TestFolders.layer))

/**
 * The whole server's services (docs/plan/10-testing.md, `packages/testing`): every area on an in-memory database and
 * a scoped temp data folder. Replace a service by providing its layer over this one. No model is ever asked: titles
 * come from `TitleScript` (`TitleModel.layerScripted`, which the board provides), window restarts fail, and Codex is never
 * started (`CodexQueries.layerTest`: the models `CodexModelsScript` sets), nor is an ACP agent (`AcpQueries.layerTest`, `AcpModelsScript`). It runs `plugins` (HE-34), none by default.
 */
export const TestBoard = (overrides: Partial<ServerConfigShape> = {}, plugins: ReadonlyArray<Plugin> = []) =>
  areasLayer(
    { titles: TitleModel.layerScripted, window: WindowPrompt.layerNone, codex: CodexQueries.layerTest, acp: AcpQueries.layerTest },
    InstalledPlugins.layer(plugins),
  ).pipe(Layer.provideMerge(TestPlatform(overrides)))
