import { Option } from "effect"
import type { VapidJwk } from "../../../push/crypto.ts"
import { b64, unb64 } from "../../../push/crypto.ts"

// The old board's VAPID key (`vapid_private_key`, docs/plan/11-migration.md, Table by table) as the new server keeps it
// (`vapid_key`, a JWK `{d, x, y}`; 06-server.md, As built in 6.8). The old key is the bare P-256 scalar, base64url: the
// old server worked out its public point with node:crypto's ECDH. WebCrypto (and so effect/crypto) can't import an EC
// private key without its public point, and a Node builtin isn't imported here, so the point is worked out below: the
// scalar times the curve's base point, in plain bigint arithmetic. It runs once per import, on one key.

/** P-256 (FIPS 186-4, D.1.2.3): the field prime, the curve's `b` (its `a` is -3), the base point and the group order. */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

interface Point {
  readonly x: bigint
  readonly y: bigint
}

const mod = (a: bigint): bigint => {
  const r = a % P
  return r < 0n ? r + P : r
}

const pow = (base: bigint, exp: bigint): bigint => {
  let result = 1n
  let b = mod(base)
  let e = exp
  while (e > 0n) {
    if ((e & 1n) === 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }
  return result
}

/** The inverse in the field (Fermat: P is prime). */
const inv = (a: bigint): bigint => pow(a, P - 2n)

/** The sum of two points; null is the point at infinity. */
const add = (p: Point | null, q: Point | null): Point | null => {
  if (p === null) return q
  if (q === null) return p
  if (p.x === q.x) {
    if (mod(p.y + q.y) === 0n) return null
    // Doubling: slope (3x² + a) / 2y with a = -3.
    const s = mod((3n * p.x * p.x - 3n) * inv(2n * p.y))
    const x = mod(s * s - 2n * p.x)
    return { x, y: mod(s * (p.x - x) - p.y) }
  }
  const s = mod((q.y - p.y) * inv(q.x - p.x))
  const x = mod(s * s - p.x - q.x)
  return { x, y: mod(s * (p.x - x) - p.y) }
}

/** `k` times the base point (double and add). */
const times = (k: bigint): Point | null => {
  let result: Point | null = null
  let addend: Point | null = { x: GX, y: GY }
  let e = k
  while (e > 0n) {
    if ((e & 1n) === 1n) result = add(result, addend)
    addend = add(addend, addend)
    e >>= 1n
  }
  return result
}

const toBigint = (bytes: Uint8Array): bigint => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)

const toBytes = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Whether a point is on the curve: y² = x³ - 3x + b. */
export const onCurve = (p: Point): boolean => mod(p.y * p.y) === mod(p.x * p.x * p.x - 3n * p.x + B)

/**
 * The old `vapid_private_key` (a P-256 scalar, base64url without padding, as the old `webpush.ts` wrote it; node leaves
 * out leading zeros, so it may be shorter than 32 bytes) as the new server's JWK. None for a value that is not such a
 * scalar, which the old server failed to read too.
 */
export const vapidJwkFromScalar = (stored: string): Option.Option<VapidJwk> => {
  const text = stored.trim()
  // The old reader was strict: URL-safe base64 without padding.
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return Option.none()
  const bytes = unb64(text)
  if (bytes === null || bytes.length === 0 || bytes.length > 32) return Option.none()
  const d = toBigint(bytes)
  if (d === 0n || d >= N) return Option.none()
  const point = times(d)
  if (point === null || !onCurve(point)) return Option.none()
  return Option.some({ d: b64(toBytes(d)), x: b64(toBytes(point.x)), y: b64(toBytes(point.y)) })
}
