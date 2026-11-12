import { Context, Effect, Layer, Option } from "effect"
import { Conflict, HostId, LinkId, NotFound, PROTOCOL, Unavailable } from "@huntaway/contracts"
import type { AssistantTask, Invalid, ProfileId, Task } from "@huntaway/contracts"
import { Assistant } from "../assistant/Assistant.ts"
import { Identity } from "../platform/Identity.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import type { SendRefused } from "../runs/Runs.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { LinkConnections } from "./LinkConnections.ts"
import type { Live } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"

// A profile's assistant on a host of its own (docs/plan/08-hosts.md, As built HE-8; inventory 02 §2.12, 05 §9; the old
// agent/assistant.ts `on_its_host`): a profile can name a linked host for its assistant (`assistant_host`), so its
// thread, memory, routines and agents' credentials stay on that machine. `assistant.get` and `assistant.send` on this
// host then go to that host over the link, to its profile of the same name (profiles are matched by name across hosts),
// asking for its own assistant there (`here`), so that host's profile naming another host (back to this one, say)
// doesn't send it on again. Asked with `here`, or for a profile whose assistant is on this host, it's this host's.
//
// The link is the one the hub keeps (`LinkConnections`): a host dialling in under the id of an assistant host the hub
// dials is refused when it attaches (08-hosts.md, the trust rules), so the user's messages never reach a stand-in.

type Errors = NotFound | Invalid | Conflict | Unavailable

export interface AssistantHostShape {
  /** The profile's assistant where it runs (made there the first time it's asked for), with that host's id. */
  readonly get: (profile: ProfileId, here: boolean) => Effect.Effect<AssistantTask, Errors>
  /** Sends the user's message to the profile's assistant where it runs, as `Assistant.send` does there. */
  readonly send: (profile: ProfileId, text: string, here: boolean) => Effect.Effect<AssistantTask, Errors | TaskNotFound | SendRefused>
}

export class AssistantHost extends Context.Service<AssistantHost, AssistantHostShape>()("huntaway-server/hosts/AssistantHost") {
  static readonly layer = Layer.effect(
    AssistantHost,
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const profiles = yield* ProfileRepo
      const links = yield* LinkRepo
      const connections = yield* LinkConnections
      const identity = yield* Identity

      const mine = (task: Task): AssistantTask => Object.assign({ host_id: HostId.make(identity.hostId) }, task)

      /** The profile's assistant host and the profile of its name there, when it's another host's; none for this host's. */
      const elsewhere = Effect.fnUntraced(function* (profile: ProfileId) {
        const found = yield* profiles.get(profile)
        if (Option.isNone(found)) return yield* new NotFound({ what: "profile", id: profile })
        const p = found.value
        if (p.assistant_host === null || String(p.assistant_host) === String(identity.hostId)) return null
        const host = LinkId.make(p.assistant_host)
        const name = (yield* links.get(host))?.name ?? host
        const offline = new Unavailable({ what: "assistant host", reason: `${p.name}'s assistant runs on ${name}, which is offline` })
        const live: Live = yield* connections.live(host).pipe(Effect.mapError(() => offline))
        if (live.hello.protocol !== PROTOCOL) {
          return yield* new Unavailable({ what: "assistant host", reason: `${p.name}'s assistant runs on ${name}, which needs an update` })
        }
        // What went wrong on the way there, as the assistant's host being out of reach.
        const unreachable = (e: { readonly _tag: string }) =>
          new Unavailable({ what: "assistant host", reason: `${p.name}'s assistant runs on ${name}, which couldn't be reached (${e._tag})` })
        const theirs = yield* live.client("profiles.list", undefined).pipe(Effect.mapError(unreachable))
        const there = theirs.find((q) => q.name === p.name)
        if (there === undefined) {
          return yield* new Conflict({ reason: "no_profile", detail: `${name} has no profile named ${p.name}, for its assistant; add one there` })
        }
        return { live, profile: there.id, unreachable }
      })

      const get = Effect.fn("AssistantHost.get")(function* (profile: ProfileId, here: boolean) {
        const there = here ? null : yield* elsewhere(profile)
        if (there === null) return mine(yield* assistant.get(profile, true))
        return yield* there.live.client("assistant.get", { profile_id: there.profile, here: true }).pipe(
          Effect.catchTags({
            RpcClientError: (e) => Effect.fail(there.unreachable(e)),
            Unauthorized: (e) => Effect.fail(there.unreachable(e)),
            Forbidden: (e) => Effect.fail(there.unreachable(e)),
          }),
        )
      })

      const send = Effect.fn("AssistantHost.send")(function* (profile: ProfileId, text: string, here: boolean) {
        const there = here ? null : yield* elsewhere(profile)
        if (there === null) return mine(yield* assistant.send(profile, text, true))
        return yield* there.live.client("assistant.send", { profile_id: there.profile, text, here: true }).pipe(
          Effect.catchTags({
            RpcClientError: (e) => Effect.fail(there.unreachable(e)),
            Unauthorized: (e) => Effect.fail(there.unreachable(e)),
            Forbidden: (e) => Effect.fail(there.unreachable(e)),
          }),
        )
      })

      return AssistantHost.of({ get, send })
    }),
  )

  /**
   * A read-only server's (docs/plan/06-server.md, A read-only server): it has no links, so a profile's assistant is
   * always this board's own, whatever host the profile names.
   */
  static readonly readOnly = Layer.effect(
    AssistantHost,
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const identity = yield* Identity
      const mine = (task: Task): AssistantTask => Object.assign({ host_id: HostId.make(identity.hostId) }, task)
      return AssistantHost.of({
        get: (profile) => Effect.map(assistant.get(profile, true), mine),
        send: (profile, text) => Effect.map(assistant.send(profile, text, true), mine),
      })
    }),
  )
}
