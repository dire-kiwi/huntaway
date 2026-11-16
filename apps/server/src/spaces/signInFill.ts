import { Effect, Option, Predicate, Redacted, Schema } from "effect"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { NotFound, SignedIn } from "@huntaway/contracts"
import { CuaResult } from "../desktop/cua.ts"
import type { DriverAnswer } from "./driverMcp.ts"

// Typing a saved sign-in into a Space's browser (HE-48), after Cua's Keyvault: a fixed sequence of the Space's own Cua
// Driver browser tools, checked on Cua's image (cua-driver 0.49.1).
//
// 1. The tab: the caller's (`session`, `target_id`, `tab_id` from its own `get_browser_state`, on the same MCP session),
//    or a Chromium the driver owns, on the profile `huntaway-sign-in` (kept on disk, so the session it signs in stays
//    for the next `browser_prepare` of that profile), opened on the sign-in page (`browser_prepare`, `list_windows`,
//    `get_browser_state` with the window, `browser_navigate`).
// 2. A snapshot (`get_browser_state`): the tab's URL must be on the sign-in's exact origin, or nothing is typed. This is
//    what keeps a look-alike page from being given the password.
// 3. The fields, from the snapshot's refs: the first password input, the username-like input before it, and the submit
//    button after it.
// 4. `browser_type` into each, then `browser_click` the button (in the foreground: on Linux, Chromium's trusted input
//    activates its window, and the driver refuses it in the background).
//
// The password is only ever the text of one `browser_type`. Nothing returned has it: the driver's messages and the
// tab's URL after (a form sent by GET puts it in the address) are scrubbed of it.

/** The driver-owned Chromium profile a sign-in opens when the caller names no tab. */
export const SIGN_IN_PROFILE = "huntaway-sign-in"
/** The driver's session label for that browser. */
export const SIGN_IN_SESSION = "huntaway-sign-in"

/** A site's origin, `scheme://host[:port]` (lowercase, the default port left out), for an http(s) address; null otherwise. */
export const originOf = (url: string): string | null => {
  if (!URL.canParse(url.trim())) return null
  const u = new URL(url.trim())
  return u.protocol === "http:" || u.protocol === "https:" ? u.origin.toLowerCase() : null
}

/** A username as the agent is told it: its first character, then `***`, and an email's domain. */
export const maskUsername = (username: string): string => {
  const at = username.lastIndexOf("@")
  const name = at > 0 ? username.slice(0, at) : username
  return `${name.slice(0, 1)}***${at > 0 ? username.slice(at) : ""}`
}

/** `text` with `secret` taken out, as typed and as an address or a form would encode it. */
export const scrub = (text: string, secret: string): string => {
  if (secret === "") return text
  const forms = [secret, encodeURIComponent(secret), encodeURIComponent(secret).replaceAll("%20", "+")]
  return [...new Set(forms)].reduce((t, f) => t.split(f).join("***"), text)
}

/** An input of a login form: its ref and its `type`. */
export interface Field {
  readonly ref: string
  readonly kind: string
}

/** The fields of a login form a snapshot shows. */
export interface LoginFields {
  readonly username: Field | null
  readonly password: Field
  readonly submit: string | null
}

const Ref = Schema.Struct({ ref: Schema.String, node: Schema.String, label: Schema.NullOr(Schema.String) })
const decodeRef = Schema.decodeUnknownOption(Ref)
const USERNAME_TYPES: ReadonlySet<string> = new Set(["text", "email", "tel", "username"])

/** An attribute of a ref's label (`name=pw id=pw type=password`). */
const attr = (label: string | null, key: string): string | null =>
  (label ?? "")
    .split(/\s+/u)
    .find((kv) => kv.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? null

/**
 * The password input, the username-like input before it and the submit control after it, from a `dom_refs_v1`
 * snapshot's `refs`; null when there is no password input.
 */
export const pickLoginFields = (refs: ReadonlyArray<unknown>): LoginFields | null => {
  const rows = refs.flatMap((r) => Option.toArray(decodeRef(r)).map((d) => ({ ref: d.ref, label: d.label, node: d.node.toLowerCase() })))
  const pw = rows.findIndex((r) => r.node === "input" && attr(r.label, "type") === "password")
  const found = rows[pw]
  if (found === undefined) return null
  const user = rows
    .slice(0, pw)
    .toReversed()
    .find((r) => r.node === "input" && USERNAME_TYPES.has(attr(r.label, "type") ?? "text"))
  const after = rows.slice(pw + 1)
  const submit =
    after.find((r) => (r.node === "button" || r.node === "input") && attr(r.label, "type") === "submit") ??
    after.find((r) => r.node === "button" && attr(r.label, "type") !== "button")
  return {
    username: user === undefined ? null : { ref: user.ref, kind: attr(user.label, "type") ?? "text" },
    password: { ref: found.ref, kind: "password" },
    submit: submit?.ref ?? null,
  }
}

/** A driver tool's call (`tools/call`), as `Spaces.driver` makes it on the caller's MCP session. */
export type DriverCall = (tool: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<DriverAnswer, NotFound | Unavailable>

/** What to sign in with, and where. */
export interface Fill {
  readonly url: string
  readonly origin: string
  readonly username: string
  readonly password: Redacted.Redacted
  /** The caller's tab, if it names one (`target_id` and `tab_id` both, or neither). */
  readonly session?: string | undefined
  readonly target_id?: string | undefined
  readonly tab_id?: string | undefined
}

const decodeResult = Schema.decodeUnknownOption(CuaResult)
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const isText = Schema.is(TextPart)
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined)
const str = (v: unknown, key: string): string | null => {
  const s = field(v, key)
  return typeof s === "string" ? s : null
}
const int = (v: unknown, key: string): number | null => {
  const n = field(v, key)
  return typeof n === "number" && Number.isInteger(n) ? n : null
}
const list = (v: unknown, key: string): ReadonlyArray<unknown> => {
  const a = field(v, key)
  return Array.isArray(a) ? a : []
}

const unavailable = (reason: string) => new Unavailable({ what: "space", reason })
const invalid = (reason: string) => new Invalid({ field: "page", reason })

/** Types the sign-in into its page and submits it. See the top of the file. */
export const fillSignIn = Effect.fn("signInFill.fillSignIn")(function* (call: DriverCall, fill: Fill) {
  const secret = Redacted.value(fill.password)

  /** A tool's structured answer, or its refusal as `Unavailable`, scrubbed. */
  const ok = (tool: string, args: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const a = yield* call(tool, args).pipe(Effect.mapError((e) => (e._tag === "Unavailable" ? unavailable(scrub(e.reason, secret)) : e)))
      if ("error" in a) return yield* unavailable(scrub(a.error, secret))
      const r = Option.getOrNull(decodeResult(a.result))
      if (r === null) return yield* unavailable(`Cua Driver's answer to ${tool} didn't parse`)
      const sc = r.structuredContent
      if (r.isError === true || str(sc, "status") === "refused" || str(sc, "effect") === "refused") {
        const said = (r.content ?? [])
          .filter(isText)
          .map((t) => t.text)
          .join("\n")
        return yield* unavailable(scrub(`Cua Driver's ${tool} refused: ${said === "" ? "no reason given" : said}`, secret))
      }
      return sc
    })

  if ((fill.target_id === undefined) !== (fill.tab_id === undefined)) {
    return yield* new Invalid({ field: "tab_id", reason: "Name both the tab's target_id and tab_id, or neither." })
  }
  const session = fill.session ?? SIGN_IN_SESSION
  let target = fill.target_id ?? ""
  let tab = fill.tab_id ?? ""
  if (fill.target_id === undefined) {
    // A Chromium of the driver's own, on the sign-in page.
    const prepared = yield* ok("browser_prepare", { session, allow_launch: true, profile: { mode: "isolated_named", name: SIGN_IN_PROFILE } })
    const pid = int(prepared, "prepared_pid")
    if (pid === null) return yield* unavailable("Cua Driver's browser_prepare gave no browser")
    let window: number | null = null
    for (let i = 0; i < 40 && window === null; i++) {
      if (i > 0) yield* Effect.sleep("250 millis")
      const ws = yield* ok("list_windows", { session })
      window = list(ws, "windows").flatMap((w) => (int(w, "pid") === pid && int(w, "window_id") !== null ? [int(w, "window_id")] : []))[0] ?? null
    }
    if (window === null) return yield* unavailable("The browser Cua Driver opened never showed a window.")
    const bound = yield* ok("get_browser_state", { session, pid, window_id: window })
    const tabs = list(bound, "tabs")
    const active = tabs.find((t) => field(t, "active") === true) ?? tabs[0]
    target = str(bound, "target_id") ?? ""
    tab = str(active, "tab_id") ?? ""
    if (target === "" || tab === "") return yield* unavailable("Cua Driver found no tab in the browser it opened.")
    yield* ok("browser_navigate", { session, target_id: target, tab_id: tab, url: fill.url })
  }
  const ids = { session, target_id: target, tab_id: tab }

  // The page must be on the sign-in's own origin, with a password field: a page still loading gets a few reads.
  let page: string | null = null
  let fields: LoginFields | null = null
  for (let i = 0; i < 20; i++) {
    if (i > 0) yield* Effect.sleep("250 millis")
    const snap = yield* ok("get_browser_state", ids)
    page = originOf(str(snap, "url") ?? "")
    fields = pickLoginFields(list(snap, "refs"))
    if (page === fill.origin && fields !== null) break
  }
  if (page !== fill.origin) {
    return yield* invalid(`The tab is on ${page ?? "no web page"}, not ${fill.origin}: a sign-in is typed only on its own site.`)
  }
  if (fields === null) return yield* invalid(`There's no password field on the page: open ${fill.origin}'s sign-in page first.`)

  const user = fields.username
  if (user !== null && fill.username !== "") {
    // The driver's select-and-replace doesn't apply to an email input.
    yield* ok("browser_type", { ...ids, ref: user.ref, text: fill.username, replace: user.kind !== "email" })
  }
  yield* ok("browser_type", { ...ids, ref: fields.password.ref, text: secret, replace: true })
  const submit = fields.submit
  if (submit !== null) yield* ok("browser_click", { ...ids, ref: submit, delivery_mode: "foreground" })

  // Where the tab went (it may still be on its way): until the password field has gone.
  let after = ""
  for (let i = 0; i < 8; i++) {
    if (i > 0) yield* Effect.sleep("250 millis")
    const snap = yield* Effect.option(ok("get_browser_state", ids))
    if (Option.isNone(snap)) continue
    after = str(snap.value, "url") ?? after
    if (submit === null || pickLoginFields(list(snap.value, "refs")) === null) break
  }
  const done: SignedIn = {
    origin: fill.origin,
    username_hint: maskUsername(fill.username),
    submitted: submit !== null,
    page_url: scrub(after, secret),
    ...ids,
  }
  return done
})
