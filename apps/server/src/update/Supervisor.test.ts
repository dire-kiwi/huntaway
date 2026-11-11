import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import { tempDir } from "@huntaway/testing"
import { spawnSync } from "node:child_process"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { NOT_SUPERVISED, restartArgs, restartScript, Supervisor } from "./Supervisor.ts"

// What the server writes for the launcher to source (bin/huntaway's restart file) must give back exactly the program,
// arguments and variables it was given, whatever they hold. The launcher's own side is tests/e2e/launcher.test.ts.

describe("the restart file", () => {
  it.live("sources back to the same program, arguments and variables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDir
      const args = ["serve", "--name", 'it\'s "mine" $HOME `x` 100%', "--data-dir", "/a b/c", ""]
      yield* fs.writeFileString(`${dir}/next`, restartScript("/opt/it's/huntaway", args, [["HUNTAWAY_BUNDLED_SERVER", "/a'b/$c"]]))
      const r = spawnSync("sh", ["-c", `. "$1"; printf '%s\\n' "$next" "$HUNTAWAY_BUNDLED_SERVER" "$#" "$@"`, "sh", `${dir}/next`], { encoding: "utf8" })
      assert.deepStrictEqual(r.stdout.split("\n").slice(0, -1), ["/opt/it's/huntaway", "/a'b/$c", String(args.length), ...args])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it("a restart keeps every argument (no one-shot flags today)", () => {
    assert.deepStrictEqual(restartArgs(["serve", "--port", "7879", "--demo"]), ["serve", "--port", "7879", "--demo"])
  })

  it.live("a server the launcher didn't start can't exec", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const context = yield* Layer.build(Supervisor.layer.pipe(Layer.provideMerge(ServerConfig.layerTest({ dataDir: dir }))))
      const supervisor = Context.get(context, Supervisor)
      assert.isNull(supervisor.pid)
      const e = yield* Effect.flip(supervisor.exec("/bin/true", [], []))
      assert.strictEqual(e.message, `failed to exec /bin/true: ${NOT_SUPERVISED}`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
