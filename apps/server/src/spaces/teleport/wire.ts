// What the host's server says to a Space's spacesd to teleport sign-ins into it (HE-49): `cua.env.v1.TeleportService`
// (Cua's `libs/cua/proto/cua/env/v1/teleport.proto`) over gRPC-Web, its few messages written and read here by hand as
// `spacesd.ts` does `CreateViewerTicket`'s. No I/O here.

const SERVICE = "/cua.env.v1.TeleportService"
export const GET_MANIFEST = `${SERVICE}/GetManifest`
export const IMPORT_SESSION = `${SERVICE}/ImportSession`
export const WIPE_IMPORT = `${SERVICE}/WipeImport`

/** spacesd takes chunks of at most 4 MiB (`MAX_CHUNK_BYTES`); 1 MiB is what it prefers. */
export const CHUNK_BYTES = 1024 * 1024

/** The bundle format spacesd's teleport takes (`BUNDLE_VERSION`). */
export const BUNDLE_VERSION = 1

/** `TeleportScope.TELEPORT_SCOPE_SESSION`: cookies and storage. */
const SCOPE_SESSION = 1

// ---- writing ----

const varint = (n: number): Array<number> => {
  const out: Array<number> = []
  let v = Math.max(0, Math.floor(n))
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return out
}

const key = (no: number, wire: number) => varint(no * 8 + wire)
const uint = (no: number, n: number): Array<number> => (n === 0 ? [] : [...key(no, 0), ...varint(n)])
const bool = (no: number, b: boolean): Array<number> => (b ? [...key(no, 0), 1] : [])
const bytes = (no: number, value: Uint8Array | ReadonlyArray<number>): Array<number> =>
  value.length === 0 ? [] : [...key(no, 2), ...varint(value.length), ...value]
const text = (no: number, s: string) => bytes(no, new TextEncoder().encode(s))

/** A message in a gRPC-Web frame: a zero flag byte, its length big-endian, the message. */
const frame = (head: ReadonlyArray<number>, tail: Uint8Array = new Uint8Array(0)): Uint8Array => {
  const n = head.length + tail.length
  const out = new Uint8Array(5 + n)
  out.set([0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff], 0)
  out.set(head, 5)
  out.set(tail, 5 + head.length)
  return out
}

/** `GetManifestRequest { app = 1, scope = 2 }`. */
export const manifestRequest = (app: string): Uint8Array => frame([...text(1, app), ...uint(2, SCOPE_SESSION)])

export interface ImportChunk {
  readonly importId: string
  readonly app: string
  readonly offset: number
  readonly data: Uint8Array
  /** The last chunk, with the whole bundle's lowercase hex SHA-256 and when the Space wipes it (0: never). */
  readonly commit: { readonly sha256: string; readonly expiresAtMs: number } | null
}

/**
 * `ImportSessionRequest { import_id = 1, app = 2, scope = 3, offset = 4, data = 5, commit = 6, sha256 = 7, options = 8 }`,
 * with `ImportOptions { expires_at_ms = 4 }` on the last chunk. The browser is closed by the server first
 * (`close_running_app` is refused on Linux) and not launched after: an agent or the user opens it.
 */
export const importRequest = (c: ImportChunk): Uint8Array => {
  // `data` (field 5) goes last on the wire: fields may come in any order, and so the chunk isn't copied into an array.
  const head = [
    ...text(1, c.importId),
    ...text(2, c.app),
    ...uint(3, SCOPE_SESSION),
    ...uint(4, c.offset),
    ...(c.commit === null ? [] : [...bool(6, true), ...text(7, c.commit.sha256), ...bytes(8, uint(4, c.commit.expiresAtMs))]),
    ...(c.data.length === 0 ? [] : [...key(5, 2), ...varint(c.data.length)]),
  ]
  return frame(head, c.data)
}

/** `WipeImportRequest { import_id = 1 }`. */
export const wipeRequest = (importId: string): Uint8Array => frame(text(1, importId))

// ---- reading ----

/** A message's fields by number, in order: varints as numbers, length-delimited ones as bytes. Null if it doesn't parse. */
type Fields = Map<number, Array<number | Uint8Array>>

const readFields = (b: Uint8Array): Fields | null => {
  const out: Fields = new Map()
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
  const add = (no: number, v: number | Uint8Array) => out.set(no, [...(out.get(no) ?? []), v])
  while (i < b.length) {
    const k = readVarint()
    if (k === null) return null
    const no = Math.floor(k / 8)
    switch (k % 8) {
      case 0: {
        const v = readVarint()
        if (v === null) return null
        add(no, v)
        break
      }
      case 2: {
        const len = readVarint()
        if (len === null || i + len > b.length) return null
        add(no, b.subarray(i, i + len))
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
  return out
}

const decoder = new TextDecoder()
const intOf = (f: Fields, no: number): number => {
  const v = f.get(no)?.at(-1)
  return typeof v === "number" ? v : 0
}
const textsOf = (f: Fields, no: number): Array<string> => (f.get(no) ?? []).flatMap((v) => (typeof v === "number" ? [] : [decoder.decode(v)]))
const messageOf = (f: Fields, no: number): Fields | null => {
  const v = f.get(no)?.at(-1)
  return v === undefined || typeof v === "number" ? null : readFields(v)
}

/** `grpc-message`'s text, percent-decoded as gRPC sends it, or as it came when it isn't valid. */
const percentDecoded = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A gRPC-Web answer's status when it came in the headers (a call refused before any frame); null when it is OK. */
export const headerRefusal = (headers: Readonly<Record<string, string | undefined>>): string | null => {
  const status = headers["grpc-status"]
  if (status === undefined || status === "0") return null
  const said = headers["grpc-message"]
  return `${status}${said === undefined || said === "" ? "" : `: ${percentDecoded(said)}`}`
}

/** The message of a gRPC-Web answer (its first data frame), or why there is none ("<status>: <message>"). */
export const unframe = (body: Uint8Array): { readonly message: Uint8Array } | { readonly refused: string } => {
  let at = 0
  let message: Uint8Array | null = null
  let trailers = ""
  while (at + 5 <= body.length) {
    const flag = body[at] ?? 0
    // Unsigned, so a length with its top bit set can't go negative and stall the loop (the answer is the Space's).
    const len = (body[at + 1] ?? 0) * 0x1000000 + (body[at + 2] ?? 0) * 0x10000 + (body[at + 3] ?? 0) * 0x100 + (body[at + 4] ?? 0)
    if (at + 5 + len > body.length) return { refused: "the answer didn't parse" }
    const payload = body.subarray(at + 5, at + 5 + len)
    if ((flag & 0x80) === 0) message ??= payload
    else trailers = decoder.decode(payload)
    at += 5 + len
  }
  const status = /grpc-status:\s*(\d+)/u.exec(trailers)?.[1]
  if (status !== undefined && status !== "0") {
    const said = /grpc-message:\s*(.*)/u.exec(trailers)?.[1]?.trim()
    return { refused: `${status}${said === undefined || said === "" ? "" : `: ${percentDecoded(said)}`}` }
  }
  // A message with no fields is sent as an empty frame, or (some servers) as none.
  return { message: message ?? new Uint8Array(0) }
}

/** What is read of `GetManifestResponse`. */
export interface Manifest {
  readonly supported: boolean
  readonly limitation: string
  readonly bundleVersion: number
  readonly supportedApps: ReadonlyArray<string>
}

export const parseManifest = (m: Uint8Array): Manifest | null => {
  const f = readFields(m)
  if (f === null) return null
  return { supported: intOf(f, 1) !== 0, limitation: textsOf(f, 2)[0] ?? "", bundleVersion: intOf(f, 5), supportedApps: textsOf(f, 7) }
}

/** What is read of `ImportSessionResponse`: the bytes received, and on the last chunk `ImportResult`. */
export interface ImportAnswer {
  readonly receivedBytes: number
  readonly result: { readonly imported: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } | null
}

export const parseImport = (m: Uint8Array): ImportAnswer | null => {
  const f = readFields(m)
  if (f === null) return null
  const r = messageOf(f, 3)
  return { receivedBytes: intOf(f, 1), result: r === null ? null : { imported: textsOf(r, 1), skipped: textsOf(r, 2) } }
}

/** What is read of `WipeImportResponse`: the imports wiped and how many paths and cookie rows went. */
export interface WipeAnswer {
  readonly wiped: ReadonlyArray<string>
  readonly removedPaths: number
  readonly cookieRowsRemoved: number
}

export const parseWipe = (m: Uint8Array): WipeAnswer | null => {
  const f = readFields(m)
  if (f === null) return null
  return { wiped: textsOf(f, 1), removedPaths: (f.get(2) ?? []).length, cookieRowsRemoved: intOf(f, 4) }
}

/** gRPC's NOT_FOUND, which `WipeImport` answers for an import the Space doesn't have (wiped already, or expired). */
export const NOT_FOUND = "5"
