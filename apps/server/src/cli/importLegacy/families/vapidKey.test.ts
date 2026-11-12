import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { createECDH } from "node:crypto"
import { vapidJwkFromScalar } from "./vapidKey.ts"

// The old VAPID scalar's public point, against node:crypto's (what the old webpush.ts used).

const oldKey = () => {
  const e = createECDH("prime256v1")
  e.generateKeys()
  const k = e.getPrivateKey()
  return { e, scalar: k.length >= 32 ? k : Buffer.concat([Buffer.alloc(32 - k.length), k]) }
}

describe("vapidJwkFromScalar", () => {
  it("works out the public point node:crypto does", () => {
    for (let i = 0; i < 8; i++) {
      const { e, scalar } = oldKey()
      const jwk = Option.getOrThrow(vapidJwkFromScalar(scalar.toString("base64url")))
      const pub = e.getPublicKey()
      expect(jwk).toEqual({
        d: scalar.toString("base64url"),
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33, 65).toString("base64url"),
      })
    }
  })

  it("pads a scalar node wrote without its leading zeros", () => {
    const short = Buffer.alloc(31, 7)
    const jwk = Option.getOrThrow(vapidJwkFromScalar(short.toString("base64url")))
    const e = createECDH("prime256v1")
    e.setPrivateKey(short)
    expect(jwk.d).toBe(Buffer.concat([Buffer.alloc(1), short]).toString("base64url"))
    expect(jwk.x).toBe(e.getPublicKey().subarray(1, 33).toString("base64url"))
  })

  it.each([
    ["empty", ""],
    ["not base64url", "abc+/def"],
    ["padded", Buffer.alloc(32, 1).toString("base64")],
    ["too long", Buffer.alloc(33, 1).toString("base64url")],
    ["zero", Buffer.alloc(32).toString("base64url")],
    ["the group order or more", Buffer.alloc(32, 0xff).toString("base64url")],
  ])("refuses %s", (_, value) => {
    expect(Option.isNone(vapidJwkFromScalar(value))).toBe(true)
  })
})
