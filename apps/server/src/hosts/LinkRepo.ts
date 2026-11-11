import { Context, Effect, Layer, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import { LinkId, Timestamp } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, JsonColumn } from "../platform/columns.ts"

// The `links` table (docs/plan/08-hosts.md): all a hub keeps of another host, how to reach it. `id` is that host's
// `host_id`. Single statements; `SqlError` and `SchemaError` are defects. Nothing here waits.

/** How a link is made: the hub dials its URL, the host dials in, or the hub reaches it over SSH. */
export const LinkMode = Schema.Literals(["outbound", "inbound", "ssh"])
export type LinkMode = typeof LinkMode.Type

/** An SSH link's target: `user@host`, its SSH port and the port the host's server listens on there. */
export const SshTarget = Schema.Struct({ target: Schema.String, ssh_port: Schema.Int, remote_port: Schema.Int })
export interface SshTarget extends Schema.Schema.Type<typeof SshTarget> {}

/** A `links` row. `token` is that host's board token (outbound; ssh: the last its forced command gave), never sent out. */
export const LinkRow = Schema.Struct({
  id: LinkId,
  name: Schema.String,
  mode: LinkMode,
  url: Schema.NullOr(Schema.String),
  token: Schema.NullOr(Schema.String),
  ssh: JsonColumn(Schema.NullOr(SshTarget), null),
  /** Its agents may use this board's tools, up the link. */
  uplink: Bit,
  /** When the hub last heard from it, written when its connection ends. */
  last_seen: Schema.NullOr(Timestamp),
  created_at: Timestamp,
})
export interface LinkRow extends Schema.Schema.Type<typeof LinkRow> {}

const COLUMNS = "id, name, mode, url, token, ssh, uplink, last_seen, created_at"

export interface LinkRepoShape {
  readonly list: Effect.Effect<ReadonlyArray<LinkRow>>
  readonly get: (id: LinkId) => Effect.Effect<LinkRow | null>
  /**
   * Adds a link, or changes how an existing one is reached. An inbound one (a host that dialled in) keeps an existing
   * row's mode, URL and token: a host the hub dials may dial in too.
   */
  readonly upsert: (link: {
    readonly id: LinkId
    readonly name: string
    readonly mode: LinkMode
    readonly url: string | null
    readonly token: string | null
    readonly ssh: SshTarget | null
    readonly now: Timestamp
  }) => Effect.Effect<void>
  readonly rename: (id: LinkId, name: string) => Effect.Effect<void>
  readonly setUplink: (id: LinkId, uplink: boolean) => Effect.Effect<void>
  readonly setToken: (id: LinkId, token: string) => Effect.Effect<void>
  readonly setLastSeen: (id: LinkId, at: Timestamp) => Effect.Effect<void>
  /** The links some profile's assistant runs on (`profiles.assistant_host`). */
  readonly assistantHosts: Effect.Effect<ReadonlySet<LinkId>>
  /** Deletes a link, and the profiles' assistant host where it was this one; how many profiles had it. */
  readonly delete: (id: LinkId) => Effect.Effect<number>
}

export class LinkRepo extends Context.Service<LinkRepo, LinkRepoShape>()("huntaway-server/hosts/LinkRepo") {
  static readonly layer = Layer.effect(
    LinkRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const all = SqlSchema.findAll({
        Request: Schema.Void,
        Result: LinkRow,
        execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM links ORDER BY created_at, id`),
      })
      const one = SqlSchema.findAll({ Request: LinkId, Result: LinkRow, execute: (id) => sql.unsafe(`SELECT ${COLUMNS} FROM links WHERE id = ?`, [id]) })
      const encodeSsh = Schema.encodeEffect(Schema.fromJsonString(SshTarget))
      return LinkRepo.of({
        list: all(undefined).pipe(Effect.orDie),
        get: (id) =>
          one(id).pipe(
            Effect.map((rows) => rows[0] ?? null),
            Effect.orDie,
          ),
        upsert: (link) =>
          Effect.gen(function* () {
            const ssh = link.ssh === null ? null : yield* encodeSsh(link.ssh)
            yield* link.mode === "inbound"
              ? sql`INSERT INTO links (id, name, mode, url, token, ssh, uplink, created_at)
                    VALUES (${link.id}, ${link.name}, 'inbound', NULL, NULL, NULL, 0, ${link.now})
                    ON CONFLICT (id) DO UPDATE SET name = excluded.name`
              : sql`INSERT INTO links (id, name, mode, url, token, ssh, uplink, created_at)
                    VALUES (${link.id}, ${link.name}, ${link.mode}, ${link.url}, ${link.token}, ${ssh}, 0, ${link.now})
                    ON CONFLICT (id) DO UPDATE SET name = excluded.name, mode = excluded.mode, url = excluded.url,
                      token = excluded.token, ssh = excluded.ssh`
          }).pipe(Effect.asVoid, Effect.orDie),
        rename: (id, name) => sql`UPDATE links SET name = ${name} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setUplink: (id, uplink) => sql`UPDATE links SET uplink = ${uplink ? 1 : 0} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setToken: (id, token) => sql`UPDATE links SET token = ${token} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setLastSeen: (id, at) => sql`UPDATE links SET last_seen = ${at} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        assistantHosts: sql<{ readonly id: string }>`SELECT DISTINCT assistant_host AS id FROM profiles WHERE assistant_host IS NOT NULL`.pipe(
          Effect.map((rows) => new Set(rows.map((r) => LinkId.make(r.id)))),
          Effect.orDie,
        ),
        delete: (id) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM links WHERE id = ${id}`
            const cleared = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM profiles WHERE assistant_host = ${id}`
            yield* sql`UPDATE profiles SET assistant_host = NULL WHERE assistant_host = ${id}`
            return cleared[0]?.n ?? 0
          }).pipe(Effect.orDie),
      })
    }),
  )
}
