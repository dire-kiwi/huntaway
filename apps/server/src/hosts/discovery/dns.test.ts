import { assert, describe, it } from "@effect/vitest"
import { HostId } from "@huntaway/contracts"
import { hostsHeard, hostsIn, isPrivate, lanAddresses, parse, parseTailscaleStatus, query, response, SERVICE } from "./dns.ts"
import type { Ad } from "./dns.ts"

// The old discovery.test.ts's pure cases: the DNS-SD record, which addresses are answered and used, Tailscale's status.

const ad = (hostId: string, port: number): Ad => ({ host_id: hostId, host_name: `name-${hostId}`, port, version: "1.2.3", protocol: 1 })

describe("mDNS records", () => {
  it("an advertisement reads back as the host, at the address it came from", () => {
    const msg = response(ad("0123456789abcdef", 7999), ["192.168.1.20"])
    const p = parse(msg)
    assert.isTrue(p?.response)
    assert.deepStrictEqual(
      p?.records.map((r) => r.type),
      [12, 33, 16, 1],
    )
    assert.strictEqual(p?.records[3]?.a, "192.168.1.20")
    assert.deepStrictEqual(hostsIn(msg, "10.0.0.5"), [
      {
        host_id: HostId.make("0123456789abcdef"),
        name: "name-0123456789abcdef",
        url: "http://10.0.0.5:7999",
        version: "1.2.3",
        protocol: 1,
        capabilities: null,
      },
    ])
    // A query isn't a response, and nonsense is nothing.
    assert.deepStrictEqual(hostsIn(query(), "10.0.0.5"), [])
    assert.deepStrictEqual(hostsIn(new TextEncoder().encode("hello there, this is not DNS"), "10.0.0.5"), [])
    assert.deepStrictEqual(parse(query())?.questions, [[SERVICE, 12]])
    // Cut short, it is no message at all.
    assert.isNull(parse(msg.subarray(0, msg.length - 3)))
  })

  it("a host that listens on one address gives that address", () => {
    assert.strictEqual(hostsIn(response({ ...ad("h2", 7878), address: "192.168.1.9" }, []), "10.0.0.5")[0]?.url, "http://192.168.1.9:7878")
  })

  // Review of HE-6: the TXT record's `address=` is anyone's on the network. One that isn't an IPv4 address used to go
  // into the URL as it was: `[` or `a b` made `new URL` throw in the browser's listener, `x/y@z` pointed elsewhere.
  it("an address that isn't IPv4 is not taken: the host is where it was heard from", () => {
    for (const address of ["a b", "[", "::1", "x/y@z", "evil.example", "1.2.3.4/x", "999.1.1.1"]) {
      const heard = hostsHeard(response({ ...ad("h4", 7878), address }, []), "10.0.0.5")
      assert.deepStrictEqual(
        heard.map((h) => [h.ip, h.host.url]),
        [["10.0.0.5", "http://10.0.0.5:7878"]],
        address,
      )
    }
    // An IPv4-mapped sender is its IPv4 address; one that is no IPv4 address at all is not listed.
    assert.strictEqual(hostsIn(response(ad("h5", 7878), []), "::ffff:10.0.0.6")[0]?.url, "http://10.0.0.6:7878")
    assert.deepStrictEqual(hostsIn(response({ ...ad("h6", 7878), address: "[" }, []), "fe80::1"), [])
  })

  it("the record never carries more than how to reach the host", () => {
    const text = new TextDecoder().decode(response(ad("h3", 7000), ["10.0.0.1"]))
    for (const key of ["id=h3", "name=name-h3", "v=1.2.3", "proto=1"]) assert.include(text, key)
    assert.notInclude(text, "token")
  })
})

const iface = (address: string, internal = false) => ({ address, family: "IPv4", internal })

describe("addresses", () => {
  it("only direct queries from private, loopback and Tailscale addresses are answered", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.5", "169.254.1.1", "100.101.102.103", "::ffff:192.168.1.2"]) {
      assert.isTrue(isPrivate(ip), ip)
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "::1", "fe80::1"]) assert.isFalse(isPrivate(ip), ip)
  })

  it("multicast goes out on each IPv4 network but loopback and Tailscale", () => {
    const got = lanAddresses({
      lo: [iface("127.0.0.1", true)],
      eth0: [iface("192.168.1.20"), { address: "fe80::1", family: "IPv6", internal: false }],
      wlan0: [iface("10.0.5.7")],
      tailscale0: [iface("100.100.1.2")],
      docker0: [iface("172.17.0.1")],
      "br-1d1ed880e0f0": [iface("172.27.0.1")],
    })
    assert.deepStrictEqual(got, ["192.168.1.20", "10.0.5.7"])
  })
})

describe("Tailscale", () => {
  it("tailscale status: online peers, by their MagicDNS name, with their IPv4 address", () => {
    const peers = parseTailscaleStatus(`{
      "Self": { "HostName": "me", "TailscaleIPs": ["100.64.0.1"], "Online": true },
      "Peer": {
        "a": { "HostName": "Desk Top", "DNSName": "desktop.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.2", "fd7a:115c::2"], "Online": true },
        "b": { "HostName": "phone", "DNSName": "phone.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.3"], "Online": false },
        "c": { "HostName": "nas", "TailscaleIPs": ["fd7a:115c::4", "100.64.0.4"], "Online": true }
      }
    }`)
    assert.deepStrictEqual(peers, [
      { name: "desktop", ip: "100.64.0.2" },
      { name: "nas", ip: "100.64.0.4" },
    ])
    assert.isNull(parseTailscaleStatus("not json"))
    assert.deepStrictEqual(parseTailscaleStatus("{}"), [])
  })
})
