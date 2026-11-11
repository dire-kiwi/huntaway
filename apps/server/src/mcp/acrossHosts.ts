import { Effect } from "effect"
import { SecureRandom } from "effect/crypto"
import type { RemoteToolCall, ToolOutcome } from "@huntaway/contracts"
import { asciiLower } from "@huntaway/shared"
import { Identity } from "../platform/Identity.ts"
import { OtherHosts } from "./OtherHosts.ts"
import type { OtherHost } from "./OtherHosts.ts"
import { ToolError } from "./tool.ts"
import type { McpCaller } from "./tool.ts"

// A board tool call across hosts (docs/plan/08-hosts.md, Board tools across hosts; inventory 03 §2.3; the old
// `dispatch` in mcp/tools/dispatch.ts, rule for rule but for the checks of hosts on older builds, which can't link):
//
// - `host` (a name, case-insensitive, or an id) pins the call to one host: this one's own name or id means here; a
//   linked host gets it with `host` taken out; otherwise it goes up to the hub of that name (or the first hub, which may
//   link it), with `host` as it is. A call that came up from a host is never passed back down to it.
// - `list_projects`, `list_pens`, and `list_tasks` of `all` (project or profile) list every host: here, each link, then
//   each hub (an item a hub's list has that another list had already, by `id`, is left out: a hub's list covers its
//   other hosts, which may be this host's links too). A profile only on other hosts isn't "not found".
// - Anything else runs here, and what isn't found here is asked of each link, then each hub; the first that has it
//   answers. A host that has it but refused (a change that needs approval, say) has its reason told rather than "not
//   found"; a hub that doesn't take this host's calls is named in the "not found" with why.
// - A call that came up a link (`from`, that host's id) goes to this host's other links but never up again.

type Args = Readonly<Record<string, unknown>>

/** Tools that list from every host rather than look for one thing. */
export const fansOut = (tool: string, args: Args): boolean =>
  tool === "list_projects" || tool === "list_pens" || (tool === "list_tasks" && (args["project_id"] === "all" || args["profile"] === "all"))

/** Whether `o` is the host `h` names: its id, or its name in any case. */
const named = (h: string) => (o: OtherHost) => o.id === h || asciiLower(o.name) === asciiLower(h)

const withoutHost = (args: Args): Args => Object.fromEntries(Object.entries(args).filter(([k]) => k !== "host"))

/** What a hub that doesn't take this host's calls is said to need. */
const offNote = (here: string, off: ReadonlyArray<readonly [string, string | null]>) => {
  const why = off.map(
    ([hub, reason]) =>
      reason ??
      `${hub} doesn't let this host's agents use its board; the user can switch on "Let this host's agents use this board" for ${here} in Settings → Hosts there`,
  )
  return why.length > 0 ? ` (${why.join("; ")})` : ""
}

/** An error the agent is told as it is: its text is final (`not found: …`), and whether it was a not-found. */
const told = (message: string, notFound: boolean) => (notFound ? ToolError.notFound(message) : ToolError.other(message))

/** What one call of a board tool, run here by `local`, needs to go across hosts. */
export interface AcrossInput {
  readonly caller: McpCaller
  readonly tool: string
  readonly args: Args
  /** The tool run here, on these arguments. */
  readonly local: (args: Args) => Effect.Effect<unknown, ToolError>
  /** The host the call came up from (an up-call): not passed back down to it, nor further up. */
  readonly from: string | null
  /** Pass the caller's call id up (the hub runs it at most once by it); false: a fresh id for each call up. */
  readonly upById: boolean
}

export interface Across {
  /** Runs a board tool call here or on other hosts, as above; fails with what the agent is told (its text final). */
  readonly run: (input: AcrossInput) => Effect.Effect<unknown, ToolError>
}

/** The cross-host dispatch, over the other hosts and this host's identity. */
export const makeAcross = Effect.gen(function* () {
  const others = yield* OtherHosts
  const { hostId, hostName } = yield* Identity
  const random = yield* SecureRandom.SecureRandom

  const isHere = (h: string) => h === hostId || asciiLower(h) === asciiLower(hostName)
  const linksFor = (from: string | null) => Effect.map(others.links, (all) => all.filter((l) => from === null || l.id !== from))
  const hubsFor = (from: string | null) => (from === null ? others.hubs : Effect.succeed<ReadonlyArray<OtherHost>>([]))

  const run = Effect.fnUntraced(function* (input: AcrossInput) {
    const { caller, tool, args, from } = input
    const remote = (a: Args, callId: string | null): RemoteToolCall => ({ profile: caller.profile.name, tool, args: a, call_id: callId })
    const upId = input.upById ? Effect.succeed<string>(caller.call_id) : random.uuidV4()
    const down = (link: OtherHost) => link.call(remote(withoutHost(args), null))
    const up = (hub: OtherHost, id: string) => hub.call(remote(args, id))
    const here = input.local(args)

    const h = typeof args["host"] === "string" ? args["host"] : ""
    if (h !== "" && !isHere(h)) {
      const link = (yield* others.links).find(named(h))
      // Never back down: the calling host's own board is its own to ask, not this host's to pass it to.
      if (link !== undefined && from !== null && link.id === from) {
        return yield* ToolError.other(
          `${h} is the host this call came up from (${link.name}), and ${hostName} doesn't pass calls back down: leave out host to use that host's own board`,
        )
      }
      if (link !== undefined) return yield* answered(yield* down(link))
      // A hub this host is linked to, or one of its hosts: it goes there with `host` as it is.
      const hubs = yield* hubsFor(from)
      const hub = hubs.find(named(h)) ?? hubs[0]
      if (hub === undefined) return yield* ToolError.other(`no linked host named ${h}`)
      const o = yield* up(hub, yield* upId)
      if (o._tag === "Off") return yield* ToolError.other(`no linked host named ${h}${offNote(hostName, [[hub.name, o.why]])}`)
      return yield* answered(o)
    }
    if (h !== "") return yield* here

    if (fansOut(tool, args)) {
      const all: Array<unknown> = []
      // A profile that's only on other hosts isn't found here.
      let missing: string | null = null
      const mine = yield* Effect.result(here)
      if (mine._tag === "Success") {
        if (Array.isArray(mine.success)) all.push(...mine.success)
      } else if (mine.failure.notFound) missing = mine.failure.message
      else return yield* mine.failure
      for (const link of yield* linksFor(from)) {
        const o = yield* down(link)
        if (o._tag === "Ok" && Array.isArray(o.value)) {
          all.push(...o.value)
          missing = null
        } else if (o._tag === "Err") yield* Effect.logDebug(`${tool} on ${link.name}: ${o.message}`)
      }
      const id = yield* upId
      for (const hub of yield* hubsFor(from)) {
        const o = yield* up(hub, id)
        if (o._tag === "Ok" && Array.isArray(o.value)) {
          const seen = new Set(all.map(idOf).filter((x) => x !== null))
          all.push(...o.value.filter((item) => !seen.has(idOf(item) ?? "")))
          missing = null
        } else if (o._tag === "Err") yield* Effect.logDebug(`${tool} on ${hub.name}: ${o.message}`)
      }
      if (missing !== null && all.length === 0) return yield* ToolError.notFound(`not found: ${missing}`)
      return all
    }

    const result = yield* Effect.result(here)
    if (result._tag === "Success") return result.success
    const e = result.failure
    if (!e.notFound) return yield* e
    // Why a host that has it couldn't do it (a change that needs approval, say), rather than "not found".
    let refused: string | null = null
    for (const link of yield* linksFor(from)) {
      const o = yield* down(link)
      if (o._tag === "Ok") return o.value
      if (o._tag === "Err" && !o.not_found) refused ??= o.message
    }
    // Then the hubs that take this host's calls, which look on their own boards and their other hosts.
    const off: Array<readonly [string, string | null]> = []
    const hubs = yield* hubsFor(from)
    for (const hub of hubs) {
      const o = yield* up(hub, yield* upId)
      if (o._tag === "Ok") return o.value
      if (o._tag === "Off") off.push([hub.name, o.why])
      else if (!o.not_found) refused ??= o.message
    }
    if (refused !== null) return yield* ToolError.other(refused)
    return yield* ToolError.notFound(`not found: ${e.message}${offNote(hostName, off)}`)
  })

  const across: Across = { run }
  return across
})

/** An outcome from another host as the agent is told it. */
const answered = (o: ToolOutcome): Effect.Effect<unknown, ToolError> =>
  o._tag === "Ok" ? Effect.succeed(o.value) : Effect.fail(o._tag === "Err" ? told(o.message, o.not_found) : ToolError.other(o.why ?? "not taken"))

/** An item's `id`, if it has a string one. */
const idOf = (item: unknown): string | null => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null
  const id: unknown = Object.entries(item).find(([k]) => k === "id")?.[1]
  return typeof id === "string" ? id : null
}
