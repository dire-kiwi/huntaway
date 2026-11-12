import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { ProfileId, Timestamp } from "@huntaway/contracts"
import type { DocPublished, DocId } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { rowsOf } from "../platform/columns.ts"

// Hosted docs' tables (huntaway's db/docs_site.ts; docs/plan/inventory/06-integrations.md 2.5): each profile's
// connection to a docs site with its tokens, the OAuth clients this host registered with sites, and where its documents
// went on them. The tokens are read here alone, as `Redacted` values: no wire schema has a field for them, and nothing
// logs them. Single statements; nothing here waits.

/** A profile's connection to a docs site. `kind` is `oauth` (the device flow's tokens) or `token` (a pasted one). */
export interface DocsSiteConnection {
  readonly profile_id: ProfileId
  readonly site_url: string
  readonly kind: "oauth" | "token"
  readonly access_token: Redacted.Redacted
  readonly refresh_token: Redacted.Redacted | null
  /** When the access token expires, in milliseconds since the epoch (null: it doesn't, or isn't known to). */
  readonly expires_at: number | null
  /** The docs site's username, once it's known. */
  readonly login: string | null
  readonly connected_at: Timestamp
}

const ConnectionRow = Schema.Struct({
  profile_id: ProfileId,
  site_url: Schema.String,
  kind: Schema.Literals(["oauth", "token"]),
  access_token: Schema.String,
  refresh_token: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Schema.Finite),
  login: Schema.NullOr(Schema.String),
  connected_at: Timestamp,
})

const PublishedRow = Schema.Struct({
  site_url: Schema.String,
  remote_slug: Schema.String,
  remote_version: Schema.Int,
  local_version: Schema.Int,
  url: Schema.String,
  version_url: Schema.String,
  login: Schema.NullOr(Schema.String),
  published_at: Timestamp,
})

const connectionRows = rowsOf(ConnectionRow)
const publishedRows = rowsOf(PublishedRow)
const clientRows = rowsOf(Schema.Struct({ client_id: Schema.String }))
const changedRows = rowsOf(Schema.Struct({ profile_id: Schema.String }))

const first = <A>(found: Effect.Effect<ReadonlyArray<A>>) => Effect.map(found, (list) => list[0] ?? null)
const redacted = (s: string | null) => (s === null ? null : Redacted.make(s))
const reveal = (s: Redacted.Redacted | null) => (s === null ? null : Redacted.value(s))

export interface DocsSiteRepoShape {
  readonly client: (site: string) => Effect.Effect<string | null>
  readonly setClient: (site: string, client: string, now: Timestamp) => Effect.Effect<void>
  readonly connection: (profile: ProfileId) => Effect.Effect<DocsSiteConnection | null>
  /** Connects the profile (replacing any connection it had). */
  readonly connect: (c: Omit<DocsSiteConnection, "connected_at">, now: Timestamp) => Effect.Effect<void>
  /**
   * Saves refreshed tokens, if the connection still has the refresh token they replace (the site rotates them: a
   * connection made again meanwhile keeps its own). Whether it did.
   */
  readonly refreshed: (
    profile: ProfileId,
    used: Redacted.Redacted,
    tokens: { readonly access: Redacted.Redacted; readonly refresh: Redacted.Redacted | null; readonly expires_at: number | null },
  ) => Effect.Effect<boolean>
  /** Records the site's username, if the connection still has this access token. */
  readonly setLogin: (profile: ProfileId, access: Redacted.Redacted, login: string) => Effect.Effect<void>
  /** Forgets the profile's connection (with `access`, only if it's still the one with that token). Whether it had one. */
  readonly disconnect: (profile: ProfileId, access?: Redacted.Redacted) => Effect.Effect<boolean>
  readonly published: (doc: DocId, site: string) => Effect.Effect<DocPublished | null>
  readonly setPublished: (doc: DocId, p: Omit<DocPublished, "published_at">, now: Timestamp) => Effect.Effect<void>
}

export class DocsSiteRepo extends Context.Service<DocsSiteRepo, DocsSiteRepoShape>()("huntaway-server/docs/DocsSiteRepo") {
  static readonly layer = Layer.effect(
    DocsSiteRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      return DocsSiteRepo.of({
        client: (site) => Effect.map(first(clientRows(sql`SELECT client_id FROM docs_site_clients WHERE site_url = ${site}`)), (r) => r?.client_id ?? null),
        setClient: (site, client, now) =>
          sql`INSERT INTO docs_site_clients (site_url, client_id, created_at) VALUES (${site}, ${client}, ${now})
            ON CONFLICT(site_url) DO UPDATE SET client_id = excluded.client_id, created_at = excluded.created_at`.pipe(Effect.asVoid, Effect.orDie),
        connection: (profile) =>
          Effect.map(first(connectionRows(sql`SELECT * FROM docs_site_connections WHERE profile_id = ${profile}`)), (r) =>
            r === null ? null : { ...r, access_token: Redacted.make(r.access_token), refresh_token: redacted(r.refresh_token) },
          ),
        connect: (c, now) =>
          sql`INSERT INTO docs_site_connections (profile_id, site_url, kind, access_token, refresh_token, expires_at, login, connected_at)
            VALUES (${c.profile_id}, ${c.site_url}, ${c.kind}, ${Redacted.value(c.access_token)}, ${reveal(c.refresh_token)}, ${c.expires_at}, ${c.login}, ${now})
            ON CONFLICT(profile_id) DO UPDATE SET site_url = excluded.site_url, kind = excluded.kind, access_token = excluded.access_token,
              refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, login = excluded.login, connected_at = excluded.connected_at`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        refreshed: (profile, used, t) =>
          Effect.map(
            changedRows(sql`UPDATE docs_site_connections SET access_token = ${Redacted.value(t.access)}, refresh_token = ${reveal(t.refresh)}, expires_at = ${t.expires_at}
              WHERE profile_id = ${profile} AND refresh_token = ${Redacted.value(used)} RETURNING profile_id`),
            (r) => r.length > 0,
          ),
        setLogin: (profile, access, login) =>
          sql`UPDATE docs_site_connections SET login = ${login} WHERE profile_id = ${profile} AND access_token = ${Redacted.value(access)}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        disconnect: (profile, access) =>
          Effect.map(
            changedRows(
              access === undefined
                ? sql`DELETE FROM docs_site_connections WHERE profile_id = ${profile} RETURNING profile_id`
                : sql`DELETE FROM docs_site_connections WHERE profile_id = ${profile} AND access_token = ${Redacted.value(access)} RETURNING profile_id`,
            ),
            (r) => r.length > 0,
          ),
        published: (doc, site) =>
          first(
            publishedRows(sql`SELECT site_url, remote_slug, remote_version, local_version, url, version_url, login, published_at
              FROM docs_site_published WHERE doc_id = ${doc} AND site_url = ${site}`),
          ),
        setPublished: (doc, p, now) =>
          sql`INSERT INTO docs_site_published (doc_id, site_url, remote_slug, remote_version, local_version, url, version_url, login, published_at)
            VALUES (${doc}, ${p.site_url}, ${p.remote_slug}, ${p.remote_version}, ${p.local_version}, ${p.url}, ${p.version_url}, ${p.login}, ${now})
            ON CONFLICT(doc_id, site_url) DO UPDATE SET remote_slug = excluded.remote_slug, remote_version = excluded.remote_version,
              local_version = excluded.local_version, url = excluded.url, version_url = excluded.version_url, login = excluded.login,
              published_at = excluded.published_at`.pipe(Effect.asVoid, Effect.orDie),
      })
    }),
  )
}
