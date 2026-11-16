import { assert, describe, it } from "@effect/vitest"
import { HostId, LinkId } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { MAX_HOPS, meshEntries } from "./Mesh.ts"

// The mesh's directory (HE-46): what a host takes from its neighbours' directories, as a path vector. Whole servers in a
// chain and both ways of linking are in tests/e2e/hosts-mesh.test.ts.

const host = (id: string, more: Partial<Host> = {}): Host => ({
  id: HostId.make(id),
  name: id.toUpperCase(),
  local: false,
  connected: true,
  mode: "outbound",
  agents: true,
  url: null,
  version: "1.0.0",
  protocol: 1,
  capabilities: [],
  commit: null,
  updates_from: null,
  last_seen: null,
  last_message_at: null,
  uplink: false,
  ...more,
})

const ids = (hosts: ReadonlyArray<Host>) => hosts.map((h) => [h.id, h.through, h.route])

describe("the mesh's directory", () => {
  it("takes the hosts a neighbour reaches, through it, and leaves out itself, its own links and the neighbour", () => {
    const got = meshEntries(
      "me",
      new Set(["b"]),
      [[LinkId.make("b"), [host("b", { local: true }), host("me", { mode: "reverse" }), host("c"), host("x")]]],
      new Map([["b", "Bee"]]),
    )
    assert.deepStrictEqual(ids(got), [
      ["c", "b", ["b"]],
      ["x", "b", ["b"]],
    ])
    assert.deepStrictEqual([got[0]?.mode, got[0]?.status, got[0]?.status_reason, got[0]?.uplink], ["mesh", "connected", "through Bee", false])
  })

  it("leaves out a host this one links itself, one that is away, and a route that comes back through this host", () => {
    const got = meshEntries("me", new Set(["b", "c"]), [
      [LinkId.make("b"), [host("c"), host("d", { connected: false }), host("e", { mode: "mesh", through: HostId.make("me"), route: [HostId.make("me")] })]],
    ])
    assert.deepStrictEqual(ids(got), [])
  })

  it("takes the shorter of two routes to a host, and none longer than the limit", () => {
    const far = Array.from({ length: MAX_HOPS }, (_, i) => HostId.make(`h${i}`))
    const got = meshEntries("me", new Set(["b", "c"]), [
      [
        LinkId.make("b"),
        [host("d", { mode: "mesh", through: HostId.make("x"), route: [HostId.make("x"), HostId.make("y")] }), host("z", { mode: "mesh", route: far })],
      ],
      [LinkId.make("c"), [host("d", { mode: "mesh", through: HostId.make("y"), route: [HostId.make("y")] })]],
    ])
    assert.deepStrictEqual(ids(got), [["d", "c", ["c", "y"]]])
  })
})
