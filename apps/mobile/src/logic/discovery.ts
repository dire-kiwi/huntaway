import { Capability, type Health, PIN_DIGITS } from "@huntaway/contracts"

// Finding boards on the phone's network (HE-91): the phone asks every address of its own /24 (a home or office Wi-Fi)
// for `/api/health` on the port boards listen on, and lists the ones that answer as a board does. Plain HTTP over the
// LAN, so it works in Expo Go with no native module; boards on Tailscale or another network are typed in by address.

/** The port a board listens on unless told otherwise (`huntaway serve`'s default). */
export const BOARD_PORT = 7879

/** A board that answered. */
export interface FoundBoard {
  /** `http://<address>:<port>`. */
  readonly url: string
  readonly name: string
  readonly hostId: string
  /** It pairs by PIN (`device_pairing`); an older one takes only its token. */
  readonly pairs: boolean
}

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** An IPv4 address's four numbers, or null for anything else (pure). */
const octets = (ip: string): readonly [number, number, number, number] | null => {
  const parts = ip.trim().split(".")
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return null
  const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number)
  return [a, b, c, d]
}

/** Whether `ip` is on a private network a board's LAN could be on: 10/8, 172.16/12, 192.168/16 (pure). */
export const isPrivateLan = (ip: string): boolean => {
  const o = octets(ip)
  if (o === null) return false
  const [a, b] = o
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * The other addresses of `ip`'s /24, nearest first (a router hands out addresses near its own and the phone's), or none
 * when `ip` isn't on a private LAN: a phone on mobile data or only on Tailscale has no neighbours to ask (pure).
 */
export function neighbours(ip: string): ReadonlyArray<string> {
  const o = octets(ip)
  if (o === null || !isPrivateLan(ip)) return []
  const [a, b, c, own] = o
  return Array.from({ length: 254 }, (_, i) => i + 1)
    .filter((d) => d !== own)
    .toSorted((x, y) => Math.abs(x - own) - Math.abs(y - own) || x - y)
    .map((d) => `${a}.${b}.${c}.${d}`)
}

/** The addresses to ask on `port`: `extra` first (this computer, an emulator's host), then the neighbours, each once (pure). */
export const candidates = (ip: string | null, extra: ReadonlyArray<string>, port: number): ReadonlyArray<string> =>
  [...new Set([...extra, ...(ip === null ? [] : neighbours(ip))])].map((host) => `http://${host}:${port}`)

/** The port typed, if it is one (pure). */
export const parsePort = (text: string): number | null => {
  const t = text.trim()
  if (!/^\d{1,5}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 65_535 ? n : null
}

/** What a board at `url` said of itself, as the list shows it (pure). */
export const foundBoard = (url: string, health: Health): FoundBoard => ({
  url,
  name: health.name ?? url.replace(/^https?:\/\//, ""),
  hostId: health.host_id,
  pairs: health.capabilities.includes(Capability.devicePairing),
})

/** A PIN as typed, its digits only, if it is one: spaces and dashes are dropped (pure). */
export const pinOf = (text: string): string | null => {
  const digits = text.replace(/[\s-]/g, "")
  return new RegExp(`^\\d{${PIN_DIGITS}}$`).test(digits) ? digits : null
}

/** Boards found so far, each once (by its host id: a board answering on two addresses is one), in the order found (pure). */
export const addFound = (found: ReadonlyArray<FoundBoard>, board: FoundBoard): ReadonlyArray<FoundBoard> =>
  found.some((f) => f.hostId === board.hostId) ? found : [...found, board]
