import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { PushEventsPatch, PushKind, PushSubscriptionId, Timestamp } from "@huntaway/contracts"
import type { PushDevice, PushEvents } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { toJson } from "../platform/columns.ts"
import { DEFAULT_EVENTS, MISSING_EVENTS, mergedEvents } from "./rules.ts"

// The `push_subscriptions` table (docs/plan/inventory/06-integrations.md 3.3): a device's subscription, its keys and the
// events it wants. Single statements; `SqlError` and `SchemaError` are defects. Nothing here waits.

/** A subscription as the board keeps it: what it shows, and the keys a push is encrypted with (base64url). */
export interface Subscription extends PushDevice {
  readonly p256dh: string
  readonly auth: string
}

const Row = Schema.Struct({
  id: PushSubscriptionId,
  endpoint: Schema.String,
  kind: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  name: Schema.String,
  device_id: Schema.NullOr(Schema.String),
  events: Schema.String,
  created_at: Timestamp,
  last_sent_at: Schema.NullOr(Timestamp),
  last_error: Schema.NullOr(Schema.String),
})

const decodeEvents = Schema.decodeUnknownOption(Schema.fromJsonString(PushEventsPatch))
const isKind = Schema.is(PushKind)

/** Stored events read leniently: a field left out is `MISSING_EVENTS`' (no reports), and a value that doesn't read is the defaults. */
export const storedEvents = (text: string): PushEvents =>
  Option.match(decodeEvents(text), {
    onNone: () => DEFAULT_EVENTS,
    onSome: (patch) => mergedEvents(MISSING_EVENTS, patch),
  })

const fromRow = (r: typeof Row.Type): Subscription => ({
  ...r,
  kind: isKind(r.kind) ? r.kind : "web",
  events: storedEvents(r.events),
})

const found = <E>(o: Effect.Effect<Option.Option<typeof Row.Type>, E>) =>
  o.pipe(
    Effect.map((r) => (Option.isSome(r) ? fromRow(r.value) : null)),
    Effect.orDie,
  )
const run = <A, E>(statement: Effect.Effect<A, E>) => Effect.orDie(Effect.asVoid(statement))
/** Whether a statement with `RETURNING` changed a row. */
const changed = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
  statement.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.orDie,
  )

/** What showing a subscription leaves out: its keys. */
export const shown = ({ p256dh: _p256dh, auth: _auth, ...device }: Subscription): PushDevice => device

export interface PushRepoShape {
  /** Every subscription, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<Subscription>>
  readonly get: (id: string) => Effect.Effect<Subscription | null>
  readonly byEndpoint: (endpoint: string) => Effect.Effect<Subscription | null>
  readonly insert: (sub: Omit<Subscription, "last_sent_at" | "last_error">) => Effect.Effect<void>
  /** A browser that subscribed again: its keys and name, its events if given; its last error is forgotten. */
  readonly resubscribe: (
    id: PushSubscriptionId,
    keys: { readonly p256dh: string; readonly auth: string },
    name: string,
    events: PushEvents | null,
  ) => Effect.Effect<void>
  readonly setName: (id: PushSubscriptionId, name: string) => Effect.Effect<void>
  readonly setEvents: (id: PushSubscriptionId, events: PushEvents) => Effect.Effect<void>
  /** Whether there was one to delete. */
  readonly delete: (id: string) => Effect.Effect<boolean>
  /**
   * How a push went, noted only while the subscription still has the endpoint it went to: sent (`last_sent_at`, the
   * error forgotten), failed (`last_error`), or gone (deleted; whether it was).
   */
  readonly sent: (id: PushSubscriptionId, endpoint: string, at: Timestamp) => Effect.Effect<void>
  readonly failed: (id: PushSubscriptionId, endpoint: string, error: string) => Effect.Effect<void>
  readonly gone: (id: PushSubscriptionId, endpoint: string) => Effect.Effect<boolean>
}

export class PushRepo extends Context.Service<PushRepo, PushRepoShape>()("huntaway-server/push/PushRepo") {
  static readonly layer = Layer.effect(
    PushRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const all = SqlSchema.findAll({ Request: Schema.Void, Result: Row, execute: () => sql`SELECT * FROM push_subscriptions ORDER BY created_at, id` })
      const one = SqlSchema.findOneOption({ Request: Schema.String, Result: Row, execute: (id) => sql`SELECT * FROM push_subscriptions WHERE id = ${id}` })
      const byEndpointRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Row,
        execute: (endpoint) => sql`SELECT * FROM push_subscriptions WHERE endpoint = ${endpoint}`,
      })
      return PushRepo.of({
        list: all(undefined).pipe(
          Effect.map((rows) => rows.map(fromRow)),
          Effect.orDie,
        ),
        get: (id) => found(one(id)),
        byEndpoint: (endpoint) => found(byEndpointRow(endpoint)),
        insert: (s) =>
          Effect.flatMap(toJson(s.events), (events) =>
            run(sql`INSERT INTO push_subscriptions (id, endpoint, kind, p256dh, auth, name, device_id, events, created_at)
              VALUES (${s.id}, ${s.endpoint}, ${s.kind}, ${s.p256dh}, ${s.auth}, ${s.name}, ${s.device_id}, ${events}, ${s.created_at})`),
          ),
        resubscribe: (id, keys, name, events) =>
          Effect.flatMap(events === null ? Effect.succeed(null) : toJson(events), (json) =>
            run(sql`UPDATE push_subscriptions SET p256dh = ${keys.p256dh}, auth = ${keys.auth}, name = ${name},
              events = COALESCE(${json}, events), last_error = NULL WHERE id = ${id}`),
          ),
        setName: (id, name) => run(sql`UPDATE push_subscriptions SET name = ${name} WHERE id = ${id}`),
        setEvents: (id, events) => Effect.flatMap(toJson(events), (json) => run(sql`UPDATE push_subscriptions SET events = ${json} WHERE id = ${id}`)),
        delete: (id) => changed(sql`DELETE FROM push_subscriptions WHERE id = ${id} RETURNING id`),
        sent: (id, endpoint, at) => run(sql`UPDATE push_subscriptions SET last_sent_at = ${at}, last_error = NULL WHERE id = ${id} AND endpoint = ${endpoint}`),
        failed: (id, endpoint, error) => run(sql`UPDATE push_subscriptions SET last_error = ${error} WHERE id = ${id} AND endpoint = ${endpoint}`),
        gone: (id, endpoint) => changed(sql`DELETE FROM push_subscriptions WHERE id = ${id} AND endpoint = ${endpoint} RETURNING id`),
      })
    }),
  )
}
