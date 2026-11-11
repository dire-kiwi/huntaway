import { Result, Schema } from "effect"
import { HostId } from "@huntaway/contracts"
import type { FoundHost } from "@huntaway/contracts"

// mDNS for finding hosts (inventory 05 §2.4, §3.5): DNS-SD service `_huntaway._tcp.local` (RFC 6762/6763), as much of a
// DNS message as that needs, written by hand as the old `hosts/discovery.ts` did, as plain functions. A host says how to
// reach it (its id, name, HTTP port, version and RPC protocol) and never its token. mDNS rather than a protocol of our own
// because firewalls let it through by default (ufw's and firewalld's default rules accept multicast to
// 224.0.0.251:5353), and the hosts show up in other DNS-SD browsers (`avahi-browse _huntaway._tcp`) too.

export const MDNS_PORT = 5353
export const MDNS_GROUP = "224.0.0.251"
export const SERVICE = "_huntaway._tcp.local"
const TTL = 120
const A = 1
const PTR = 12
const TXT = 16
const SRV = 33
const ANY = 255

/** What a host says about itself: how to reach it, not how to get in. */
export interface Ad {
  readonly host_id: string
  readonly host_name: string
  readonly port: number
  /** The address it listens on, when it listens on one only (`--host 192.168.1.5`). */
  readonly address?: string | undefined
  readonly version: string
  /** The RPC protocol it speaks (in place of the old `api_version`, which is gone). */
  readonly protocol: number
}

/** A host found, before it is marked linked or not. */
export type Found = Omit<FoundHost, "linked">

/** A network interface's address, as Node's `os.networkInterfaces()` gives it. */
export interface InterfaceAddress {
  readonly address: string
  readonly family: string | number
  readonly internal: boolean
}
export type Interfaces = Readonly<Record<string, ReadonlyArray<InterfaceAddress> | undefined>>

const ipv4Num = (ip: string): number | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (m === null) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  const [a = 0, b = 0, c = 0, d = 0] = parts
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

const inNet = (ip: string, net: string, bits: number): boolean => {
  const a = ipv4Num(ip.startsWith("::ffff:") ? ip.slice(7) : ip)
  const n = ipv4Num(net)
  if (a === null || n === null) return false
  const mask = (~0 << (32 - bits)) >>> 0
  return (a & mask) === (n & mask)
}

/** Tailscale's addresses (the CGNAT range it hands out). */
export const isTailscale = (ip: string) => inNet(ip, "100.64.0.0", 10)

const PRIVATE: ReadonlyArray<readonly [string, number]> = [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
]

/** Addresses a direct (unicast) query is answered from: loopback, private networks, link-local and Tailscale. */
export const isPrivate = (ip: string): boolean => PRIVATE.some(([net, bits]) => inNet(ip, net, bits)) || isTailscale(ip)

/** Bridges for containers and VMs on this machine, which no other machine is on. */
const BRIDGE = /^(docker|br-|veth|virbr|vnet|cni|flannel|podman|lxc|lxd|vmnet|vboxnet)/

/** This machine's IPv4 addresses that multicast goes out on: not loopback, Tailscale or container bridges. */
export const lanAddresses = (ifaces: Interfaces): Array<string> => {
  const out: Array<string> = []
  for (const [name, list] of Object.entries(ifaces)) {
    if (BRIDGE.test(name)) continue
    for (const i of list ?? []) {
      const v4 = i.family === "IPv4" || i.family === 4
      if (v4 && !i.internal && !isTailscale(i.address) && !out.includes(i.address)) out.push(i.address)
    }
  }
  return out
}

// ---------- DNS messages, as much of them as DNS-SD needs ----------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff)
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)

/** A label or TXT string: its length, then its bytes (at most 63 for a label, 255 for a string). */
const counted = (text: string, max: number) => {
  const bytes = encoder.encode(text).subarray(0, max)
  return concat([Uint8Array.of(bytes.length), bytes])
}

const encodeName = (name: string): Uint8Array =>
  concat([
    ...name
      .split(".")
      .filter((p) => p !== "")
      .map((p) => counted(p, 63)),
    Uint8Array.of(0),
  ])

/** A DNS record in a message: its name, type and data, and what is read of the types used here. */
export interface Record_ {
  readonly name: string
  readonly type: number
  readonly ptr?: string
  readonly srv?: { readonly port: number; readonly target: string }
  readonly txt?: Readonly<Record<string, string>>
  readonly a?: string
}

/** A DNS message as read: its id, whether it is a response, its questions' (name, type)s and its records. */
export interface Message {
  readonly id: number
  readonly response: boolean
  readonly questions: ReadonlyArray<readonly [string, number]>
  readonly records: ReadonlyArray<Record_>
}

const byteAt = (msg: Uint8Array, at: number): number => {
  const b = msg[at]
  if (b === undefined) throw new RangeError("runs off the end")
  return b
}
const readU16 = (msg: Uint8Array, at: number) => (byteAt(msg, at) << 8) | byteAt(msg, at + 1)

/** The name at `at` (following compression pointers), and where what follows it starts. */
const readName = (msg: Uint8Array, start: number): readonly [string, number] => {
  const labels: Array<string> = []
  let at = start
  let end = -1
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = byteAt(msg, at)
    if (len === 0) return [labels.join("."), end < 0 ? at + 1 : end]
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = at + 2
      at = ((len & 0x3f) << 8) | byteAt(msg, at + 1)
      continue
    }
    labels.push(decoder.decode(msg.subarray(at + 1, at + 1 + len)))
    at += 1 + len
  }
  throw new RangeError("name loops")
}

const rr = (name: string, type: number, data: Uint8Array, flush: boolean): Uint8Array =>
  concat([encodeName(name), u16(type), u16(flush ? 0x8001 : 1), u32(TTL), u16(data.length), data])

const message = (id: number, flags: number, questions: ReadonlyArray<Uint8Array>, answers: ReadonlyArray<Uint8Array>): Uint8Array =>
  concat([u16(id), u16(flags), u16(questions.length), u16(answers.length), u16(0), u16(0), ...questions, ...answers])

/** A query for the service's instances. */
export const query = (id = 0): Uint8Array => message(id, 0, [concat([encodeName(SERVICE), u16(PTR), u16(1)])], [])

/** The DNS-SD label for a host: its name and the start of its id, so two hosts called the same still differ. */
const instance = (ad: Ad): string => {
  const name = ad.host_name.replace(/\./g, " ").slice(0, 40).trim() || "huntaway"
  return `${name} ${ad.host_id.slice(0, 8)}.${SERVICE}`
}

/** The answer advertising `ad`: PTR, SRV, TXT, and an A record for each of `addresses` (or its own address). */
export const response = (ad: Ad, addresses: ReadonlyArray<string>, id = 0): Uint8Array => {
  const inst = instance(ad)
  const target = `huntaway-${ad.host_id.slice(0, 8)}.local`
  const txt: Record<string, string> = { id: ad.host_id, name: ad.host_name, v: ad.version, proto: String(ad.protocol) }
  if (ad.address !== undefined) txt["address"] = ad.address
  const a = (ad.address !== undefined ? [ad.address] : addresses).flatMap((ip) => {
    const n = ipv4Num(ip)
    return n === null ? [] : [rr(target, A, u32(n), true)]
  })
  return message(
    id,
    0x8400,
    [],
    [
      rr(SERVICE, PTR, encodeName(inst), false),
      rr(inst, SRV, concat([u16(0), u16(0), u16(ad.port), encodeName(target)]), true),
      rr(inst, TXT, concat(Object.entries(txt).map(([k, v]) => counted(`${k}=${v}`, 255))), true),
      ...a,
    ],
  )
}

const readRecord = (msg: Uint8Array, at: number): readonly [Record_, number] => {
  const [name, next] = readName(msg, at)
  const type = readU16(msg, next)
  const len = readU16(msg, next + 8)
  const start = next + 10
  if (start + len > msg.length) throw new RangeError("record runs off the end")
  const data = msg.subarray(start, start + len)
  const end = start + len
  if (type === PTR) return [{ name, type, ptr: readName(msg, start)[0] }, end]
  if (type === SRV) return [{ name, type, srv: { port: readU16(msg, start + 4), target: readName(msg, start + 6)[0] } }, end]
  if (type === A && len === 4) return [{ name, type, a: [...data].join(".") }, end]
  if (type === TXT) {
    const txt: Record<string, string> = {}
    for (let j = 0; j < len;) {
      const n = byteAt(data, j)
      const s = decoder.decode(data.subarray(j + 1, j + 1 + n))
      j += 1 + n
      const eq = s.indexOf("=")
      if (eq > 0) txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1)
    }
    return [{ name, type, txt }, end]
  }
  return [{ name, type }, end]
}

/** A DNS message read, or null for one that isn't (too short, running off its end, names that loop). */
export const parse = (msg: Uint8Array): Message | null => {
  if (msg.length < 12) return null
  try {
    const id = readU16(msg, 0)
    const flags = readU16(msg, 2)
    const qd = readU16(msg, 4)
    const count = readU16(msg, 6) + readU16(msg, 8) + readU16(msg, 10)
    let at = 12
    const questions: Array<readonly [string, number]> = []
    for (let i = 0; i < qd; i++) {
      const [name, next] = readName(msg, at)
      questions.push([name, readU16(msg, next)])
      at = next + 4
    }
    const records: Array<Record_> = []
    for (let i = 0; i < count; i++) {
      const [record, next] = readRecord(msg, at)
      records.push(record)
      at = next
    }
    return { id, response: (flags & 0x8000) !== 0, questions, records }
  } catch (e) {
    // What reading past the end or a looping name throws: the message is not DNS.
    if (e instanceof RangeError) return null
    throw e
  }
}

const lower = (s: string) => s.toLowerCase()

/** The hosts a response advertises, reached at `from` unless they say they listen on one address. */
export const hostsIn = (msg: Uint8Array, from: string): Array<Omit<Found, "via">> => {
  const p = parse(msg)
  if (p === null || !p.response) return []
  const out: Array<Omit<Found, "via">> = []
  for (const ptr of p.records) {
    if (ptr.type !== PTR || lower(ptr.name) !== SERVICE || ptr.ptr === undefined) continue
    const inst = lower(ptr.ptr)
    const srv = p.records.find((r) => r.srv !== undefined && lower(r.name) === inst)?.srv
    const txt = p.records.find((r) => r.txt !== undefined && lower(r.name) === inst)?.txt
    const id = txt?.["id"]
    if (srv === undefined || txt === undefined || id === undefined || id === "") continue
    const ip = txt["address"] || from
    const protocol = Number(txt["proto"])
    out.push({
      host_id: HostId.make(id),
      name: txt["name"] || id,
      url: `http://${ip}:${srv.port}`,
      version: txt["v"] || null,
      protocol: txt["proto"] !== undefined && txt["proto"] !== "" && Number.isInteger(protocol) ? protocol : null,
      capabilities: null,
    })
  }
  return out
}

/** Whether a message is a query for the service (or for anything, as `ANY`). */
export const asksForUs = (p: Message): boolean => !p.response && p.questions.some(([name, type]) => lower(name) === SERVICE && (type === PTR || type === ANY))

// ---------- Tailscale ----------

/** A Tailscale peer that's online. */
export interface Peer {
  readonly name: string
  readonly ip: string
}

const Status = Schema.fromJsonString(
  Schema.Struct({
    Peer: Schema.optional(
      Schema.NullOr(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            Online: Schema.optional(Schema.NullOr(Schema.Boolean)),
            TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
            DNSName: Schema.optional(Schema.NullOr(Schema.String)),
            HostName: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
)
const decodeStatus = Schema.decodeUnknownResult(Status)

/** The online peers in `tailscale status --json`'s output; null for output that isn't that. */
export const parseTailscaleStatus = (text: string): Array<Peer> | null => {
  const status = decodeStatus(text)
  if (Result.isFailure(status)) return null
  const out: Array<Peer> = []
  for (const p of Object.values(status.success.Peer ?? {})) {
    if (p.Online !== true) continue
    const ip = (p.TailscaleIPs ?? []).find((a) => ipv4Num(a) !== null)
    if (ip === undefined) continue
    const dns = typeof p.DNSName === "string" ? (p.DNSName.split(".")[0] ?? "") : ""
    out.push({ name: dns || p.HostName || ip, ip })
  }
  return out
}
