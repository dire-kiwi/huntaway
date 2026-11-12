import { Effect, Result, Schema } from "effect"
import { PushEventsPatch } from "@huntaway/contracts"
import { LinkRow, SshTarget } from "../../../hosts/LinkRepo.ts"
import { OutboxRow } from "../../../platform/TelemetryRepo.ts"
import { SubscriptionRow } from "../../../push/PushRepo.ts"
import { decodeOld, keyOf } from "../family.ts"
import type { Family, FamilyIo, NewRow, TableCheck } from "../family.ts"
import { orDefault, orNull, readOld, writeUnlessRehearsal } from "./common.ts"

// Other hosts, push and telemetry (docs/plan/11-migration.md, Table by table): links and browsers' push subscriptions
// as they are, and the telemetry outbox (the old server is stopped, so nothing is in flight). A rehearsal writes none
// of them: links hold other hosts' tokens, a subscription is a browser's, and the outbox is sent somewhere. Paired
// devices (`device_tokens`), Expo push subscriptions and `push_answer_tokens` wait for the phone app: they are counted in
// the report's notes and not imported.

export const OldLink = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mode: Schema.String,
  url: orNull(Schema.String),
  token: orNull(Schema.String),
  ssh: orNull(Schema.String),
  uplink: orDefault(Schema.Finite, 0),
  last_seen: orNull(Schema.String),
  created_at: Schema.String,
})
export type OldLink = typeof OldLink.Type

export const OldPushSubscription = Schema.Struct({
  id: Schema.String,
  endpoint: Schema.String,
  kind: orDefault(Schema.String, "web"),
  p256dh: Schema.String,
  auth: Schema.String,
  name: orDefault(Schema.String, ""),
  device_id: orNull(Schema.String),
  events: Schema.String,
  created_at: Schema.String,
  last_sent_at: orNull(Schema.String),
  last_error: orNull(Schema.String),
})
export type OldPushSubscription = typeof OldPushSubscription.Type

export const OldOutboxRow = Schema.Struct({ id: Schema.Int, target: Schema.String, row: Schema.String, at: Schema.String })

/** An SSH target as the old reader took it: ports left out are 22 (SSH) and 7878 (the board). */
const OldSshTarget = Schema.Struct({ target: Schema.String, ssh_port: orDefault(Schema.Int, 22), remote_port: orDefault(Schema.Int, 7878) })
const decodeTarget = Schema.decodeUnknownResult(Schema.fromJsonString(OldSshTarget))
const encodeTarget = Schema.encodeResult(Schema.fromJsonString(SshTarget))

/**
 * A link's `ssh` column as the new server reads it: its ports filled in. One the old reader could not read was no
 * target there, and is none here (`unreadable`).
 */
export const convertSsh = (text: string | null): { readonly value: string | null; readonly unreadable: boolean } => {
  if (text === null) return { value: null, unreadable: false }
  const target = Result.flatMap(decodeTarget(text), (t) => encodeTarget(t))
  return Result.isSuccess(target) ? { value: target.success, unreadable: false } : { value: null, unreadable: true }
}

export const convertLink = (l: OldLink): NewRow => ({ ...l, ssh: convertSsh(l.ssh).value })

/** Whether a subscription is a browser's (imported) rather than the phone app's through Expo (not yet). */
export const isWebSubscription = (s: OldPushSubscription) => s.kind !== "expo"

const byId = keyOf("id")
const links: TableCheck = { row: LinkRow, json: { ssh: Schema.NullOr(SshTarget) }, key: byId }
const subscriptions: TableCheck = { row: SubscriptionRow, json: { events: PushEventsPatch }, key: byId }
const outbox: TableCheck = {
  row: Schema.Struct({ ...OutboxRow.fields, target: Schema.String }),
  json: { row: Schema.Record(Schema.String, Schema.Unknown) },
  key: byId,
}

/** Counts an old table's rows that wait for the phone app, as a note. */
const waiting = (io: FamilyIo, table: string, n: number, what: string) =>
  n === 0 ? Effect.void : io.report.note(table, "*", `${n} ${what} not imported: they wait for the phone app`)

const count = (io: FamilyIo, table: string) =>
  Effect.map(io.old.tables.has(table) ? io.old.query(`SELECT count(*) AS n FROM "${table}"`) : Effect.succeed([]), (rows) => Number(rows[0]?.["n"] ?? 0))

/**
 * The outbox's ids are never reused (they are in each batch's dedup token): the new sequence goes on from the old one's
 * high-water mark, which may be past the last row left.
 */
const carrySequence = (io: FamilyIo) =>
  Effect.gen(function* () {
    if (!io.old.tables.has("sqlite_sequence")) return
    const old = Number((yield* io.old.query(`SELECT seq FROM sqlite_sequence WHERE name = 'telemetry_outbox'`))[0]?.["seq"] ?? 0)
    if (old === 0) return
    const there = yield* io.exec(`SELECT seq FROM sqlite_sequence WHERE name = 'telemetry_outbox'`)
    if (there.length === 0) yield* io.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('telemetry_outbox', ?)`, [old])
    else yield* io.exec(`UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'telemetry_outbox'`, [old])
  })

export const hosts: Family = {
  name: "hosts",
  reads: ["links", "push_subscriptions", "device_tokens", "push_answer_tokens", "telemetry_outbox"],
  writes: ["links", "push_subscriptions", "telemetry_outbox"],
  run: (io) =>
    Effect.gen(function* () {
      const linkRows: Array<NewRow> = []
      for (const l of yield* readOld(io, "links", OldLink, byId)) {
        if (convertSsh(l.ssh).unreadable)
          yield* io.report.note("links", `${l.id}.ssh`, "an SSH target the old board could not read, so it had none: imported as none")
        linkRows.push(convertLink(l))
      }
      yield* writeUnlessRehearsal(io, "links", links, linkRows)

      // The old rows behind the new table are the browsers' ones.
      const subs = yield* io.old.rows("push_subscriptions")
      const all = yield* decodeOld(io.report, "push_subscriptions", OldPushSubscription, byId)(subs)
      const web = all.filter(isWebSubscription)
      yield* io.report.old("push_subscriptions", subs.length - (all.length - web.length))
      yield* waiting(io, "push_subscriptions", all.length - web.length, "Expo push subscriptions")
      yield* writeUnlessRehearsal(io, "push_subscriptions", subscriptions, web)
      yield* waiting(io, "device_tokens", yield* count(io, "device_tokens"), "paired devices (device_tokens)")
      yield* waiting(io, "push_answer_tokens", yield* count(io, "push_answer_tokens"), "push answer tokens")

      yield* writeUnlessRehearsal(io, "telemetry_outbox", outbox, yield* readOld(io, "telemetry_outbox", OldOutboxRow, byId))
      yield* carrySequence(io)
    }),
}
