import { Context, Effect, Layer, Option, Redacted } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, NotFound } from "@huntaway/contracts"
import type { NewSignIn, ProfileId, SignedIn, SignIn, SignInChange, Unavailable } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { SignInRepo } from "./SignInRepo.ts"
import { fillSignIn, originOf } from "./signInFill.ts"
import { Spaces } from "./Spaces.ts"

// Sign-ins for Spaces (HE-48; docs/plan/06-server.md, Spaces), after Cua's Keyvault: a profile's saved logins, which
// the host's server types into a running Space's browser when the user allows it (`signIn`, from the host's page or the
// `space_sign_in` tool, which asks the user first). Kept in `sign_ins` (`SignInRepo`); the password is a `Redacted`
// from the RPC's payload to the driver's `browser_type`, and no answer has it.

/** Where the tab to fill is: the caller's own, from its `get_browser_state` (both ids or neither). */
export interface SignInTab {
  readonly session?: string | undefined
  readonly target_id?: string | undefined
  readonly tab_id?: string | undefined
}

export interface SignInsShape {
  /** A profile's sign-ins (every profile's when left out). */
  readonly list: (profile?: ProfileId) => Effect.Effect<ReadonlyArray<SignIn>>
  readonly create: (input: NewSignIn) => Effect.Effect<SignIn, Invalid | NotFound>
  readonly update: (input: SignInChange) => Effect.Effect<SignIn, Invalid | NotFound>
  readonly remove: (id: string) => Effect.Effect<void, NotFound>
  /** The profile's sign-ins for the address's site (`Invalid` for one that isn't http(s)). */
  readonly forSite: (profile: ProfileId, url: string) => Effect.Effect<ReadonlyArray<SignIn>, Invalid>
  /**
   * Types sign-in `id` into running Space `space`'s browser and submits it, on the driver's MCP session `key` (the
   * caller's, so that a tab it named is its own): at `url` (its sign-in page, when left out) in a Chromium the server opens,
   * or in the caller's `tab`, which must be on the sign-in's origin.
   */
  readonly signIn: (
    space: string,
    key: string,
    id: string,
    at: { readonly url?: string | undefined; readonly tab?: SignInTab },
  ) => Effect.Effect<SignedIn, NotFound | Unavailable | Invalid>
}

/** Trimmed, or null when blank. */
const trimmed = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? ""
  return t === "" ? null : t
}

/** The site's origin, or why the address isn't one. */
const site = (url: string) => {
  const origin = originOf(url)
  return origin === null ? Effect.fail(new Invalid({ field: "url", reason: "Give the site's http:// or https:// address." })) : Effect.succeed(origin)
}

export class SignIns extends Context.Service<SignIns, SignInsShape>()("huntaway-server/spaces/SignIns") {
  static readonly layer = Layer.effect(
    SignIns,
    Effect.gen(function* () {
      const repo = yield* SignInRepo
      const profiles = yield* Profiles
      const spaces = yield* Spaces
      const random = yield* SecureRandom.SecureRandom

      const found = (id: string) =>
        Effect.flatMap(repo.get(id), Option.match({ onNone: () => Effect.fail(new NotFound({ what: "sign-in", id })), onSome: Effect.succeed }))

      const create = Effect.fn("SignIns.create")(function* (input: NewSignIn) {
        yield* profiles.get(input.profile_id).pipe(Effect.mapError(() => new NotFound({ what: "profile", id: input.profile_id })))
        const origin = yield* site(input.url)
        const login_url = new URL(input.url.trim()).href
        const username = input.username.trim()
        if (username === "") return yield* new Invalid({ field: "username", reason: "Give the username." })
        if (Redacted.value(input.password) === "") return yield* new Invalid({ field: "password", reason: "Give the password." })
        const id = yield* random.uuidV4()
        const at = yield* nowTimestamp
        yield* repo.insert({ id, profile_id: input.profile_id, origin, login_url, username, password: input.password, label: trimmed(input.label), at })
        return yield* found(id)
      })

      const update = Effect.fn("SignIns.update")(function* (input: SignInChange) {
        const username = input.username?.trim()
        if (username === "") return yield* new Invalid({ field: "username", reason: "Give the username." })
        if (input.password !== undefined && Redacted.value(input.password) === "") {
          return yield* new Invalid({ field: "password", reason: "Give the password." })
        }
        const page = input.url === undefined ? undefined : { origin: yield* site(input.url), login_url: new URL(input.url.trim()).href }
        const set = { page, username, password: input.password, label: input.label === undefined ? undefined : trimmed(input.label), at: yield* nowTimestamp }
        if (!(yield* repo.update(input.id, set))) return yield* new NotFound({ what: "sign-in", id: input.id })
        return yield* found(input.id)
      })

      const remove = Effect.fn("SignIns.remove")(function* (id: string) {
        if (!(yield* repo.remove(id))) return yield* new NotFound({ what: "sign-in", id })
        return undefined
      })

      const signIn = Effect.fn("SignIns.signIn")(function* (
        space: string,
        key: string,
        id: string,
        at: { readonly url?: string | undefined; readonly tab?: SignInTab },
      ) {
        const s = yield* found(id)
        const password = yield* Effect.flatMap(
          repo.password(id),
          Option.match({ onNone: () => Effect.fail(new NotFound({ what: "sign-in", id })), onSome: Effect.succeed }),
        )
        const url = at.url ?? s.login_url
        if (originOf(url) !== s.origin) return yield* new Invalid({ field: "url", reason: `${url} isn't on ${s.origin}, the sign-in's site.` })
        const done = yield* fillSignIn((tool, args) => spaces.driver(space, key, "tools/call", { name: tool, arguments: args }), {
          url,
          origin: s.origin,
          username: s.username,
          password,
          fresh: `huntaway-sign-in-${(yield* random.uuidV4()).slice(0, 8)}`,
          ...at.tab,
        })
        yield* repo.used(id, yield* nowTimestamp)
        return done
      })

      return SignIns.of({
        list: (profile) => repo.list(profile ?? null),
        create,
        update,
        remove,
        forSite: (profile, url) => Effect.flatMap(site(url), (origin) => repo.forOrigin(profile, origin)),
        signIn,
      })
    }),
  )
}
