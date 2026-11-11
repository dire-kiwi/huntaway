import { Clock, Context, DateTime, Effect, FiberMap, Layer, Option, Redacted, Ref, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Conflict, External, Invalid, NotFound, Timestamp } from "@huntaway/contracts"
import type { DocPublished, DocPublishOutcome, HostedDocsStatus, ProfileId } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { DocRepo } from "./DocRepo.ts"
import type { Doc } from "./DocRepo.ts"
import { docSlug, quoted } from "./docRules.ts"
import { DocsSiteRepo } from "./DocsSiteRepo.ts"
import type { DocsSiteConnection } from "./DocsSiteRepo.ts"

// Hosted docs (huntaway's integrations/docs_site.ts; docs/plan/inventory/06-integrations.md 2.5): a profile connects to
// a hosted docs site (dire-kiwi/docs, https://docs.nest.dire.nz by default) and publishes its documents there.
//
// - Connecting is the site's OAuth device authorization grant (RFC 8628): this host registers a public client with the
//   site once, starts a sign-in, and the board shows the user its code and link while this host polls the token
//   endpoint (honouring `interval` and `slow_down`). The access token is renewed with the refresh token, which rotates
//   on every use: renewals for a profile go one at a time, and the second finds the first's tokens. The fallback is a
//   personal access token the user pastes.
// - Publishing calls the site's `/mcp` `publish_document` tool with a version's pages and images, and remembers where it
//   went and as whom (`DocsSiteRepo`), so publishing again adds a version to the same remote document. A first publish
//   to a slug can ask first whether the site has a document of the user's there (`ask`). Publishes of one document go
//   one at a time.
//
// The tokens stay on this host: the board is only told whether a profile is connected, and as whom. A sign-in under
// way is in memory, and lost on a restart (the user starts again). Tests reach only a fake site (packages/testing).

export const DEFAULT_SITE = "https://docs.nest.dire.nz"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const PROTOCOL_VERSION = "2025-06-18"
const SERVICE = "docs site"

/** How long a request to the site may take, the poll's back-off on `slow_down`, and its interval when the site gives none (seconds). Tests shorten them. */
export const DocsSiteTiming = Context.Reference<{ readonly request: number; readonly slowDown: number; readonly interval: number }>(
  "huntaway-server/docs/HostedDocs/DocsSiteTiming",
  { defaultValue: () => ({ request: 20, slowDown: 5, interval: 5 }) },
)

/** A site's address as it's kept: http(s), no credentials, query or fragment, and no `/` at the end (the default for none). */
const badSite = (reason: string) => Effect.fail(new Invalid({ field: "site_url", reason }))

export const siteUrl = (raw: string | null | undefined): Effect.Effect<string, Invalid> => {
  if (raw === undefined || raw === null || raw === "") return Effect.succeed(DEFAULT_SITE)
  const t = raw.trim()
  const parsed = Option.liftThrowable((s: string) => new URL(s))(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  if (Option.isNone(parsed)) return badSite(`${quoted(raw)} isn't a URL`)
  const u = parsed.value
  if (u.protocol !== "https:" && u.protocol !== "http:") return badSite("the docs site's URL starts with https:// (or http://)")
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return badSite("the docs site's URL has no user, query or fragment")
  return Effect.succeed(`${u.origin}${u.pathname.replace(/\/+$/, "")}`)
}

/** Whether a URL the site gave (that the board opens or links) is a web page's, not `javascript:` or the like. */
const webUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v)

/** The site's name for messages: its host. */
const siteName = (site: string): string => Option.getOrElse(Option.liftThrowable((s: string) => new URL(s).host)(site), () => site)

/** A field of a JSON value, if it's an object's. */
const prop = (v: unknown, k: string): unknown => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const out: unknown = Reflect.get(v, k)
  return out
}
const str = (v: unknown, k: string): string | null => {
  const x = prop(v, k)
  return typeof x === "string" ? x : null
}
const num = (v: unknown, k: string): number | null => {
  const x = prop(v, k)
  return typeof x === "number" && Number.isFinite(x) ? x : null
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const jsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const encodeJson = (v: unknown): string => Result.getOrElse(jsonText(v), () => String(v))

/** A site's reply: its status and JSON body (null if it isn't JSON). */
interface Reply {
  readonly status: number
  readonly body: unknown
  readonly contentType: string
  readonly text: string
}

/** An OAuth error reply's text (`error_description`, else `error`, else the status). */
const oauthText = (r: Reply): string => str(r.body, "error_description") ?? str(r.body, "error") ?? `HTTP ${r.status}`

export type HostedError = Invalid | Conflict | External | NotFound

/** A tool's error answer: the site's message, and its text as the site gave it. */
class ToolFailed extends Schema.TaggedError<ToolFailed, { readonly brand: unique symbol }>()("ToolFailed", { message: Schema.String, text: Schema.String }) {}

const external = (site: string, reason: string) => new External({ service: SERVICE, reason: `${siteName(site)} ${reason}` })

/** When a token given for `expiresIn` seconds expires (ms since the epoch), if it says. */
const expiry = (expiresIn: number | null) => Effect.map(Clock.currentTimeMillis, (now) => (expiresIn !== null && expiresIn > 0 ? now + expiresIn * 1000 : null))

const notConnected = (site: string) => new Conflict({ reason: "not_connected", detail: `Connect this profile to ${siteName(site)} first.` })

/** A tool's error as the board is told it. */
const asInvalid = <A>(effect: Effect.Effect<A, HostedError | ToolFailed>): Effect.Effect<A, HostedError> =>
  Effect.catchTag(effect, "ToolFailed", (e) => Effect.fail(new Invalid({ field: "slug", reason: e.message })))

/** The username in `list_documents`' answer: the owner of a document that isn't someone else's. */
const owner = (v: unknown): string | null => {
  const list = prop(v, "documents")
  if (!Array.isArray(list)) return null
  const own: unknown = list.find((d: unknown) => prop(d, "shared_with_you") === false && typeof prop(d, "owner") === "string")
  return str(own, "owner")
}

/** Whether a document was published as another account than the one connected (as far as is known: either may not be). */
const otherAccount = (p: DocPublished, c: DocsSiteConnection) => p.login !== null && c.login !== null && p.login !== c.login

/** A device sign-in under way: what the user is shown, and what this host polls with. */
interface Pending {
  readonly id: number
  readonly site_url: string
  readonly client_id: string
  readonly token_endpoint: string
  readonly device_code: Redacted.Redacted
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string | null
  /** Milliseconds since the epoch. */
  readonly expires_at: number
  /** Why it stopped (denied, expired, failed), until the user starts again or closes it. */
  readonly error: string | null
}

interface Metadata {
  readonly token_endpoint: string
  readonly registration_endpoint: string
  readonly device_authorization_endpoint: string
}

/** How to publish: the remote slug, and whether to ask first if the site has a document there. */
export interface PublishOptions {
  readonly slug?: string | null | undefined
  readonly ask?: boolean | undefined
}

export interface HostedDocsShape {
  /** What the board is shown of a profile's connection: never its tokens. */
  readonly status: (profile: ProfileId) => Effect.Effect<HostedDocsStatus>
  /** Starts a device sign-in to `site` for the profile (stopping any it had under way). */
  readonly startDevice: (profile: ProfileId, site: string) => Effect.Effect<HostedDocsStatus, Invalid | External>
  /** Stops a sign-in under way (or clears the error of one that stopped). */
  readonly cancelDevice: (profile: ProfileId) => Effect.Effect<HostedDocsStatus>
  /** Connects with a personal access token, once the site takes it. */
  readonly connectToken: (profile: ProfileId, site: string, token: string) => Effect.Effect<HostedDocsStatus, HostedError>
  /** Forgets the profile's connection (its tokens stay valid on the site until they expire, or the user revokes them there). */
  readonly disconnect: (profile: ProfileId) => Effect.Effect<HostedDocsStatus>
  /**
   * The document's publish state on the profile's site (the one it's connected to, else the one it was last, else the
   * default): none if it was published there as another account.
   */
  readonly published: (profile: ProfileId, doc: Doc) => Effect.Effect<DocPublished | null>
  /** Publishes version `number` (null: the latest) of the profile's document `slug` to its site. */
  readonly publish: (profile: ProfileId, slug: string, number: number | null, o: PublishOptions) => Effect.Effect<DocPublishOutcome, HostedError>
  /** Calls one of the site's MCP tools as the profile, renewing its sign-in as needed: its result's JSON (or text). */
  readonly callTool: (profile: ProfileId, name: string, args: unknown) => Effect.Effect<unknown, HostedError>
}

export class HostedDocs extends Context.Service<HostedDocs, HostedDocsShape>()("huntaway-server/docs/HostedDocs") {
  static readonly layer = Layer.effect(
    HostedDocs,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const repo = yield* DocsSiteRepo
      const docs = yield* DocRepo
      const events = yield* Events
      const locks = yield* KeyedLock
      const identity = yield* Identity
      const pending = yield* Ref.make<ReadonlyMap<ProfileId, Pending>>(new Map())
      const lastSite = yield* Ref.make<ReadonlyMap<ProfileId, string>>(new Map())
      const polls = yield* FiberMap.make<ProfileId>()
      const counter = yield* Ref.make(0)

      const changed = (profile: ProfileId) => events.emit({ type: "docs_site", profile_id: profile })

      const request = Effect.fnUntraced(function* (site: string, req: HttpClientRequest.HttpClientRequest) {
        const timing = yield* DocsSiteTiming
        const unreachable = (why: string) => new External({ service: SERVICE, reason: `couldn't reach ${siteName(site)}: ${why}` })
        return yield* client.execute(req).pipe(
          Effect.flatMap((res) =>
            Effect.map(res.text.pipe(Effect.orElseSucceed(() => "")), (text): Reply => ({
              status: res.status,
              text,
              body: Option.getOrNull(parseJson(text)),
              contentType: res.headers["content-type"] ?? "",
            })),
          ),
          Effect.mapError((e) => unreachable(e.message)),
          Effect.timeoutOrElse({ duration: `${timing.request} seconds`, orElse: () => Effect.fail(unreachable("it took too long to answer")) }),
          // A redirect is refused, as the old server's was: the token goes to the site it was given for only.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        )
      })

      const postForm = (site: string, url: string, form: Readonly<Record<string, string>>) =>
        request(site, HttpClientRequest.post(url, { headers: { accept: "application/json" } }).pipe(HttpClientRequest.bodyUrlParams(form)))

      const postJson = (site: string, url: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
        request(
          site,
          HttpClientRequest.post(url, { headers: { accept: "application/json", ...headers } }).pipe(
            HttpClientRequest.bodyText(encodeJson(body), "application/json"),
          ),
        )

      /** The site's endpoints, from its `/.well-known/oauth-authorization-server`. */
      const metadata = Effect.fnUntraced(function* (site: string) {
        const r = yield* request(site, HttpClientRequest.get(`${site}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } }))
        const ok = (k: string) => {
          const v = str(r.body, k)
          return v !== null && /^https?:\/\//.test(v) ? v : null
        }
        const token = ok("token_endpoint")
        const registration = ok("registration_endpoint")
        if (r.status !== 200 || token === null || registration === null) {
          return yield* external(site, "doesn't look like a docs site (no OAuth metadata at /.well-known/oauth-authorization-server)")
        }
        const device = ok("device_authorization_endpoint")
        if (device === null) return yield* external(site, "doesn't offer the device sign-in: paste an access token instead")
        const m: Metadata = { token_endpoint: token, registration_endpoint: registration, device_authorization_endpoint: device }
        return m
      })

      /** This host's OAuth client on the site: the one it registered, or a new one (`again`: the site forgot the old one). */
      const clientId = Effect.fnUntraced(function* (site: string, m: Metadata, again: boolean) {
        const known = again ? null : yield* repo.client(site)
        if (known !== null) return known
        const r = yield* postJson(site, m.registration_endpoint, {
          client_name: `Huntaway (${identity.hostName})`,
          grant_types: [DEVICE_GRANT, "refresh_token"],
        })
        const id = str(r.body, "client_id")
        if ((r.status !== 200 && r.status !== 201) || id === null) return yield* external(site, `didn't register this host: ${oauthText(r)}`)
        yield* repo.setClient(site, id, yield* nowTimestamp)
        return id
      })

      /** The profile's site: the one it's connected to (or signing in to), else the one it was last, else the default. */
      const siteOf = Effect.fnUntraced(function* (profile: ProfileId, c: DocsSiteConnection | null) {
        return c?.site_url ?? (yield* Ref.get(pending)).get(profile)?.site_url ?? (yield* Ref.get(lastSite)).get(profile) ?? DEFAULT_SITE
      })

      const status = Effect.fn("HostedDocs.status")(function* (profile: ProfileId) {
        const c = yield* repo.connection(profile)
        const p = (yield* Ref.get(pending)).get(profile)
        const out: HostedDocsStatus = {
          default_site_url: DEFAULT_SITE,
          site_url: yield* siteOf(profile, c),
          connected: c !== null,
          kind: c?.kind ?? null,
          login: c?.login ?? null,
          connected_at: c?.connected_at ?? null,
          pending:
            p === undefined
              ? null
              : {
                  site_url: p.site_url,
                  user_code: p.user_code,
                  verification_uri: p.verification_uri,
                  verification_uri_complete: p.verification_uri_complete,
                  expires_at: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(p.expires_at))),
                  error: p.error,
                },
        }
        return out
      })

      /** Forgets the profile's connection (with `access`, only if it's still the one with that token), keeping its site. */
      const forget = Effect.fnUntraced(function* (profile: ProfileId, access?: Redacted.Redacted) {
        const c = yield* repo.connection(profile)
        if ((yield* repo.disconnect(profile, access)) && c !== null) yield* Ref.update(lastSite, (m) => new Map(m).set(profile, c.site_url))
      })

      const stopPending = Effect.fnUntraced(function* (profile: ProfileId) {
        yield* FiberMap.remove(polls, profile)
        yield* Ref.update(pending, (m) => {
          const next = new Map(m)
          next.delete(profile)
          return next
        })
      })

      /** Whether `p` is still the profile's sign-in under way. */
      const current = (profile: ProfileId, p: Pending) => Effect.map(Ref.get(pending), (m) => m.get(profile)?.id === p.id)

      const setPending = (profile: ProfileId, p: Pending) => Ref.update(pending, (m) => new Map(m).set(profile, p))

      /** Polls the token endpoint for a sign-in, at its interval, until it connects, stops, or isn't the one under way. */
      const poll = Effect.fnUntraced(function* (profile: ProfileId, first: Pending, firstInterval: number) {
        const timing = yield* DocsSiteTiming
        const p = first
        let interval = firstInterval
        const fail = (why: string) =>
          Effect.flatMap(current(profile, p), (still) => (still ? Effect.andThen(setPending(profile, { ...p, error: why }), changed(profile)) : Effect.void))
        while (true) {
          yield* Effect.sleep(`${Math.round(interval * 1000)} millis`)
          if (!(yield* current(profile, p))) return
          if ((yield* Clock.currentTimeMillis) >= p.expires_at) {
            yield* fail("The sign-in code expired before it was approved. Start again.")
            return
          }
          const r = yield* Effect.option(
            postForm(p.site_url, p.token_endpoint, { grant_type: DEVICE_GRANT, device_code: Redacted.value(p.device_code), client_id: p.client_id }),
          )
          // The site is unreachable for now: try again at the next interval, until the code expires.
          if (Option.isNone(r)) continue
          if (!(yield* current(profile, p))) return
          const reply = r.value
          const error = str(reply.body, "error")
          const access = str(reply.body, "access_token")
          if (reply.status === 200 && access !== null) {
            yield* Ref.update(pending, (m) => {
              const next = new Map(m)
              next.delete(profile)
              return next
            })
            const refresh = str(reply.body, "refresh_token")
            yield* repo.connect(
              {
                profile_id: profile,
                site_url: p.site_url,
                kind: "oauth",
                access_token: Redacted.make(access),
                refresh_token: refresh === null ? null : Redacted.make(refresh),
                expires_at: yield* expiry(num(reply.body, "expires_in")),
                login: null,
              },
              yield* nowTimestamp,
            )
            yield* changed(profile)
            // Who the user is, from their documents there; quietly, as the connection is made.
            yield* learnLogin(profile, undefined).pipe(Effect.ignore)
            return
          }
          if (error === "authorization_pending" || error === "slow_down" || reply.status >= 500) {
            if (error === "slow_down") interval += timing.slowDown
            continue
          }
          yield* fail(
            error === "access_denied"
              ? "The sign-in was denied on the docs site."
              : error === "expired_token"
                ? "The sign-in code expired before it was approved. Start again."
                : `The sign-in failed: ${oauthText(reply)}`,
          )
          return
        }
      })

      const startDevice = Effect.fn("HostedDocs.startDevice")(function* (profile: ProfileId, site: string) {
        yield* stopPending(profile)
        const timing = yield* DocsSiteTiming
        const m = yield* metadata(site)
        let id = yield* clientId(site, m, false)
        let r = yield* postForm(site, m.device_authorization_endpoint, { client_id: id })
        if (str(r.body, "error") === "invalid_client") {
          // The site has forgotten this host's client (its database was reset, say): register again.
          id = yield* clientId(site, m, true)
          r = yield* postForm(site, m.device_authorization_endpoint, { client_id: id })
        }
        const deviceCode = str(r.body, "device_code")
        const userCode = str(r.body, "user_code")
        const uri = prop(r.body, "verification_uri")
        if (r.status !== 200 || deviceCode === null || userCode === null || !webUrl(uri)) {
          return yield* external(site, `didn't start a sign-in: ${oauthText(r)}`)
        }
        const complete = prop(r.body, "verification_uri_complete")
        const expiresIn = num(r.body, "expires_in")
        const given = num(r.body, "interval")
        const p: Pending = {
          id: yield* Ref.updateAndGet(counter, (n) => n + 1),
          site_url: site,
          client_id: id,
          token_endpoint: m.token_endpoint,
          device_code: Redacted.make(deviceCode),
          user_code: userCode,
          verification_uri: uri,
          verification_uri_complete: webUrl(complete) ? complete : null,
          expires_at: (yield* Clock.currentTimeMillis) + (expiresIn !== null && expiresIn > 0 ? expiresIn : 600) * 1000,
          error: null,
        }
        yield* setPending(profile, p)
        yield* FiberMap.run(polls, profile, poll(profile, p, given !== null && given > 0 ? given : timing.interval))
        yield* changed(profile)
        return yield* status(profile)
      })

      /** A JSON-RPC request to the site's MCP endpoint. */
      const rpc = Effect.fnUntraced(function* (site: string, token: Redacted.Redacted, method: string, params: unknown) {
        const r = yield* postJson(
          site,
          `${site}/mcp`,
          { jsonrpc: "2.0", id: 1, method, params },
          { authorization: `Bearer ${Redacted.value(token)}`, accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
        )
        if (r.body !== null || !r.contentType.includes("text/event-stream")) return r
        // A Streamable HTTP server may answer as a stream of events: the answer is the one with the request's id.
        let body: unknown = null
        for (const line of r.text.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue
          const m = Option.getOrNull(parseJson(line.slice(5)))
          if (prop(m, "id") === 1) body = m
        }
        const out: Reply = { ...r, body }
        return out
      })

      /** A `tools/call`'s result: its JSON (or text), or the tool's error with the site's message. */
      const toolResult = Effect.fnUntraced(function* (site: string, r: Reply) {
        if (r.status !== 200 || r.body === null) {
          return yield* external(site, `answered HTTP ${r.status}: ${(str(r.body, "error_description") ?? r.text).slice(0, 300)}`)
        }
        const error = prop(r.body, "error")
        if (error !== undefined && error !== null) return yield* external(site, `: ${str(error, "message") ?? encodeJson(error)}`.replace(/^ :/, ":"))
        const res = prop(r.body, "result") ?? {}
        const content = prop(res, "content")
        const text = Array.isArray(content) ? content.map((c: unknown) => str(c, "text") ?? "").join("\n") : ""
        if (prop(res, "isError") === true) return yield* new ToolFailed({ message: `${siteName(site)}: ${text === "" ? "the tool failed" : text}`, text })
        const structured = prop(res, "structuredContent")
        if (structured !== undefined) return { v: structured, text }
        return { v: Option.getOrElse(parseJson(text), () => text), text }
      })

      /** Renews the profile's access token with its refresh token, one renewal at a time per profile (the token rotates). */
      const refresh = (profile: ProfileId, c: DocsSiteConnection) =>
        locks.withLock(["docs", `site:${profile}`])(
          Effect.gen(function* () {
            // Renewed (or connected again) since `c` was read: those tokens are the ones to use.
            const latest = yield* repo.connection(profile)
            if (latest === null) return yield* notConnected(c.site_url)
            if (Redacted.value(latest.access_token) !== Redacted.value(c.access_token) || c.refresh_token === null) return latest
            const used = c.refresh_token
            const m = yield* metadata(c.site_url)
            const id = yield* repo.client(c.site_url)
            const r = yield* postForm(c.site_url, m.token_endpoint, {
              grant_type: "refresh_token",
              refresh_token: Redacted.value(used),
              ...(id === null ? {} : { client_id: id }),
            })
            const access = str(r.body, "access_token")
            if (r.status === 200 && access !== null) {
              const rotated = str(r.body, "refresh_token")
              yield* repo.refreshed(profile, used, {
                access: Redacted.make(access),
                refresh: rotated === null ? used : Redacted.make(rotated),
                expires_at: yield* expiry(num(r.body, "expires_in")),
              })
              const now = yield* repo.connection(profile)
              if (now === null) return yield* notConnected(c.site_url)
              return now
            }
            if (r.status === 400 || r.status === 401) {
              // Expired, revoked, or the user is no longer allowed: the profile has to sign in again.
              yield* forget(profile, c.access_token)
              yield* changed(profile)
              return yield* new Conflict({
                reason: "not_connected",
                detail: `The sign-in to ${siteName(c.site_url)} has expired or was revoked (${oauthText(r)}): connect again.`,
              })
            }
            return yield* external(c.site_url, `didn't renew the sign-in: ${oauthText(r)}`)
          }),
        )

      const callTool = Effect.fn("HostedDocs.callTool")(function* (profile: ProfileId, name: string, args: unknown) {
        let c = yield* repo.connection(profile)
        if (c === null) return yield* notConnected(DEFAULT_SITE)
        if (c.refresh_token !== null && c.expires_at !== null && c.expires_at - 60_000 < (yield* Clock.currentTimeMillis)) c = yield* refresh(profile, c)
        let r = yield* rpc(c.site_url, c.access_token, "tools/call", { name, arguments: args })
        if (r.status === 401 && c.refresh_token !== null) {
          c = yield* refresh(profile, c)
          r = yield* rpc(c.site_url, c.access_token, "tools/call", { name, arguments: args })
        }
        if (r.status === 401) {
          yield* forget(profile, c.access_token)
          yield* changed(profile)
          const why = str(r.body, "error_description") ?? "the token is invalid or expired"
          return yield* new Conflict({
            reason: "not_connected",
            detail: `${siteName(c.site_url)} no longer accepts this profile's sign-in (${why}): connect again.`,
          })
        }
        return (yield* toolResult(c.site_url, r)).v
      })

      /** Finds the profile's username on the site, from its documents (the site has no other way to ask yet). */
      const learnLogin = Effect.fnUntraced(function* (profile: ProfileId, slug: string | undefined) {
        const c = yield* repo.connection(profile)
        if (c === null || c.login !== null) return
        const out = slug === undefined ? yield* callTool(profile, "list_documents", {}) : yield* callTool(profile, "get_document", { slug })
        const login = slug === undefined ? owner(out) : str(out, "owner")
        const now = yield* repo.connection(profile)
        if (login === null || now === null) return
        yield* repo.setLogin(profile, now.access_token, login)
        yield* changed(profile)
      })

      const connectToken = Effect.fn("HostedDocs.connectToken")(function* (profile: ProfileId, site: string, token: string) {
        const t = token.trim()
        if (t === "") return yield* new Invalid({ field: "token", reason: "paste an access token" })
        const r = yield* rpc(site, Redacted.make(t), "tools/call", { name: "list_documents", arguments: {} })
        if (r.status === 401)
          return yield* new Invalid({ field: "token", reason: `${siteName(site)} doesn't take that token (it may have been revoked or have expired)` })
        const out = yield* asInvalid(toolResult(site, r))
        yield* stopPending(profile)
        yield* repo.connect(
          { profile_id: profile, site_url: site, kind: "token", access_token: Redacted.make(t), refresh_token: null, expires_at: null, login: owner(out.v) },
          yield* nowTimestamp,
        )
        yield* changed(profile)
        return yield* status(profile)
      })

      const published = Effect.fn("HostedDocs.published")(function* (profile: ProfileId, doc: Doc) {
        const c = yield* repo.connection(profile)
        const p = yield* repo.published(doc.id, yield* siteOf(profile, c))
        return p !== null && c !== null && otherAccount(p, c) ? null : p
      })

      /** The site's document at `slug`, if it has one the user can see, and whether it's another user's. */
      const remoteDoc = Effect.fnUntraced(function* (profile: ProfileId, slug: string) {
        const v = yield* callTool(profile, "get_document", { slug }).pipe(
          Effect.catchTag("ToolFailed", (e: ToolFailed) => (e.text.startsWith("no document") ? Effect.succeed(null) : Effect.fail(e))),
        )
        if (v === null) return null
        const login = (yield* repo.connection(profile))?.login ?? null
        // The site gives its owner `sharing` (null for others), and names the owner.
        const theirs = typeof prop(v, "owner") === "string" && (login !== null ? prop(v, "owner") !== login : prop(v, "sharing") === null)
        return { v, theirs }
      })

      const tryLearnLogin = (profile: ProfileId, slug: string | undefined) =>
        Effect.gen(function* () {
          if ((yield* repo.connection(profile))?.login != null) return
          yield* learnLogin(profile, slug)
        }).pipe(Effect.ignore)

      const publishNow = Effect.fnUntraced(function* (profile: ProfileId, d: Doc, number: number | null, o: PublishOptions) {
        if ((yield* repo.connection(profile)) === null) return yield* notConnected(DEFAULT_SITE)
        const v = yield* docs.version(d.id, number)
        if (v === null) return yield* new NotFound({ what: "version", id: String(number) })
        // Who's connected, to tell a document published as another account (one connected before, say) from this one's.
        yield* tryLearnLogin(profile, undefined)
        const c = yield* repo.connection(profile)
        if (c === null) return yield* notConnected(DEFAULT_SITE)
        const known = yield* repo.published(d.id, c.site_url)
        const before = known !== null && !otherAccount(known, c) ? known : null
        // Another slug than the one it went to re-targets it: a remote document that was deleted and taken by someone
        // else, say, leaves the old one unusable.
        const target = typeof o.slug === "string" && o.slug !== "" ? docSlug(o.slug) : (before?.remote_slug ?? d.slug)
        if (o.ask === true && before?.remote_slug !== target) {
          const there = yield* remoteDoc(profile, target)
          if (there?.theirs === true) {
            return yield* new Invalid({
              field: "slug",
              reason: `${siteName(c.site_url)} has “${target}” already, as ${str(there.v, "owner") ?? "another user"}'s document: choose another slug`,
            })
          }
          if (there !== null) {
            const x = there.v
            const latest = num(x, "latest_version")
            const outcome: DocPublishOutcome = {
              exists: {
                slug: target,
                title: str(x, "title") ?? target,
                latest_version: latest !== null && Number.isInteger(latest) ? latest : null,
                url: webUrl(prop(x, "url")) ? (str(x, "url") ?? null) : null,
                owner: str(x, "owner"),
              },
            }
            return outcome
          }
        }
        const pages = (yield* docs.pagesFull(v.id)).map((p) => ({ path: p.path, title: p.title, format: p.format, content: p.source }))
        const args: Record<string, unknown> = { slug: target, title: d.title, pages, mode: "replace" }
        if (v.message !== null) args["message"] = v.message
        // The first publish (to this remote document) files it in its folder there, and gives it its labels. The site
        // uses a folder only when it creates the document, and later publishes don't send either, so moves and labels on
        // either side stay their own.
        if (before?.remote_slug !== target && d.folder !== "") args["folder"] = d.folder
        if (before?.remote_slug !== target && d.labels.length > 0) args["labels"] = d.labels
        // Its images, as the AVIFs kept here, under the names its pages use.
        const images: Array<{ readonly name: string; readonly data: string }> = []
        for (const im of yield* docs.imageRefs(v.id)) {
          const data = yield* docs.imageData(profile, im.sha256)
          if (data !== null) images.push({ name: im.name, data: Base64.encode(data) })
        }
        if (images.length > 0) args["images"] = images
        const out = yield* callTool(profile, "publish_document", args)
        const slug = str(out, "slug")
        const version = num(out, "version")
        const url = prop(out, "url")
        if (slug === null || version === null || !webUrl(url)) {
          return yield* external(c.site_url, `published it, but its answer isn't what was expected: ${encodeJson(out).slice(0, 300)}`)
        }
        // A first publish as a user with no documents before: the one published says who it is.
        yield* tryLearnLogin(profile, slug)
        const versionUrl = prop(out, "version_url")
        yield* repo.setPublished(
          d.id,
          {
            site_url: c.site_url,
            remote_slug: slug,
            remote_version: version,
            local_version: v.number,
            url,
            version_url: webUrl(versionUrl) ? versionUrl : url,
            login: (yield* repo.connection(profile))?.login ?? null,
          },
          yield* nowTimestamp,
        )
        yield* events.emit({ type: "docs", profile_id: profile, slug: d.slug })
        const row = yield* repo.published(d.id, c.site_url)
        if (row === null) return yield* Effect.die(new Error("a publish just recorded isn't there"))
        const warnings = prop(out, "warnings")
        const outcome: DocPublishOutcome = {
          published: row,
          warnings: Array.isArray(warnings)
            ? warnings.flatMap((w: unknown) => {
                const page = str(w, "page")
                const warning = str(w, "warning")
                return page !== null && warning !== null ? [{ page, warning }] : []
              })
            : [],
        }
        return outcome
      })

      const publish = Effect.fn("HostedDocs.publish")(function* (profile: ProfileId, slug: string, number: number | null, o: PublishOptions) {
        const d = yield* docs.get(profile, slug)
        if (d === null) return yield* new NotFound({ what: "document", id: slug })
        // Publishes of one document go one after the other.
        return yield* asInvalid(locks.withLock(["docs", `publish:${d.id}`])(publishNow(profile, d, number, o)))
      })

      return HostedDocs.of({
        status,
        startDevice,
        cancelDevice: Effect.fn("HostedDocs.cancelDevice")(function* (profile: ProfileId) {
          yield* stopPending(profile)
          yield* changed(profile)
          return yield* status(profile)
        }),
        connectToken: (profile, site, token) => asInvalid(connectToken(profile, site, token)),
        disconnect: Effect.fn("HostedDocs.disconnect")(function* (profile: ProfileId) {
          yield* stopPending(profile)
          yield* forget(profile)
          yield* changed(profile)
          return yield* status(profile)
        }),
        published,
        publish,
        callTool: (profile, name, args) => asInvalid(callTool(profile, name, args)),
      })
    }),
  )
}
