import { boardAtom, callRpc, invalidateGroups } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { LinkId } from "@huntaway/contracts"
import { Effect, Exit, Option, Schedule } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { exitError } from "../../../state/mutation"
import { compareVersions } from "../versions"
import { hubMutate } from "./hub"

// A linked host's Update, and the cluster's (HE-76): Update on one host sends the update to every linked host that
// differs from this board, and follows each to its end here, not on its row, so an Update started from one host's page,
// or a row scrolled away, still ends; each row (HostVersion) shows where its host's has got to.

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
  /** The restart's phase while it updates (`starting` until the host says otherwise), null when none is under way. */
  readonly phase: string | null
  readonly error: string | null
  readonly upToDate: boolean
}

export const idleUpdate: UpdateState = { phase: null, error: null, upToDate: false }

/** Each host's Update, by host id, for as long as the page is open. */
export const hostUpdateAtom = Atom.family((_host: string) => Atom.make<UpdateState>(idleUpdate).pipe(Atom.keepAlive))

/** How long a read of the host's status may take: one this page can't reach (on another protocol) doesn't answer. */
const READ = "5 seconds"
/** How often a host that's updating is asked how it's going. */
const POLL = "1.5 seconds"
/** How long a host is followed before its Update is given up on. */
const GIVE_UP = "30 minutes"

/** The host's status, `None` when it doesn't answer in time; a failure when it can't be read (it's restarting). */
const statusOf = (host: string) => callRpc(host, "admin.status", undefined).pipe(Effect.timeoutOption(READ))

/**
 * Follows `host`'s Update until it's over: it is listed on what it was sent (`back`), it booted again (another boot id
 * than `boot`), or, its boot unread before, it answers with no restart under way; or its restart failed.
 */
const follow = (host: string, boot: string | null, back: (listed: Host) => boolean): Effect.Effect<void, never, AtomRegistry.AtomRegistry> => {
  const atom = hostUpdateAtom(host)
  const step = Effect.gen(function* () {
    const listed = (yield* Atom.get(boardAtom)).hosts.find((h) => h.id === host)
    if (listed && back(listed)) return yield* Atom.set(atom, idleUpdate).pipe(Effect.as(true))
    const read = yield* Effect.exit(statusOf(host))
    // Not answering: as it was. Failing: it's restarting.
    if (Exit.isFailure(read)) return yield* Atom.update(atom, (s) => ({ ...s, phase: "restarting" })).pipe(Effect.as(false))
    if (Option.isNone(read.value)) return false
    const st = read.value.value
    if (boot ? st.boot_id !== boot : !st.restart) return yield* Atom.set(atom, idleUpdate).pipe(Effect.as(true))
    if (st.restart?.phase === "failed") return yield* Atom.set(atom, { ...idleUpdate, error: st.restart.error ?? "update failed" }).pipe(Effect.as(true))
    const phase = st.restart?.phase
    if (phase) yield* Atom.update(atom, (s) => ({ ...s, phase }))
    return false
  })
  return step.pipe(
    Effect.repeat({ schedule: Schedule.spaced(POLL), until: (done) => done }),
    Effect.timeoutOption(GIVE_UP),
    Effect.flatMap((done) => (Option.isNone(done) ? Atom.set(atom, { ...idleUpdate, error: "it hasn't come back after 30 minutes" }) : Effect.void)),
  )
}

/** What follows a host's Update to its end, once every host has been sent theirs. */
type Following = () => Effect.Effect<void, never, AtomRegistry.AtomRegistry>

/**
 * Sends `host` this board's update (`hub.hosts.pushUpdate`), noting where it is in `hostUpdateAtom`, and gives what
 * follows it to its end (null when there's nothing to follow: it failed, or was up to date). `offer` is what it's sent.
 */
const sendUpdate = (host: Host, offer: UpdateOffer): Effect.Effect<Following | null, never, AtomRegistry.AtomRegistry> =>
  Effect.gen(function* () {
    const atom = hostUpdateAtom(host.id)
    yield* Atom.set(atom, { ...idleUpdate, phase: "starting" })
    // Its boot id, to tell it came back by. Not read from a host this page can't reach (one on another protocol, which
    // the hub lists not connected: the read would wait for it for good), nor for long, nor past a failure: with no boot
    // it's over once it's back on what it was sent, or answers again with no restart under way.
    const boot = host.connected
      ? yield* statusOf(host.id).pipe(
          Effect.map((st) => Option.getOrNull(Option.map(st, (s) => s.boot_id))),
          Effect.catchCause(() => Effect.succeed(null)),
        )
      : null
    const exit = yield* Effect.exit(hubMutate("hub.hosts.pushUpdate", { id: LinkId.make(host.id) }))
    // The host's status read before the update isn't what it says now.
    yield* invalidateGroups(host.id, ["admin"])
    if (Exit.isFailure(exit)) return yield* Atom.set(atom, { ...idleUpdate, error: exitError(exit) ?? "update failed" }).pipe(Effect.as(null))
    if (exit.value.up_to_date) return yield* Atom.set(atom, { ...idleUpdate, upToDate: true }).pipe(Effect.as(null))
    const { to, release } = offer
    return () => follow(host.id, boot, (listed) => !!to && (release ? listed.version === to : listed.commit === to))
  }).pipe(
    // Whatever else goes wrong ends it, rather than leaving the row "starting" for good.
    Effect.catchCause((cause) =>
      Atom.set(hostUpdateAtom(host.id), { ...idleUpdate, error: exitError(Exit.failCause(cause)) ?? "update failed" }).pipe(Effect.as(null)),
    ),
  )

/** The hosts an Update of `first` updates: `first` and every other host in `hosts` that Update is offered for. */
export const clusterOf = (first: Host, hosts: ReadonlyArray<Host>, local: Host | undefined, target: string | null): ReadonlyArray<Host> => [
  first,
  ...hosts.filter((h) => h.id !== first.id && offerOf(h, local, target).can),
]

/**
 * Updates each of `hosts` but those already updating, so one Update brings the whole cluster to this board's code or
 * release (`local` and `target` as for `offerOf`): sent a few at a time (each is a git bundle the hub makes and sends),
 * then each followed to its end. Never fails: each host's own state says how it went.
 */
export const updateHosts = (
  hosts: ReadonlyArray<Host>,
  local: Host | undefined,
  target: string | null,
): Effect.Effect<void, never, AtomRegistry.AtomRegistry> =>
  Effect.forEach(
    hosts,
    (host) =>
      Effect.flatMap(Atom.get(hostUpdateAtom(host.id)), (s) => (s.phase === null ? sendUpdate(host, offerOf(host, local, target)) : Effect.succeed(null))),
    { concurrency: 4 },
  ).pipe(
    Effect.flatMap((follows) =>
      Effect.all(
        follows.flatMap((f) => (f === null ? [] : [f()])),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  )
