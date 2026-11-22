import { invalidateGroups, query } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { LinkId } from "@huntaway/contracts"
import { Effect, Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { exitError } from "../../../state/mutation"
import { compareVersions } from "../versions"
import { hubMutate } from "./hub"

// A linked host's Update, and the cluster's (HE-76): Update on one host sends the update to every linked host that
// differs from this board, each followed on its own row (HostVersion). What each one's Update has got to is kept per
// host, off the row, so an Update started from one host's page, or a row scrolled away, still ends where it's shown.

/** What Update would take `host` to: whether it's offered, and the release or the commit it sends. */
export interface UpdateOffer {
  readonly can: boolean
  /** A host installed from a release goes by version: Update takes it to the release this board runs. */
  readonly release: boolean
  /** The version (a release host) or the commit it is sent. */
  readonly to: string | null
}

/**
 * Whether Update is offered for `host`, `local` being this board's host and `target` the commit an Update sends
 * (`useUpdateCommit`): a linked host this board reaches itself (not one through another host, which its own link
 * updates), live (or on another protocol), on another commit, or a release host on an older release.
 */
export function offerOf(host: Host, local: Host | undefined, target: string | null): UpdateOffer {
  const outdated = host.status === "needs_update"
  const release = host.updates_from === "releases"
  const releaseTarget = release && local?.version && host.version && compareVersions(local.version, host.version) > 0 ? local.version : null
  const differs = !!host.commit && !!target && host.commit !== target
  const live = host.status === "connected" || outdated
  const can = !host.local && host.mode !== "mesh" && live && (release ? !!releaseTarget : !!host.commit && !!target && (differs || outdated))
  return { can, release, to: release ? releaseTarget : target }
}

/** Where a host's Update is. */
export interface UpdateState {
  /** The restart's phase while it updates (`starting` until the hub has sent it), null when none is under way. */
  readonly phase: string | null
  /** The host's boot id before the update: it's over when that changes, as the restart's state goes with the old server. */
  readonly boot: string | null
  /** The hub has sent the update: what the host's status says from then on is about it. */
  readonly sent: boolean
  readonly error: string | null
  readonly upToDate: boolean
}

export const idleUpdate: UpdateState = { phase: null, boot: null, sent: false, error: null, upToDate: false }

/** Each host's Update, by host id, for as long as the page is open. */
export const hostUpdateAtom = Atom.family((_host: string) => Atom.make<UpdateState>(idleUpdate).pipe(Atom.keepAlive))

/** Sends `host` this board's update (`hub.hosts.pushUpdate`), noting where it is in `hostUpdateAtom`. */
const sendUpdate = (host: Host): Effect.Effect<void, never, AtomRegistry.AtomRegistry> =>
  Effect.gen(function* () {
    const atom = hostUpdateAtom(host.id)
    yield* Atom.set(atom, { ...idleUpdate, phase: "starting" })
    const boot = yield* Atom.getResult(query("admin.status", host.id, undefined), { suspendOnWaiting: true }).pipe(
      Effect.map((st) => st.boot_id),
      Effect.orElseSucceed(() => null),
    )
    yield* Atom.update(atom, (s) => ({ ...s, boot }))
    const exit = yield* Effect.exit(hubMutate("hub.hosts.pushUpdate", { id: LinkId.make(host.id) }))
    // The host's status read before the update isn't what it says now.
    yield* invalidateGroups(host.id, ["admin"])
    if (Exit.isFailure(exit)) yield* Atom.set(atom, { ...idleUpdate, error: exitError(exit) ?? "update failed" })
    else if (exit.value.up_to_date) yield* Atom.set(atom, { ...idleUpdate, upToDate: true })
    else yield* Atom.update(atom, (s) => ({ ...s, sent: true }))
  })

/** The hosts an Update of `first` updates: `first` and every other host in `hosts` that Update is offered for. */
export const clusterOf = (first: Host, hosts: ReadonlyArray<Host>, local: Host | undefined, target: string | null): ReadonlyArray<Host> => [
  first,
  ...hosts.filter((h) => h.id !== first.id && offerOf(h, local, target).can),
]

/**
 * Updates each of `hosts` but those already updating, a few at a time (each is a git bundle the hub makes and sends), so
 * one Update brings the whole cluster to this board's code or release. Never fails: each host's own state says how it went.
 */
export const updateHosts = (hosts: ReadonlyArray<Host>): Effect.Effect<void, never, AtomRegistry.AtomRegistry> =>
  Effect.forEach(hosts, (host) => Effect.flatMap(Atom.get(hostUpdateAtom(host.id)), (s) => (s.phase === null ? sendUpdate(host) : Effect.void)), {
    concurrency: 4,
    discard: true,
  })
