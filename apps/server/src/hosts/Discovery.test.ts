import { assert, describe, it } from "@effect/vitest"
import { HostId, LinkId, Timestamp } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { markDiscovered, meshCandidates } from "./Discovery.ts"
import type { Found } from "./discovery/dns.ts"
import type { LinkRow } from "./LinkRepo.ts"

// The hub's side of finding hosts (the old discovery.test.ts, `mark_discovered` and `through_links`): what is left out
// and what is marked linked. The mesh through real linked hosts is in tests/e2e/hosts-sync.test.ts.

const link = (id: string, url: string | null): LinkRow => ({
  id: LinkId.make(id),
  name: id,
  mode: "outbound",
  url,
  token: "tok",
  ssh: null,
  uplink: false,
  last_seen: null,
  created_at: Timestamp.make("2026-11-12T00:00:00.000Z"),
})

const found = (hostId: string | null, url: string, via: Found["via"] = "lan"): Found => ({
  host_id: hostId === null ? null : HostId.make(hostId),
  name: hostId ?? "old",
  url,
  via,
  version: null,
  protocol: 1,
  capabilities: null,
})

const host = (id: string, url: string | null, local = false): Host => ({
  id: HostId.make(id),
  name: id,
  local,
  connected: true,
  mode: local ? "local" : "outbound",
  agents: true,
  url,
  version: "1.0.0",
  protocol: 1,
  capabilities: [],
  commit: null,
  updates_from: null,
  last_seen: null,
  last_message_at: null,
  uplink: false,
})

describe("discovery on a hub", () => {
  it("leaves out this host and marks linked ones, by id or by URL", () => {
    const got = markDiscovered(
      "me",
      [link("linked-id", "http://10.0.0.9:7878/")],
      [
        found("me", "http://10.0.0.1:7878"),
        found("linked-id", "http://10.0.0.2:7878"),
        found(null, "http://10.0.0.9:7878", "tailscale"),
        found("new-id", "http://10.0.0.3:7878"),
      ],
    )
    const expected: Array<readonly [string | null, boolean]> = [
      ["linked-id", true],
      [null, true],
      ["new-id", false],
    ]
    assert.deepStrictEqual(
      got.map((h) => [h.host_id === null ? null : String(h.host_id), h.linked] as const),
      expected,
    )
  })

  it("the hosts a linked host links are candidates once each, if linked by URL and not here already", () => {
    const got = meshCandidates("me", new Set(["linked-id"]), [
      {
        through: "b",
        hosts: [
          host("B", null, true),
          host("C", "http://10.0.0.5:7879/"),
          host("C", "http://10.0.0.5:7879"),
          host("S", "ssh://box"),
          host("me", "http://10.0.0.1:7879"),
          host("linked-id", "http://10.0.0.6:7879"),
          host("D", null),
        ],
      },
      { through: "q", hosts: [host("C", "http://10.0.0.7:7879"), host("E", "https://e.example.com")] },
    ])
    assert.deepStrictEqual(
      got.map((c) => [c.through, c.host.id, c.url]),
      [
        ["b", "C", "http://10.0.0.5:7879"],
        ["q", "E", "https://e.example.com"],
      ],
    )
  })
})
