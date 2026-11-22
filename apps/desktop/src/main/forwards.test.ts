import { assert, describe, it } from "@effect/vitest"
import { forwardedAt, isTailcatAddress } from "./forwards.ts"

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
})
