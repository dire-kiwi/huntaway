import { assert, describe, it } from "@effect/vitest"
import { DeviceId, LinkId } from "@huntaway/contracts"
import type { Scope, SessionShape } from "@huntaway/contracts"
import { assertedFor } from "./Relay.ts"

// What a relay ticket asserts for its client: `as` narrows, and never makes a device someone else (HE-91 review).

const session = (kind: SessionShape["kind"], scopes: ReadonlyArray<Scope>, device: string | null = null): SessionShape => ({
  kind,
  scopes: new Set(scopes),
  device_id: device === null ? null : DeviceId.make(device),
  via_link: kind === "link" ? LinkId.make("hub") : null,
})

describe("assertedFor", () => {
  it("a device stays itself whatever its `as` says: not the board, not another phone", () => {
    const phone = session("device", ["read", "operate"], "phone")
    const asBoard = assertedFor(phone, { kind: "board", scopes: ["read", "operate", "admin"], device_id: null }, 1)
    assert.deepStrictEqual(asBoard, { kind: "device", scopes: ["read", "operate"], device_id: DeviceId.make("phone"), exp: 1 })
    const asOther = assertedFor(phone, { kind: "device", scopes: ["read"], device_id: DeviceId.make("other") }, 1)
    assert.deepStrictEqual(asOther, { kind: "device", scopes: ["read"], device_id: DeviceId.make("phone"), exp: 1 })
  })

  it("a link's own connection relays for its client, with no more than its own scopes and never `link`", () => {
    const link = session("link", ["link", "read", "operate", "admin"])
    const forPhone = assertedFor(link, { kind: "device", scopes: ["read", "operate", "terminal"], device_id: DeviceId.make("p") }, 1)
    assert.deepStrictEqual(forPhone, { kind: "device", scopes: ["read", "operate"], device_id: DeviceId.make("p"), exp: 1 })
    assert.strictEqual(assertedFor(link, { kind: "board", scopes: ["link", "read"], device_id: null }, 1).scopes.includes("link"), false)
  })

  it("with no `as`, the asker's own session", () => {
    assert.deepStrictEqual(assertedFor(session("board", ["read", "admin"]), undefined, 1), {
      kind: "board",
      scopes: ["read", "admin"],
      device_id: null,
      exp: 1,
    })
  })
})
