import { assert, describe, it } from "@effect/vitest"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer } from "effect"
import { Desktop } from "./Desktop.ts"
import type { DesktopShape } from "./Desktop.ts"
import { forwardedAt, isTailcatAddress, makeForwards } from "./forwards.ts"

/** An executable script `name` in `dir`. */
const script = (dir: string, name: string, body: string) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
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
      Effect.map(forwards.forward("tcpGFwWCAniKgNj2aLQJuWpph", 5173), (answer) =>
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
      Effect.map(forwards.forward("tcpGFwWCAniKgNj2aLQJuWpph", 5173), (answer) => assert.deepStrictEqual(answer, { url: "http://127.0.0.1:43265/" })),
    )
  })
})
