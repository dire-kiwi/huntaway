import { describe, expect, it } from "@effect/vitest"
import { HostId } from "@huntaway/contracts"
import { addFound, BOARD_PORT, candidates, foundBoard, isPrivateLan, neighbours, parsePort, pinOf } from "../src/logic/discovery"

describe("neighbours", () => {
  it("asks the rest of a private /24, nearest first", () => {
    const n = neighbours("192.168.1.20")
    expect(n).toHaveLength(253)
    expect(n.slice(0, 3)).toEqual(["192.168.1.19", "192.168.1.21", "192.168.1.18"])
    expect(n).not.toContain("192.168.1.20")
    expect(n).not.toContain("192.168.1.0")
    expect(n).not.toContain("192.168.1.255")
  })

  it("asks nothing off a private LAN: mobile data, Tailscale, not an address", () => {
    expect(neighbours("100.101.102.103")).toEqual([])
    expect(neighbours("8.8.8.8")).toEqual([])
    expect(neighbours("0.0.0.0")).toEqual([])
    expect(neighbours("192.168.1")).toEqual([])
    expect(neighbours("fe80::1")).toEqual([])
  })

  it("knows the private ranges", () => {
    expect(["10.0.0.5", "172.16.3.4", "172.31.0.1", "192.168.0.9"].map(isPrivateLan)).toEqual([true, true, true, true])
    expect(["172.32.0.1", "172.15.0.1", "192.169.0.1", "100.64.0.1"].map(isPrivateLan)).toEqual([false, false, false, false])
  })
})

describe("candidates", () => {
  it("puts the extra addresses first, each address once, on the port", () => {
    const urls = candidates("10.0.2.15", ["10.0.2.2", "127.0.0.1"], BOARD_PORT)
    expect(urls.slice(0, 2)).toEqual(["http://10.0.2.2:7879", "http://127.0.0.1:7879"])
    expect(urls.filter((u) => u === "http://10.0.2.2:7879")).toHaveLength(1)
    expect(candidates(null, ["127.0.0.1"], 8080)).toEqual(["http://127.0.0.1:8080"])
  })
})

describe("parsePort and pinOf", () => {
  it("takes a port", () => {
    expect([parsePort(" 7879 "), parsePort("0"), parsePort("70000"), parsePort("x")]).toEqual([7879, null, null, null])
  })
  it("takes a PIN with spaces or a dash, and nothing else", () => {
    expect([pinOf("123 456"), pinOf("123-456"), pinOf("12345"), pinOf("abcdef"), pinOf("1234567")]).toEqual(["123456", "123456", null, null, null])
  })
})

describe("foundBoard and addFound", () => {
  const health = { ok: true as const, host_id: HostId.make("h1"), version: "1", protocol: 1, capabilities: ["device_pairing"], commit: null }
  it("names a board by its name, else its address, and knows whether it pairs", () => {
    expect(foundBoard("http://10.0.0.2:7879", { ...health, name: "studio" })).toEqual({
      url: "http://10.0.0.2:7879",
      name: "studio",
      hostId: "h1",
      pairs: true,
    })
    expect(foundBoard("http://10.0.0.2:7879", { ...health, capabilities: [] })).toMatchObject({ name: "10.0.0.2:7879", pairs: false })
  })
  it("lists a board answering on two addresses once", () => {
    const a = foundBoard("http://10.0.0.2:7879", health)
    const b = foundBoard("http://127.0.0.1:7879", health)
    expect(addFound(addFound([], a), b)).toEqual([a])
  })
})
