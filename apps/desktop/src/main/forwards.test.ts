import { assert, describe, it } from "@effect/vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Desktop } from "./Desktop.ts"
import type { DesktopShape } from "./Desktop.ts"
import { WATCHDOG, forwardedAt, isTailcatAddress, makeForwards } from "./forwards.ts"

/** An executable script `name` in `dir`. */
const script = (dir: string, name: string, body: string) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const BOARD = "http://127.0.0.1:7999"
const OLD = "tcAAAAAAAAAAoldshare"
const NEW = "tcBBBBBBBBBBnewshare"

/** Whether process `pid` is still running. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A fake tailcat in a new folder that forwards on a port of its address's (40001 for `OLD`, 40002 for `NEW`, 40003
 * else) and writes its pid to `<address>.pid` there.
 */
const fakeTailcat = () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-forwards-"))
  const bin = script(
    dir,
    "tailcat",
    `case "$2" in ${OLD}) p=40001;; ${NEW}) p=40002;; *) p=40003;; esac
echo $$ > "${dir}/$2.pid"
echo "# forwarding 127.0.0.1:$p -> remote localhost:$3" >&2
exec sleep 60`,
  )
  return { bin, pid: (address: string) => Number(readFileSync(join(dir, `${address}.pid`), "utf8")) }
}

/** `makeForwards` run on a desktop like `desktop`, with `HUNTAWAY_TAILCAT` as `tailcat` (unset when null). */
const withForwards = <A>(desktop: Partial<DesktopShape>, tailcat: string | null, body: (forwards: Effect.Success<typeof makeForwards>) => Effect.Effect<A>) =>
  Effect.flatMap(makeForwards, body).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Desktop.layerTest({ dataDir: "/nonexistent", port: 1, ...desktop }),
        ConfigProvider.layer(ConfigProvider.fromUnknown(tailcat === null ? {} : { HUNTAWAY_TAILCAT: tailcat })),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  )

// HE-81: reading `tailcat forward`'s output, and what the board may ask to forward.
describe("tailcat forwards", () => {
  it("reads where `tailcat forward` listens", () => {
    assert.strictEqual(forwardedAt("# forwarding 127.0.0.1:43265 -> remote localhost:38701"), "127.0.0.1:43265")
    assert.strictEqual(forwardedAt("# forwarding [::1]:4000 -> remote localhost:5173\n"), "[::1]:4000")
    // Another machine's, or another line.
    assert.strictEqual(forwardedAt("# forwarding 0.0.0.0:43265 -> remote localhost:38701"), null)
    assert.strictEqual(forwardedAt("# Selected bootstrap relay region 302, San Francisco"), null)
  })

  it("takes only a tailcat address", () => {
    assert.isTrue(isTailcatAddress("tcpGFwWCAniKgNj2aLQJuWpphvNUSmQTqXbMLTVzlyKCcZcvVLe2FrWCB7I0Fi3U-Xl0CPqztpAmC_8"))
    for (const bad of ["--help", "tc", "tc abc defghijk", "example.com", 42, null]) assert.isFalse(isTailcatAddress(bad), String(bad))
  })

  it.effect("says tailcat isn't installed when there's none", () =>
    withForwards({}, "no-such-tailcat-here", (forwards) =>
      Effect.map(forwards.forward(BOARD, "tcpGFwWCAniKgNj2aLQJuWpph", 5173), (answer) =>
        assert.deepStrictEqual(answer, {
          error: "tailcat isn't installed on this computer (looked for no-such-tailcat-here): see https://tailscale.com/tailcat",
        }),
      ),
    ),
  )

  it.effect("a packaged app finds tailcat on its login shell's PATH, as a terminal would", () => {
    // tailcat is only in a folder the login shell's PATH has (~/go/bin, Homebrew's), not in the app's own.
    const dir = mkdtempSync(join(tmpdir(), "huntaway-forwards-"))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    script(bin, "tailcat", 'echo "# forwarding 127.0.0.1:43265 -> remote localhost:$3" >&2\nexec sleep 60')
    const shell = script(dir, "login-shell", `PATH=${bin}:/usr/bin:/bin; export PATH; exec /bin/sh -c "$2"`)
    return withForwards({ isPackaged: true, loginShell: shell, path: "/usr/bin:/bin" }, null, (forwards) =>
      Effect.map(forwards.forward(BOARD, "tcpGFwWCAniKgNj2aLQJuWpph", 5173), (answer) => assert.deepStrictEqual(answer, { url: "http://127.0.0.1:43265/" })),
    )
  })

  it.effect("a new share of a host's port stops the forward of its last one", () => {
    const tailcat = fakeTailcat()
    return withForwards({}, tailcat.bin, (forwards) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* forwards.forward(BOARD, OLD, 5173, "host-1"), { url: "http://127.0.0.1:40001/" })
        const old = tailcat.pid(OLD)
        // Asked again, the same.
        assert.deepStrictEqual(yield* forwards.forward(BOARD, OLD, 5173, "host-1"), { url: "http://127.0.0.1:40001/" })
        assert.strictEqual(tailcat.pid(OLD), old)
        // The server stopped and started again, and was shared again: its new address.
        assert.deepStrictEqual(yield* forwards.forward(BOARD, NEW, 5173, "host-1"), { url: "http://127.0.0.1:40002/" })
        assert.isFalse(alive(old), "the old forward is stopped")
        assert.isTrue(alive(tailcat.pid(NEW)))
      }),
    )
  })

  it.effect("another host's port, or another board's, is another forward", () => {
    const tailcat = fakeTailcat()
    return withForwards({}, tailcat.bin, (forwards) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* forwards.forward(BOARD, OLD, 5173, "host-1"), { url: "http://127.0.0.1:40001/" })
        assert.deepStrictEqual(yield* forwards.forward(BOARD, NEW, 5173, "host-2"), { url: "http://127.0.0.1:40002/" })
        assert.deepStrictEqual(yield* forwards.forward("http://127.0.0.1:8000", "tcCCCCCCCCCCthird", 5173, "host-1"), { url: "http://127.0.0.1:40003/" })
        for (const address of [OLD, NEW, "tcCCCCCCCCCCthird"]) assert.isTrue(alive(tailcat.pid(address)), address)
        // A board from before HE-82 gives no host: each address its own forward.
        assert.deepStrictEqual(yield* forwards.forward(BOARD, "tcDDDDDDDDDDnohost", 5173), { url: "http://127.0.0.1:40003/" })
        assert.isTrue(alive(tailcat.pid(OLD)))
        assert.deepStrictEqual(yield* forwards.forward(BOARD, 5173, 5173, "host-1"), { error: "That isn't a tailcat address." })
        assert.deepStrictEqual(yield* forwards.forward(BOARD, NEW, 5173, ""), { error: "That isn't a host." })
      }),
    )
  })

  it.effect("the forwards stop with the app", () => {
    const tailcat = fakeTailcat()
    return Effect.gen(function* () {
      yield* withForwards({}, tailcat.bin, (forwards) => forwards.forward(BOARD, OLD, 5173, "host-1"))
      assert.isFalse(alive(tailcat.pid(OLD)))
    })
  })

  it.effect("the watchdog kills its command once the app's end of its stdin closes, as when the app crashes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        // stdin a pipe that closes at once: the app gone.
        const child = yield* spawner.spawn(
          ChildProcess.make("bash", ["-c", WATCHDOG, "huntaway-tailcat", "sleep", "60"], { detached: true, stdin: { stream: Stream.empty } }),
        )
        const killed = yield* Effect.flip(child.exitCode)
        assert.include(String(killed.cause), "SIGKILL")
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
