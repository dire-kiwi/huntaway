import { Context, Effect, Layer, Schema, Stream } from "effect"
import { RpcSchema } from "effect/rpc"
import type { Rpc, RpcGroup } from "effect/rpc"
import { HubHostRpcs, Invalid, NotFound, PublicRpcs, RequiredScope } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { LinkRepo } from "../hosts/LinkRepo.ts"
import { linkEntry, localEntry } from "../hosts/Links.ts"
import { About } from "../settings/About.ts"

// The handlers a read-only server (docs/plan/06-server.md, A read-only server) adds to the board's own: a handler for
// every RPC that dies without acting, put over the board's handlers for every RPC that is not a read, and the public and
// hub groups' reads, which on a rehearsal reach no other host and give no token. `Auth.readOnly` refuses a change
// before its handler is looked at; these are what a change would meet if it ever got past.

/** Whether an RPC only reads: its `RequiredScope` is `read`. Public RPCs have none. */
export const isRead = (rpc: Rpc.AnyWithProps): boolean => Context.get(rpc.annotations, RequiredScope) === "read"

/** What a refused handler dies with: a change reached a read-only server's handler, past `Auth.readOnly`. */
export class RefusedOnReadOnly extends Schema.TaggedError<RefusedOnReadOnly, { readonly brand: unique symbol }>()("RefusedOnReadOnly", {
  rpc: Schema.String,
}) {}

/** Handlers for `rpcs` that die with `RefusedOnReadOnly`, without acting. */
const refusing = (rpcs: ReadonlyArray<Rpc.AnyWithProps>) =>
  Effect.map(Effect.context(), (context) => {
    const handlers = new Map<string, unknown>()
    for (const rpc of rpcs) {
      const refused = new RefusedOnReadOnly({ rpc: rpc._tag })
      handlers.set(rpc.key, {
        tag: rpc._tag,
        handler: () => (RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.die(refused) : Effect.die(refused)),
        context,
      })
    }
    return handlers
  })

/**
 * A handler for every RPC of `group` that refuses it: what an RPC without a read-only handler meets (the rehearsal's
 * service test calls every read and fails on this, so a new read is not forgotten).
 */
export const refuseAll = <R extends Rpc.AnyWithProps>(group: RpcGroup.RpcGroup<R>): Layer.Layer<Rpc.ToHandler<R>> =>
  Layer.effectContext(Effect.map(refusing([...group.requests.values()]), (handlers) => Context.makeUnsafe<Rpc.ToHandler<R>>(handlers)))

/** Refusing handlers for the RPCs of `group` that are not reads, to put over handlers that would act. */
export const refuseChanges = <R extends Rpc.AnyWithProps>(group: RpcGroup.RpcGroup<R>): Layer.Layer<never> =>
  Layer.effectContext(
    Effect.map(refusing([...group.requests.values()].filter((rpc) => !isRead(rpc) && !PublicRpcs.requests.has(rpc._tag))), (handlers) =>
      Context.makeUnsafe(handlers),
    ),
  )

/** `public.*`: the health; never the token, whatever `--open-token` says (a rehearsal still requires it). */
export const ReadOnlyPublicHandlers = PublicRpcs.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    return PublicRpcs.of({
      "public.health": () => about.health,
      "public.openToken": () => Effect.fail(new NotFound({ what: "route", id: "public.openToken" })),
    })
  }),
)

/** `hub.hosts.*`'s reads: this host, and any linked host as offline (a rehearsal dials and accepts no links). */
export const ReadOnlyHubHandlers = HubHostRpcs.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    const links = yield* LinkRepo
    const list: Effect.Effect<ReadonlyArray<Host>> = Effect.gen(function* () {
      const rows = yield* links.list
      return [localEntry(yield* about.info), ...rows.map((row) => linkEntry(row, undefined))]
    })
    const changes = Effect.die(new RefusedOnReadOnly({ rpc: "hub.hosts" }))
    return HubHostRpcs.of({
      "hub.hosts.watch": () => Stream.concat(Stream.fromEffect(list), Stream.never),
      "hub.hosts.list": () => list,
      "hub.hosts.openRelay": ({ host_id }) =>
        Effect.fail(new Invalid({ field: "host_id", reason: `a read-only rehearsal reaches no other host (${host_id})` })),
      "hub.hosts.add": () => changes,
      "hub.hosts.addSsh": () => changes,
      "hub.hosts.sshKey": () => changes,
      "hub.hosts.join": () => changes,
      "hub.hosts.discover": () => changes,
      "hub.hosts.update": () => changes,
      "hub.hosts.remove": () => changes,
      "hub.hosts.copyConfig": () => changes,
      "hub.hosts.pushUpdate": () => changes,
    })
  }),
)
