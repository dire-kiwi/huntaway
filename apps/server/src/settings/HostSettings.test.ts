import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { HostSettingsPatch, LinkId } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Events } from "../platform/Events.ts"
import { HostSettings } from "./HostSettings.ts"
import { SettingsRepo } from "./SettingsRepo.ts"
import { JsonColumn } from "../platform/columns.ts"

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect)

describe("HostSettings", () => {
  // The old a_setting_of_the_wrong_type_is_refused_rather_than_cleared: the contract's schema refuses a wrong type
  // before the service sees it, and an empty patch clears nothing.
  it.effect("refuses a setting of the wrong type rather than clearing it; null and blank clear", () =>
    Effect.gen(function* () {
      const settings = yield* HostSettings
      let out = yield* settings.update({ default_model: "haiku", default_effort: "high" })
      assert.deepStrictEqual([out.default_model, out.default_effort], ["haiku", "high"])
      for (const bad of [{ default_model: 123 }, { default_permission_mode: 5 }, { default_effort: ["high"] }, { scratch_host: true }]) {
        assert.isTrue((yield* Effect.result(Schema.decodeUnknownEffect(HostSettingsPatch)(bad)))._tag === "Failure")
      }
      out = yield* settings.update({})
      assert.deepStrictEqual([out.default_model, out.default_effort], ["haiku", "high"], "nothing cleared")
      out = yield* settings.update({ default_model: null, default_effort: null })
      assert.deepStrictEqual([out.default_model, out.default_effort], [null, null])
      out = yield* settings.update({ default_model: " opus " })
      assert.strictEqual(out.default_model, "opus")
      out = yield* settings.update({ default_model: "  " })
      assert.strictEqual(out.default_model, null)
      assert.strictEqual(yield* (yield* SettingsRepo).get("default_model"), null, "blank deletes the row")
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("checks the public URL and keeps it without trailing slashes", () =>
    Effect.gen(function* () {
      const settings = yield* HostSettings
      assert.strictEqual((yield* settings.update({ public_url: " https://board.example.com// " })).public_url, "https://board.example.com")
      for (const bad of ["ftp://x", "board.example.com", "https://a b", `https://${"x".repeat(500)}`]) {
        const e = yield* failure(settings.update({ public_url: bad }))
        assert.strictEqual(e.field, "public_url", bad)
      }
      assert.strictEqual((yield* settings.update({ public_url: "" })).public_url, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("refuses a scratch host, as no host is linked yet", () =>
    Effect.gen(function* () {
      const settings = yield* HostSettings
      const e = yield* failure(settings.update({ scratch_host: LinkId.make("abc") }))
      assert.strictEqual(e.field, "scratch_host")
      assert.strictEqual((yield* settings.update({ scratch_host: null })).scratch_host, null)
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("tidies terminal tools and gives each a usable, unique id", () =>
    Effect.gen(function* () {
      const settings = yield* HostSettings
      const out = yield* settings.update({
        terminal_tools: [
          { id: "lg", name: " lazygit ", command: " lazygit " },
          { id: "lg", name: "htop", command: "htop" },
          { id: "bad id!", name: "btop", command: "btop" },
          { name: "k9s", command: "k9s" },
        ],
      })
      assert.deepStrictEqual(
        out.terminal_tools.map((t) => [t.name, t.command]),
        [
          ["lazygit", "lazygit"],
          ["htop", "htop"],
          ["btop", "btop"],
          ["k9s", "k9s"],
        ],
      )
      assert.strictEqual(out.terminal_tools[0]?.id, "lg")
      assert.strictEqual(new Set(out.terminal_tools.map((t) => t.id)).size, 4)
      assert.isTrue(out.terminal_tools.every((t) => /^[A-Za-z0-9_-]{1,32}$/.test(t.id)))
      const e = yield* failure(settings.update({ terminal_tools: [{ name: "x", command: " " }] }))
      assert.strictEqual(e.reason, "each terminal tool needs a name and a command")
      assert.deepStrictEqual((yield* settings.update({ terminal_tools: [] })).terminal_tools, [])
      // A stored list another build left unreadable reads as none.
      yield* (yield* SettingsRepo).set("terminal_tools", "{nope")
      assert.deepStrictEqual((yield* settings.get).terminal_tools, [])
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("keeps the switches, and emits settings_changed with all of them", () =>
    Effect.gen(function* () {
      const settings = yield* HostSettings
      const watch = yield* (yield* Events).watch(undefined)
      const out = yield* settings.update({ release_prereleases: true, settings_sync: true, default_permission_mode: "acceptEdits" })
      assert.deepStrictEqual([out.release_prereleases, out.settings_sync, out.default_permission_mode], [true, true, "acceptEdits"])
      const [event] = yield* watch.live.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(event?.type === "settings_changed" ? event.settings : null, out)
      assert.strictEqual((yield* settings.update({ release_prereleases: false })).release_prereleases, false)
      assert.strictEqual(yield* (yield* SettingsRepo).get("release_prereleases"), null)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})

describe("JsonColumn", () => {
  it.effect("reads null, unparsable text and a value of the wrong shape as its fallback", () =>
    Effect.gen(function* () {
      const column = JsonColumn(Schema.Array(Schema.String), ["fallback"])
      const read = (v: string | null) => Schema.decodeEffect(column)(v)
      assert.deepStrictEqual(yield* read('["a","b"]'), ["a", "b"])
      assert.deepStrictEqual(yield* read(null), ["fallback"])
      assert.deepStrictEqual(yield* read("{"), ["fallback"])
      assert.deepStrictEqual(yield* read('{"a":1}'), ["fallback"])
    }),
  )
})
