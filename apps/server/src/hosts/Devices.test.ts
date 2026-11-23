import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { PIN_DIGITS, PIN_TRIES, PIN_TTL_SECS } from "@huntaway/contracts"
import { TestPlatform } from "@huntaway/testing"
import { DeviceRepo } from "./DeviceRepo.ts"
import { Devices, normalPin, tryPin } from "./Devices.ts"

// Paired devices (HE-91): pairing mode's PIN, its tries and its end; tokens kept as hashes; unpairing.

const TestDevices = Devices.layer.pipe(Layer.provideMerge(DeviceRepo.layer), Layer.provideMerge(TestPlatform()))

/** The tag a failed effect failed with, or "ok". */
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit) ? "ok" : Exit.findErrorOption(exit).pipe((e) => (e._tag === "Some" ? e.value._tag : "defect")),
  )

/** A PIN that isn't `pin`. */
const other = (pin: string) => (pin === "000000" ? "111111" : "000000")

describe("tryPin", () => {
  const mode = { pin: "123456", expires: 1000, tries: 2 }
  it("takes the PIN with spaces or dashes, and ends the mode", () => {
    assert.strictEqual(normalPin(" 123-456 "), "123456")
    assert.deepStrictEqual(tryPin(mode, "123 456", 0), [{ _tag: "Right" }, null])
  })
  it("counts a wrong PIN, and ends the mode with the last try", () => {
    const [first, after] = tryPin(mode, "654321", 0)
    assert.deepStrictEqual(first, { _tag: "Wrong", left: 1 })
    assert.deepStrictEqual(tryPin(after, "654321", 0), [{ _tag: "Wrong", left: 0 }, null])
  })
  it("is off once the PIN has expired, or with none", () => {
    assert.deepStrictEqual(tryPin(mode, "123456", 1000), [{ _tag: "Off" }, null])
    assert.deepStrictEqual(tryPin(null, "123456", 0), [{ _tag: "Off" }, null])
  })
})

describe("Devices", () => {
  it.effect("pairs one phone per PIN, keeps its token as a hash only, and knows the token", () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const pairing = yield* devices.startPairing
      assert.match(pairing.pin, new RegExp(`^\\d{${PIN_DIGITS}}$`))
      assert.strictEqual(pairing.tries_left, PIN_TRIES)
      const paired = yield* devices.pair(pairing.pin, "  Pixel 8 ")
      assert.strictEqual(paired.device.name, "Pixel 8")
      // The PIN is used up: pairing mode is off.
      assert.strictEqual(yield* outcome(devices.pair(pairing.pin, "Another")), "Unavailable")
      const listed = yield* devices.list(null)
      assert.deepStrictEqual(
        listed.devices.map((d) => d.id),
        [paired.device.id],
      )
      assert.isNull(listed.pairing)
      const row = yield* (yield* DeviceRepo).get(paired.device.id)
      assert.notInclude(Object.values(row ?? {}).map(String), paired.token)
      assert.match(row?.token_hash ?? "", /^[0-9a-f]{64}$/)
      assert.deepStrictEqual(yield* devices.byToken(paired.token), Option.some(paired.device.id))
      assert.strictEqual((yield* devices.byToken(`${paired.token}x`))._tag, "None")
    }).pipe(Effect.provide(TestDevices)),
  )

  it.effect("ends pairing mode after the wrong PINs it takes, and when its time is up", () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const { pin } = yield* devices.startPairing
      for (let i = 1; i < PIN_TRIES; i++) assert.strictEqual(yield* outcome(devices.pair(other(pin), "x")), "Invalid")
      assert.strictEqual(yield* outcome(devices.pair(other(pin), "x")), "Unavailable")
      // Even the right PIN, now.
      assert.strictEqual(yield* outcome(devices.pair(pin, "x")), "Unavailable")
      const again = yield* devices.startPairing
      yield* TestClock.adjust(`${PIN_TTL_SECS} seconds`)
      assert.strictEqual(yield* outcome(devices.pair(again.pin, "x")), "Unavailable")
      assert.isNull((yield* devices.list(null)).pairing)
    }).pipe(Effect.provide(TestDevices)),
  )

  it.effect("a new PIN replaces the one showing; stopping pairing ends it", () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const first = yield* devices.startPairing
      const second = yield* devices.startPairing
      if (first.pin !== second.pin) assert.strictEqual(yield* outcome(devices.pair(first.pin, "x")), "Invalid")
      yield* devices.stopPairing
      assert.strictEqual(yield* outcome(devices.pair(second.pin, "x")), "Unavailable")
    }).pipe(Effect.provide(TestDevices)),
  )

  it.effect("unpairing refuses the token from then on and ends `revoked`", () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const paired = yield* devices.pair((yield* devices.startPairing).pin, "Phone")
      const waiting = yield* Effect.forkChild(devices.revoked(paired.device.id))
      yield* devices.revoke(paired.device.id)
      yield* Fiber.join(waiting)
      assert.strictEqual((yield* devices.byToken(paired.token))._tag, "None")
      assert.strictEqual(yield* outcome(devices.revoke(paired.device.id)), "NotFound")
      assert.deepStrictEqual((yield* devices.list(null)).devices, [])
    }).pipe(Effect.provide(TestDevices)),
  )
})
