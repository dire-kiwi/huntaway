import { Context } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { Auth, HostRpcs, PublicRpcs, RequiredScope } from "@huntaway/contracts"
import { Served } from "../../src/Main.ts"
import { child, isTest, listFiles, nameOf, parse, parseFailure, walk } from "./sources.ts"

// docs/effect.md, Structural tests, rule 8: every RPC in the contract states the scope it needs, and every RPC the
// server serves has a handler. The layer would fail to build without one; this names it. `HostRpcs` RPCs carry a
// `RequiredScope` and go through `Auth`; `PublicRpcs` is the one group without a session. A handler is a key of the
// handlers' object in a file under apps/server/src/rpc/ (`"tasks.create": …`). The RPCs of `HostRpcs` that
// `Served` (apps/server/src/Main.ts) does not serve yet are listed as todos, not failures, while M1 lands them.
// Board MCP tools (a schema and a handler each) come with M3, and their check with them.

const handlerKeys = (): ReadonlySet<string> => {
  const keys = new Set<string>()
  for (const path of listFiles("apps/server/src/rpc").filter((file) => !isTest(file))) {
    const parsed = parse(path)
    if (parsed.program === undefined) continue
    walk(parsed.program, (node) => {
      const key = node.type === "Property" || node.type === "MethodDefinition" ? nameOf(child(node, "key")) : undefined
      if (key !== undefined) keys.add(key)
      return true
    })
  }
  return keys
}

/** The messages of the checks that fail. */
const failing = (checks: ReadonlyArray<readonly [fails: boolean, message: string]>): ReadonlyArray<string> =>
  checks.filter(([fails]) => fails).map(([, message]) => message)

/** `Rpc.middlewares` is typed by the group's middleware, `never` for a group with none. */
const behindAuth = (middlewares: ReadonlySet<unknown>) => middlewares.has(Auth)

const hostTags = new Set(HostRpcs.requests.keys())
const publicTags = new Set(PublicRpcs.requests.keys())
const servedTags = [...Served.requests.keys()]
const unserved = [...hostTags].filter((tag) => !Served.requests.has(tag))

describe("RPCs", () => {
  it("every HostRpcs RPC states its scope and goes through Auth", () => {
    expect(
      [...HostRpcs.requests.values()].flatMap((rpc) =>
        failing([
          [Context.get(rpc.annotations, RequiredScope) === null, `${rpc._tag}: no RequiredScope annotation`],
          [!behindAuth(rpc.middlewares), `${rpc._tag}: not behind the Auth middleware`],
        ]),
      ),
    ).toEqual([])
  })

  it("PublicRpcs needs no session", () => {
    expect(
      [...PublicRpcs.requests.values()].flatMap((rpc) =>
        failing([
          [!rpc._tag.startsWith("public."), `${rpc._tag}: a public RPC is named public.*`],
          [Context.get(rpc.annotations, RequiredScope) !== null, `${rpc._tag}: a public RPC needs no scope`],
          [behindAuth(rpc.middlewares), `${rpc._tag}: a public RPC is not behind Auth`],
        ]),
      ),
    ).toEqual([])
  })

  it("every RPC served is in the contract and has a handler under apps/server/src/rpc/", () => {
    const keys = handlerKeys()
    expect(
      listFiles("apps/server/src/rpc")
        .flatMap((path) => parseFailure(parse(path)))
        .concat(
          servedTags.flatMap((tag) =>
            failing([
              [!hostTags.has(tag) && !publicTags.has(tag), `${tag}: served but in neither HostRpcs nor PublicRpcs`],
              [!keys.has(tag), `${tag}: served with no handler key "${tag}" under apps/server/src/rpc/`],
            ]),
          ),
        ),
    ).toEqual([])
  })

  // Listed while an area is still to come; empty once every RPC is served.
  if (unserved.length > 0) {
    describe("HostRpcs not served yet", () => {
      for (const tag of unserved) it.todo(tag)
    })
  }
})
