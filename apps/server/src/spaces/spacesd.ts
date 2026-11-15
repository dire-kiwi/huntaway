// What the host's server says to a Space's spacesd (HE-35), plainly: one gRPC-Web call, `SystemService.CreateViewerTicket`
// (Cua's `libs/cua/proto/cua/env/v1/system.proto`), whose request and answer are written and read here by hand rather
// than with a protobuf library for one small message each way. Plus what the relay changes in spacesd's answers so its
// viewer works inside the board. No I/O here.

/** The gRPC-Web path of the call. */
export const CREATE_VIEWER_TICKET = "/cua.env.v1.SystemService/CreateViewerTicket"

/** `SessionPolicy`: a viewer that only watches, or one whose input may activate windows. */
export const POLICY_VIEW_ONLY = 1
export const POLICY_ALLOW_ACTIVATION = 3

const varint = (n: number): ReadonlyArray<number> => {
  const out: Array<number> = []
  let v = Math.max(0, Math.floor(n))
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return out
}

const field = (no: number, wire: number) => varint(no * 8 + wire)

const bytesField = (no: number, value: ReadonlyArray<number>) => [...field(no, 2), ...varint(value.length), ...value]

/**
 * `CreateViewerTicketRequest { ttl = 1 (Duration: seconds = 1), policy = 2, clipboard = 3, files_root = 4 }` in a
 * gRPC-Web frame (a zero flag byte and the message's length, big-endian).
 */
export const viewerTicketRequest = (o: {
  readonly ttlSeconds: number
  readonly policy: number
  readonly clipboard: boolean
  readonly filesRoot: string
}): Uint8Array => {
  const message = [
    ...bytesField(1, [...field(1, 0), ...varint(o.ttlSeconds)]),
    ...field(2, 0),
    ...varint(o.policy),
    ...(o.clipboard ? [...field(3, 0), 1] : []),
    ...(o.filesRoot === "" ? [] : bytesField(4, [...new TextEncoder().encode(o.filesRoot)])),
  ]
  const n = message.length
  return Uint8Array.from([0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...message])
}

/** What is read of `CreateViewerTicketResponse`. */
export interface ViewerTicket {
  readonly ticket: string
  /** Seconds since the epoch; 0 when it wasn't said. */
  readonly expiresAt: number
}

/** The message's fields: varints by number and length-delimited ones' bytes by number. Null if it doesn't parse. */
const readFields = (b: Uint8Array): { readonly ints: Map<number, number>; readonly bytes: Map<number, Uint8Array> } | null => {
  const ints = new Map<number, number>()
  const bytes = new Map<number, Uint8Array>()
  let i = 0
  const readVarint = (): number | null => {
    let v = 0
    let mul = 1
    for (;;) {
      const x = b[i++]
      if (x === undefined) return null
      v += (x & 0x7f) * mul
      if (x < 0x80) return v
      mul *= 0x80
    }
  }
  while (i < b.length) {
    const key = readVarint()
    if (key === null) return null
    const no = Math.floor(key / 8)
    switch (key % 8) {
      case 0: {
        const v = readVarint()
        if (v === null) return null
        ints.set(no, v)
        break
      }
      case 2: {
        const len = readVarint()
        if (len === null || i + len > b.length) return null
        bytes.set(no, b.subarray(i, i + len))
        i += len
        break
      }
      case 1:
        i += 8
        break
      case 5:
        i += 4
        break
      default:
        return null
    }
  }
  return { ints, bytes }
}

/** The ticket in a gRPC-Web answer to `CreateViewerTicket` (its first data frame), or why there is none. */
export const parseViewerTicket = (body: Uint8Array): ViewerTicket | string => {
  // Frames: a flag byte (0x80 for the trailers), four bytes of length, the payload.
  let at = 0
  let message: Uint8Array | null = null
  let trailers = ""
  while (at + 5 <= body.length) {
    const flag = body[at] ?? 0
    const len = ((body[at + 1] ?? 0) << 24) | ((body[at + 2] ?? 0) << 16) | ((body[at + 3] ?? 0) << 8) | (body[at + 4] ?? 0)
    const payload = body.subarray(at + 5, at + 5 + len)
    if ((flag & 0x80) === 0) message ??= payload
    else trailers = new TextDecoder().decode(payload)
    at += 5 + len
  }
  const status = /grpc-status:\s*(\d+)/u.exec(trailers)?.[1]
  if (status !== undefined && status !== "0") {
    const said = /grpc-message:\s*(.*)/u.exec(trailers)?.[1]?.trim()
    return `spacesd refused a viewer ticket (${status}${said === undefined || said === "" ? "" : `: ${decodeURIComponent(said)}`})`
  }
  if (message === null) return "spacesd answered without a viewer ticket"
  const fields = readFields(message)
  const ticket = fields?.bytes.get(1)
  if (fields === null || ticket === undefined || ticket.length === 0) return "spacesd's viewer ticket didn't parse"
  const expires = fields.bytes.get(2)
  return { ticket: new TextDecoder().decode(ticket), expiresAt: expires === undefined ? 0 : (readFields(expires)?.ints.get(1) ?? 0) }
}

/** A gRPC-Web answer's status when it came in the headers (a call refused before any frame). */
export const headerStatus = (headers: Readonly<Record<string, string | undefined>>): string | null => {
  const status = headers["grpc-status"]
  if (status === undefined || status === "0") return null
  return `spacesd refused a viewer ticket (${status}${headers["grpc-message"] === undefined ? "" : `: ${decodeURIComponent(headers["grpc-message"])}`})`
}

/** Headers that are about one connection, not the message, and are never passed on by the relay. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // The relay's HTTP client decodes the body, so it isn't encoded any more.
  "content-encoding",
])

/** The headers of a request the relay passes on to spacesd: without the hop-by-hop ones and the board's cookies. */
export const requestHeaders = (headers: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) => {
      const key = k.toLowerCase()
      return v === undefined || HOP_BY_HOP.has(key) || key === "cookie" || key === "origin" || key === "referer" ? [] : [[key, v]]
    }),
  )

/**
 * The headers of spacesd's answer as the relay gives them: without the hop-by-hop ones, a redirect kept under the
 * relay's path (`prefix`), and the viewer allowed in the board's own frames (spacesd's `frame-ancestors 'none'`).
 */
export const responseHeaders = (headers: Readonly<Record<string, string | undefined>>, prefix: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) => {
      const key = k.toLowerCase()
      if (v === undefined || HOP_BY_HOP.has(key)) return []
      if (key === "location" && v.startsWith("/") && !v.startsWith("//")) return [[key, `${prefix}${v}`]]
      if (key === "content-security-policy") return [[key, v.replace(/frame-ancestors[^;]*/u, "frame-ancestors 'self'")]]
      return [[key, v]]
    }),
  )
