import { SqliteClient } from "@effect/sql-sqlite-node"
import { Clock, Context, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Cipher, Digest, Kdf, SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { Invalid, NotFound, Timestamp, Unavailable } from "@huntaway/contracts"
import type { BringResult, BringSignIns, BrowserSource, TeleportImport, TeleportSite, TeleportSites, WipeAfter } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { CATALOG, catalogFor, chromiumProfiles, firefoxProfiles, rootsOf } from "./teleport/browsers.ts"
import type { BrowserCatalog } from "./teleport/browsers.ts"
import { decryptValue, deriveKey, DIGEST_VERSION, secretToolArgs, V10_PASSWORD, versionOf } from "./teleport/chromiumCrypto.ts"
import { storageItems, storageOrigins } from "./teleport/chromiumStorage.ts"
import type { StorageFile } from "./teleport/chromiumStorage.ts"
import { manifestValue, signInEntries, tar } from "./teleport/bundle.ts"
import type { CookieRow, StorageItem } from "./teleport/bundle.ts"
import { isIdentityProvider, looksSignedIn, normalizeHost, originHost, siteOf } from "./teleport/sites.ts"
import { Spaces } from "./Spaces.ts"
import { TeleportRepo } from "./TeleportRepo.ts"
import {
  BUNDLE_VERSION,
  CHUNK_BYTES,
  GET_MANIFEST,
  headerRefusal,
  IMPORT_SESSION,
  importRequest,
  manifestRequest,
  NOT_FOUND,
  parseImport,
  parseManifest,
  parseWipe,
  unframe,
  WIPE_IMPORT,
  wipeRequest,
} from "./teleport/wire.ts"

// Teleport (HE-49; docs/plan/06-server.md, Spaces): bring a host browser profile's sign-ins into a Space. Reads the
// host's Chrome/Chromium or Firefox profile (its `Cookies` SQLite and `Local Storage/leveldb`, or `cookies.sqlite`),
// groups them by site, and (once the user picks) decrypts the chosen sites, closes the Space's browser, builds a
// `cua-teleport-bundle` and uploads it to the Space's spacesd (`cua.env.v1.TeleportService`): `GetManifest`, then
// `ImportSession` in chunks of at most 4 MiB, committed with the bundle's SHA-256 and an optional self-wipe time. The
// `import_id` is kept so "Remove sign-ins" can `WipeImport`. Saved passwords are not moved (Sign-ins, HE-48, do those).
//
// Nothing is decrypted to list sites: the counts come from the cookie rows' `host_key`/`name` alone. Cookie values are
// decrypted only for the sites the user sends, and never logged, returned or stored on the host.

// `expires_utc` is Chrome's microseconds since 1601, which overflows a JS number (and node:sqlite refuses to read such
// an integer as a number): it is read as text and parsed. The granularity lost at that magnitude is sub-microsecond,
// which a cookie expiry (seconds) doesn't care about.

/** A cookie row as read from a Cookies database (Chromium: `encrypted_value`; Firefox: a plain `value`). */
const CookieRead = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  encrypted_value: Schema.Uint8Array,
  value: Schema.String,
  path: Schema.String,
  expires_utc: Schema.String,
  is_secure: Schema.Finite,
  is_httponly: Schema.Finite,
  samesite: Schema.Finite,
})
type CookieRead = typeof CookieRead.Type

/** A cookie's host and name alone, for counting a profile's sites without reading any big or encrypted column. */
const CookieName = Schema.Struct({ host_key: Schema.String, name: Schema.String })
type CookieName = typeof CookieName.Type

const decodeCount = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ n: Schema.Finite })))

/** Whether a Chromium `cookies` table has CHIPS's `top_frame_site_key` (older databases don't). */
const hasPartitions = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql`SELECT count(*) AS n FROM pragma_table_info('cookies') WHERE name = 'top_frame_site_key'`,
    (rows) => Option.getOrElse(decodeCount(rows), () => [])[0]?.n === 1,
  )

/** Chrome's epoch offset: microseconds between 1601-01-01 and 1970-01-01. */
const CHROME_EPOCH_MICROS = 11644473600 * 1_000_000

/**
 * A cookie's SameSite as Chrome's row has it: 0 none, 1 lax, 2 strict, anything else unspecified (-1). Firefox's
 * `SAMESITE_UNSET` is 256: as Strict, the cookie would stop going with cross-site navigations (sign-in redirects).
 */
export const sameSiteOf = (n: number): number => (n === 0 || n === 1 || n === 2 ? n : -1)

/** The `moz_cookies` schema version (`PRAGMA user_version`) from which `expiry` is in milliseconds (Firefox 142). */
export const FIREFOX_MS_EXPIRY = 16

/**
 * A Firefox cookie row (plaintext) as a bundle row: its expiry (unix seconds, or milliseconds from schema
 * `FIREFOX_MS_EXPIRY`) becomes Chrome's microseconds since 1601.
 */
export const firefoxCookie = (c: CookieRead, schema: number): CookieRow => {
  const expiry = Number(c.expires_utc)
  const seconds = schema >= FIREFOX_MS_EXPIRY ? expiry / 1000 : expiry
  return {
    host_key: c.host_key,
    name: c.name,
    value: new TextEncoder().encode(c.value),
    path: c.path,
    expires_utc: expiry === 0 ? 0 : Math.round(seconds * 1_000_000) + CHROME_EPOCH_MICROS,
    is_secure: c.is_secure !== 0,
    is_httponly: c.is_httponly !== 0,
    samesite: sameSiteOf(c.samesite),
  }
}

/**
 * Closes the Space's browsers and waits for them to exit: TERM, up to 10 s, then KILL, up to 5 s more; exits 3 if one is
 * still running. Matched exactly on process names (`comm`, 15 characters: `chromium-browser` is `chromium-browse`), so
 * neither this command's own shell nor anything else that mentions a browser is hit. Firefox's main process is
 * `firefox-bin` in the Space's image; its content processes go with it.
 */
export const CLOSE_BROWSER = [
  "p='chrome|chromium|chromium-browse|firefox|firefox-bin|firefox-esr'",
  'pgrep -x "$p" >/dev/null || exit 0',
  'pkill -TERM -x "$p"',
  'for i in $(seq 1 20); do pgrep -x "$p" >/dev/null || exit 0; sleep 0.5; done',
  'pkill -KILL -x "$p"',
  'for i in $(seq 1 10); do pgrep -x "$p" >/dev/null || exit 0; sleep 0.5; done',
  "exit 3",
].join("\n")

/** A profile's directory under its browser's root (a Firefox profile's path may be absolute). */
const profileDir = (root: string, profile: string): string => (profile.startsWith("/") ? profile : `${root}/${profile}`)

/** When the Space wipes a teleport itself: a wall-clock millisecond, or 0 for never. */
const wipeAfterMs = (when: WipeAfter | undefined, now: number): number => (when === "hour" ? now + 3600_000 : when === "day" ? now + 86400_000 : 0)

export interface TeleportShape {
  /** The browsers on the host that runs the server, with their profiles. */
  readonly sources: Effect.Effect<ReadonlyArray<BrowserSource>, Unavailable>
  /** The sites a browser profile holds, with cookie counts; nothing decrypted. */
  readonly sites: (browser: string, profile: string) => Effect.Effect<TeleportSites, Invalid | NotFound | Unavailable>
  /** Send the chosen sites into a Space. */
  readonly bring: (input: BringSignIns) => Effect.Effect<BringResult, Invalid | NotFound | Unavailable>
  /** The teleports that landed in a Space. */
  readonly imports: (spaceId: string) => Effect.Effect<ReadonlyArray<TeleportImport>>
  /** Remove a teleport's sign-ins from its Space; gone already counts as removed. */
  readonly remove: (importId: string) => Effect.Effect<void, NotFound | Unavailable>
}

const unavailable = (reason: string) => new Unavailable({ what: "teleport", reason })

/** What answers on a Space's port is the Space's to choose: the server never follows it somewhere else. */
const NO_REDIRECTS: RequestInit = { redirect: "error" }

const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))
/** A value as compact UTF-8 JSON bytes (for a bundle entry). Our shapes always encode. */
const encodeBytes = (value: unknown): Uint8Array => new TextEncoder().encode(Option.getOrElse(encodeJson(value), () => "null"))

export class Teleport extends Context.Service<Teleport, TeleportShape>()("huntaway-server/spaces/Teleport") {
  static readonly layer = Layer.effect(
    Teleport,
    Effect.gen(function* () {
      const spaces = yield* Spaces
      const repo = yield* TeleportRepo
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const proc = yield* Proc
      const http = yield* HttpClient.HttpClient
      const random = yield* SecureRandom.SecureRandom
      const kdf = yield* Kdf.Kdf
      const cipher = yield* Cipher.Cipher
      const digest = yield* Digest.Digest
      const home = config.home

      const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))

      // ---- the host's browsers ----

      /** Whether a profile directory holds a cookie store (a config folder with no profile in it lists none). */
      const hasCookies = Effect.fnUntraced(function* (b: BrowserCatalog, dir: string) {
        const stores = b.kind === "firefox" ? [`${dir}/cookies.sqlite`] : [`${dir}/Cookies`, `${dir}/Network/Cookies`]
        for (const f of stores) if (yield* exists(f)) return true
        return false
      })

      /**
       * A browser's root (the first of `rootsOf` that has a profile holding cookies) and those profiles; null when it has
       * none (it isn't offered).
       */
      const profilesOf = Effect.fnUntraced(function* (b: BrowserCatalog) {
        for (const root of rootsOf(b, home, config.configHome)) {
          if (!(yield* exists(root))) continue
          const listed =
            b.kind === "firefox" ? firefoxProfiles(yield* readText(`${root}/profiles.ini`)) : chromiumProfiles(yield* readText(`${root}/Local State`))
          const profiles: Array<{ readonly id: string; readonly label: string }> = []
          for (const p of listed) if (yield* hasCookies(b, profileDir(root, p.id))) profiles.push(p)
          if (profiles.length > 0) return { root, profiles }
        }
        return null
      })

      const sources = Effect.gen(function* () {
        const out: Array<BrowserSource> = []
        for (const b of CATALOG) {
          const found = yield* profilesOf(b)
          if (found !== null) out.push({ key: b.key, kind: b.kind, label: b.label, profiles: found.profiles })
        }
        return out
      }).pipe(Effect.withSpan("Teleport.sources"))

      // ---- reading a profile ----

      const resolve = Effect.fnUntraced(function* (browser: string, profile: string) {
        const b = catalogFor(browser)
        if (b === null) return yield* new Invalid({ field: "browser", reason: `no browser ${browser}` })
        const found = yield* profilesOf(b)
        if (found === null || !found.profiles.some((p) => p.id === profile))
          return yield* new NotFound({ what: "browser profile", id: `${browser}/${profile}` })
        const dir = profileDir(found.root, profile)
        if (!(yield* exists(dir))) return yield* new NotFound({ what: "browser profile", id: `${browser}/${profile}` })
        return { b, dir }
      })

      /** The newest mtime (milliseconds) of a file, or -1 when it isn't there. */
      const mtime = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((s) =>
            Option.getOrElse(
              Option.map(s.mtime, (d) => d.getTime()),
              () => 0,
            ),
          ),
          Effect.orElseSucceed(() => -1),
        )

      /** The newest of a Chromium profile's cookie stores (`Cookies` or `Network/Cookies`), or Firefox's `cookies.sqlite`. */
      const cookieStore = Effect.fnUntraced(function* (b: BrowserCatalog, dir: string) {
        if (b.kind === "firefox") return `${dir}/cookies.sqlite`
        const network = `${dir}/Network/Cookies`
        return (yield* mtime(network)) > (yield* mtime(`${dir}/Cookies`)) ? network : `${dir}/Cookies`
      })

      /** Opens a copy of a SQLite database (so a running browser's lock doesn't matter) and reads with `read`. */
      const withDb = Effect.fnUntraced(function* <A>(dbPath: string, read: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>) {
        if (!(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))) return null
        const dir = yield* fs.makeTempDirectoryScoped()
        const copy = `${dir}/db.sqlite`
        yield* fs.copyFile(dbPath, copy).pipe(Effect.orDie)
        for (const suffix of ["-wal", "-shm"]) yield* fs.copyFile(`${dbPath}${suffix}`, `${copy}${suffix}`).pipe(Effect.ignore)
        const context = yield* Layer.build(SqliteClient.layer({ filename: copy, readonly: false }))
        const sql = Context.get(context, SqlClient.SqlClient)
        return yield* read(sql).pipe(Effect.orElseSucceed(() => null))
      })

      // Only a profile's own first-party cookies are read: not partitioned ones, which a site set inside another site's
      // page (Firefox's Total Cookie Protection, `originAttributes` `^partitionKey=…`; Chromium's CHIPS,
      // `top_frame_site_key`), nor a Firefox container's (`^userContextId=…`). The bundle's rows are first-party, so a
      // partitioned twin of a cookie, or another container's account, would be sent as that cookie and could replace it.

      /** Just each cookie's host and name, for counting a profile's sites. */
      const cookieNames = (b: BrowserCatalog, dir: string): Effect.Effect<ReadonlyArray<CookieName>> =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* cookieStore(b, dir)
            const decode = Schema.decodeUnknownOption(Schema.Array(CookieName))
            const got = yield* withDb(path, (sql) =>
              b.kind === "firefox"
                ? sql`SELECT host AS host_key, name FROM moz_cookies WHERE originAttributes = ''`
                : Effect.flatMap(hasPartitions(sql), (partitioned) =>
                    partitioned ? sql`SELECT host_key, name FROM cookies WHERE top_frame_site_key = ''` : sql`SELECT host_key, name FROM cookies`,
                  ),
            )
            return got === null ? [] : Option.getOrElse(decode(got), () => [])
          }),
        ).pipe(Effect.orElseSucceed(() => []))

      /** A profile's cookie rows, and its database's version (Chromium's `meta` row; Firefox's `user_version`; 0 if none). */
      const cookieRows = (b: BrowserCatalog, dir: string): Effect.Effect<{ readonly rows: ReadonlyArray<CookieRead>; readonly version: number }> =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* cookieStore(b, dir)
            const decode = Schema.decodeUnknownOption(Schema.Array(CookieRead))
            const decodeMeta = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ value: Schema.String })))
            const got = yield* withDb(path, (sql) =>
              b.kind === "firefox"
                ? Effect.zipWith(
                    sql`SELECT host AS host_key, name, CAST('' AS BLOB) AS encrypted_value, value, path,
                       CAST(expiry AS TEXT) AS expires_utc, isSecure AS is_secure, isHttpOnly AS is_httponly, sameSite AS samesite
                       FROM moz_cookies WHERE originAttributes = ''`,
                    sql`SELECT CAST(user_version AS TEXT) AS value FROM pragma_user_version`,
                    (rows, meta) => ({ rows, meta }),
                  )
                : Effect.zipWith(
                    Effect.flatMap(hasPartitions(sql), (partitioned) =>
                      partitioned
                        ? sql`SELECT host_key, name, encrypted_value, CAST(value AS TEXT) AS value, path,
                           CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies
                           WHERE top_frame_site_key = ''`
                        : sql`SELECT host_key, name, encrypted_value, CAST(value AS TEXT) AS value, path,
                           CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies`,
                    ),
                    sql`SELECT CAST(value AS TEXT) AS value FROM meta WHERE key = 'version'`,
                    (rows, meta) => ({ rows, meta }),
                  ),
            )
            if (got === null) return { rows: [], version: 0 }
            const meta = Option.getOrElse(decodeMeta(got.meta), () => [])
            return { rows: Option.getOrElse(decode(got.rows), () => []), version: Number(meta[0]?.value ?? "0") || 0 }
          }),
        ).pipe(Effect.orElseSucceed(() => ({ rows: [], version: 0 })))

      /** A Chromium profile's `Local Storage/leveldb` files (Firefox's localStorage isn't read yet). */
      const storageFiles = Effect.fnUntraced(function* (b: BrowserCatalog, dir: string) {
        const out: Array<StorageFile> = []
        if (b.kind === "firefox") return out
        const ldb = `${dir}/Local Storage/leveldb`
        if (!(yield* exists(ldb))) return out
        const names = yield* fs.readDirectory(ldb).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        for (const name of names) {
          if (!(name.endsWith(".log") || name.endsWith(".ldb") || name.endsWith(".sst"))) continue
          const bytes = yield* fs.readFile(`${ldb}/${name}`).pipe(Effect.orElseSucceed(() => null))
          if (bytes !== null) out.push({ name, bytes })
        }
        return out
      })

      /** A profile's sites: its cookies' and localStorage origins' hosts, grouped by `siteOf`. */
      const siteList = Effect.fnUntraced(function* (b: BrowserCatalog, dir: string) {
        const cookies = yield* cookieNames(b, dir)
        const files = yield* storageFiles(b, dir)
        const originsByHost = storageOrigins(files).map((o) => originHost(o))
        // Group by registrable domain.
        const byDomain = new Map<string, { names: Array<string>; cookies: number; storage: number }>()
        const bump = (host: string): { names: Array<string>; cookies: number; storage: number } => {
          const site = siteOf(host)
          let g = byDomain.get(site)
          if (g === undefined) {
            g = { names: [], cookies: 0, storage: 0 }
            byDomain.set(site, g)
          }
          return g
        }
        for (const c of cookies) {
          const g = bump(c.host_key)
          g.cookies += 1
          g.names.push(c.name)
        }
        for (const h of originsByHost) if (h !== "") bump(h).storage += 1
        const list: Array<TeleportSite> = [...byDomain.entries()].map(([site, g]) => ({
          site,
          cookie_count: g.cookies,
          storage_count: g.storage,
          signed_in: looksSignedIn(g.names) && !isIdentityProvider(site),
          identity_provider: isIdentityProvider(site),
        }))
        list.sort((a, b2) => (a.signed_in === b2.signed_in ? b2.cookie_count - a.cookie_count : a.signed_in ? -1 : 1))
        return list
      })

      const sites = Effect.fn("Teleport.sites")(function* (browser: string, profile: string) {
        const { b, dir } = yield* resolve(browser, profile)
        const out: TeleportSites = { browser, kind: b.kind, profile, sites: yield* siteList(b, dir) }
        return out
      })

      // ---- decrypting the chosen sites ----

      /** Decrypts the cookies of the wanted sites into bundle rows; a v20 or undecryptable row is left out. */
      const decryptCookies = Effect.fnUntraced(function* (
        b: BrowserCatalog,
        read: { readonly rows: ReadonlyArray<CookieRead>; readonly version: number },
        wanted: ReadonlySet<string>,
      ) {
        // Picked by the rule the sites were listed by: a site nested under another (`mybucket.s3.amazonaws.com` under
        // `amazonaws.com`, the public suffix list's private section) is its own, and isn't sent with it.
        const keep = read.rows.filter((c) => wanted.has(siteOf(c.host_key)))
        if (b.kind === "firefox") return { cookies: keep.map((c) => firefoxCookie(c, read.version)), appBound: 0, unread: 0 }
        const requireDigest = read.version >= DIGEST_VERSION
        let appBound = 0
        let unread = 0
        // Derive each Safe Storage key at most once; v11 needs the libsecret secret.
        let v10: Cipher.Key | null = null
        let v11: Cipher.Key | null = null
        let v11Tried = false
        const out: Array<CookieRow> = []
        for (const c of keep) {
          if (c.encrypted_value.length === 0) {
            // A plain row Chrome hasn't encrypted (its expiry is already Chrome's microseconds since 1601).
            if (c.value !== "")
              out.push({
                host_key: c.host_key,
                name: c.name,
                value: new TextEncoder().encode(c.value),
                path: c.path,
                expires_utc: Number(c.expires_utc),
                is_secure: c.is_secure !== 0,
                is_httponly: c.is_httponly !== 0,
                samesite: sameSiteOf(c.samesite),
              })
            continue
          }
          const version = versionOf(c.encrypted_value)
          if (version === "v20") {
            appBound += 1
            continue
          }
          if (version === null) {
            unread += 1
            continue
          }
          let key: Cipher.Key | null
          if (version === "v10") {
            v10 ??= yield* deriveKey(kdf, V10_PASSWORD)
            key = v10
          } else {
            if (!v11Tried) {
              v11Tried = true
              // Each Chromium-family browser keeps its own Safe Storage secret, by its product name.
              const secret = b.keyring === null ? null : yield* proc.run("secret-tool", [...secretToolArgs(b.keyring)]).pipe(Effect.orElseSucceed(() => null))
              const value = secret !== null && secret.code === 0 ? secret.stdout.replace(/[\r\n]+$/u, "") : ""
              if (value !== "") v11 = yield* deriveKey(kdf, new TextEncoder().encode(value))
            }
            key = v11
          }
          if (key === null) {
            unread += 1
            continue
          }
          const plain = yield* decryptValue(cipher, digest, key, c.host_key, c.encrypted_value, requireDigest)
          if (plain === null) {
            unread += 1
            continue
          }
          out.push({
            host_key: c.host_key,
            name: c.name,
            value: plain,
            path: c.path,
            expires_utc: Number(c.expires_utc),
            is_secure: c.is_secure !== 0,
            is_httponly: c.is_httponly !== 0,
            samesite: sameSiteOf(c.samesite),
          })
        }
        return { cookies: out, appBound, unread }
      })

      const hex = (bytes: number) => Effect.map(random.randomBytes(bytes), (x) => Array.from(x, (n) => n.toString(16).padStart(2, "0")).join(""))

      // ---- uploading to the Space ----

      /** One gRPC-Web call to the Space's spacesd: its answer's message, or why it refused. */
      const grpc = Effect.fnUntraced(function* (port: number, token: string, path: string, body: Uint8Array) {
        const request = HttpClientRequest.post(`http://127.0.0.1:${port}${path}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${token}`, "x-grpc-web": "1", accept: "application/grpc-web+proto" }),
          HttpClientRequest.bodyUint8Array(body, "application/grpc-web+proto"),
        )
        const answer = yield* http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECTS),
          Effect.flatMap((r) =>
            Effect.map(r.arrayBuffer, (buf): { readonly message: Uint8Array } | { readonly refused: string } => {
              const refused = headerRefusal(r.headers)
              if (refused !== null) return { refused }
              if (r.status !== 200) return { refused: `spacesd answered ${r.status}` }
              return unframe(new Uint8Array(buf))
            }),
          ),
          Effect.orElseSucceed((): { readonly refused: string } => ({ refused: "spacesd isn't answering" })),
        )
        return answer
      })

      const bring = Effect.fn("Teleport.bring")(function* (input: BringSignIns) {
        const space = yield* spaces.find(input.id)
        const { b, dir } = yield* resolve(input.browser, input.profile)
        // Only sites the profile itself lists (`siteList`, which `sites` shows): so whatever the dialog listed can be sent,
        // and nothing wider (`com`, `co.kr`) than a site of its own can be asked for.
        const listed = new Set((yield* siteList(b, dir)).map((x) => x.site))
        const asked = [...new Set(input.sites.map(normalizeHost).filter((x) => x !== ""))]
        const strange = asked.filter((x) => !listed.has(x))
        if (strange.length > 0) return yield* new Invalid({ field: "sites", reason: `not sites of this profile: ${strange.join(", ")}` })
        const wanted = new Set(asked)
        if (wanted.size === 0) return yield* new Invalid({ field: "sites", reason: "pick at least one site" })
        const { port, token } = yield* spaces.endpoint(space.id)

        // Check the Space can take this bundle version before reading any secrets.
        const manifestAnswer = yield* grpc(port, token, GET_MANIFEST, manifestRequest(b.app))
        if ("refused" in manifestAnswer) return yield* unavailable(`the Space's spacesd refused the teleport manifest (${manifestAnswer.refused})`)
        const manifest = parseManifest(manifestAnswer.message)
        if (manifest === null || !manifest.supported) {
          return yield* unavailable(`the Space can't take ${b.app} sign-ins${manifest === null ? "" : `: ${manifest.limitation}`}`)
        }
        if (manifest.bundleVersion !== BUNDLE_VERSION) {
          return yield* unavailable(`the Space wants teleport bundle version ${manifest.bundleVersion}, and this server makes version ${BUNDLE_VERSION}`)
        }

        const read = yield* cookieRows(b, dir)
        const { cookies, appBound, unread } = yield* decryptCookies(b, read, wanted)
        const files = yield* storageFiles(b, dir)
        const originSet = new Set(storageOrigins(files).filter((o) => wanted.has(siteOf(originHost(o)))))
        const storage: ReadonlyArray<StorageItem> = storageItems(files, originSet)
        const notes = [
          ...(appBound === 0 ? [] : [`${appBound} cookie${appBound === 1 ? "" : "s"} app-bound (v20), which only ${b.label} itself can read`]),
          ...(unread === 0
            ? []
            : [`${unread} cookie${unread === 1 ? "" : "s"} couldn't be decrypted (${b.label}'s Safe Storage key isn't in the keyring, or doesn't fit)`]),
        ]
        if (cookies.length === 0 && storage.length === 0) {
          return yield* new Invalid({ field: "sites", reason: `nothing to send for those sites${notes.length === 0 ? "" : `: ${notes.join("; ")}`}` })
        }

        // Close the Space's browser and wait for it to go, so the import doesn't race its shutdown (spacesd refuses to
        // close it on Linux, and its importer assumes the profile is free).
        const closed = yield* spaces.bash(space.id, CLOSE_BROWSER, 30)
        if (closed.code !== 0)
          return yield* unavailable("The Space's browser didn't close, so its sign-ins weren't replaced. Close it in the Space and try again.")

        const parts = signInEntries(b.app, cookies, storage).map((e) => ({ path: e.path, mode: e.mode, bytes: encodeBytes(e.value) }))
        const sums = yield* Effect.forEach(parts, (f) => digest.digestHex(Digest.sha256, f.bytes), { concurrency: 1 })
        const bundle = tar([{ path: "manifest.json", mode: 0o644, bytes: encodeBytes(manifestValue(b.app, parts, sums)) }, ...parts])
        const sha = yield* digest.digestHex(Digest.sha256, bundle)
        const importId = yield* hex(12)
        const now = yield* Clock.currentTimeMillis
        const expiresMs = wipeAfterMs(input.wipe_after, now)

        // Upload in chunks of CHUNK_BYTES, commit on the last.
        let offset = 0
        let last: { readonly imported: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } | null = null
        while (offset < bundle.length || offset === 0) {
          const end = Math.min(offset + CHUNK_BYTES, bundle.length)
          const isLast = end >= bundle.length
          const answer = yield* grpc(
            port,
            token,
            IMPORT_SESSION,
            importRequest({
              importId,
              app: b.app,
              offset,
              data: bundle.subarray(offset, end),
              commit: isLast ? { sha256: sha, expiresAtMs: expiresMs } : null,
            }),
          )
          if ("refused" in answer) return yield* unavailable(`the Space's spacesd refused the sign-ins (${answer.refused})`)
          const parsed = parseImport(answer.message)
          if (parsed === null) return yield* unavailable("the Space's spacesd gave an answer the teleport didn't understand")
          if (isLast) {
            last = parsed.result
            break
          }
          offset = end
        }

        const createdAt = yield* nowTimestamp
        const sentSites = [...wanted]
        const label = sentSites.length <= 3 ? sentSites.join(", ") : `${sentSites.slice(0, 2).join(", ")} and ${sentSites.length - 2} more`
        const record: TeleportImport = {
          import_id: importId,
          space_id: space.id,
          app: b.app,
          label,
          site_count: sentSites.length,
          expires_at: expiresMs === 0 ? null : Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(expiresMs))),
          created_at: createdAt,
        }
        yield* repo.add(record)
        const out: BringResult = { import: record, imported: last?.imported ?? [], skipped: [...notes, ...(last?.skipped ?? [])] }
        return out
      })

      const imports = (spaceId: string) => repo.forSpace(spaceId)

      const remove = Effect.fn("Teleport.remove")(function* (importId: string) {
        const record = yield* repo.get(importId)
        if (record === null) return yield* new NotFound({ what: "teleport", id: importId })
        const ep = yield* spaces.endpoint(record.space_id).pipe(
          Effect.asSome,
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        )
        if (Option.isSome(ep)) {
          const answer = yield* grpc(ep.value.port, ep.value.token, WIPE_IMPORT, wipeRequest(importId))
          // Gone already (the Space wiped it on expiry, or it restarted): still a removal as far as the board is concerned.
          if ("refused" in answer && !answer.refused.startsWith(`${NOT_FOUND}:`) && answer.refused !== NOT_FOUND) {
            return yield* unavailable(`the Space's spacesd couldn't remove the sign-ins (${answer.refused})`)
          }
          if ("message" in answer) parseWipe(answer.message)
        }
        return yield* repo.remove(importId)
      })

      return Teleport.of({ sources, sites, bring, imports, remove })
    }),
  )
}
