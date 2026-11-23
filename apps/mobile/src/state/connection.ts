import { Effect, Exit } from "effect"
import { Atom } from "effect/reactivity"
import { callHub, serverUrlAtom, tokenAtom } from "@huntaway/client"
import Constants from "expo-constants"
import { Platform } from "react-native"
import { type BoardLink, rpcUrl } from "../logic/link"
import { errorText, exitError, runExit } from "./action"
import { registry } from "./registry"
import { load, save } from "./storage"

// The board the app shows: one, kept in the keychain (address and token), set into @huntaway/client's
// `serverUrlAtom` and `tokenAtom`, so its sessions, board and threads are the web app's own. Linked hosts come through
// that board's relay, as on the web. The token is the phone's own, from pairing by the PIN the board shows (HE-91), or
// the board's, from its link.

const URL_KEY = "huntaway.url"
const TOKEN_KEY = "huntaway.token"

/** What the app is connected to: not known yet (the keychain is read at start), no board, or a board. */
export type Connection = { readonly _tag: "loading" } | { readonly _tag: "none" } | { readonly _tag: "board"; readonly link: BoardLink }

export const connectionAtom: Atom.Writable<Connection> = Atom.make<Connection>({ _tag: "loading" }).pipe(Atom.keepAlive)

/** Points the client's sessions at `link` (or at nothing). */
const use = (link: BoardLink | null): void => {
  registry.set(serverUrlAtom, link === null ? "" : rpcUrl(link.url))
  registry.set(tokenAtom, link?.token ?? "")
}

/** At start: the board kept in the keychain, if there is one. */
export function startConnection(): void {
  void Promise.all([load(URL_KEY), load(TOKEN_KEY)]).then(([url, token]) => {
    const link = url === null || token === null ? null : { url, token }
    use(link)
    registry.set(connectionAtom, link === null ? { _tag: "none" } : { _tag: "board", link })
  })
}

/** How long a board has to answer before connecting to it gives up. */
const ANSWER_WITHIN = "10 seconds"

/** What the phone calls itself to a board it pairs with ("Pixel 8"). */
const deviceName = (): string => Constants.deviceName ?? (Platform.OS === "web" ? "Browser" : "Phone")

/**
 * Connects to `link`: the board must answer `public.health` first. With `pin`, the phone pairs with the board by the PIN
 * it shows and keeps the token it gets; else a link with no token takes the one a board started with `--open-token`
 * hands out. Kept in the keychain once it answers. On failure the app stays on the board it had. `done` gets why it
 * failed, or null.
 */
export function connect(link: BoardLink, done: (why: string | null) => void, pin: string | null = null): void {
  const before = registry.get(connectionAtom)
  const unanswered = `${link.url} didn't answer. Is the address right, and is the phone on its network?`
  use({ url: link.url, token: link.token })
  const check = Effect.gen(function* () {
    yield* callHub("public.health", undefined)
    if (pin !== null) {
      // What pairing says (a wrong PIN, pairing off) is for the user as it is, without the field's name.
      const paired = yield* callHub("public.pair", { pin, name: deviceName() }).pipe(
        Effect.mapError((e) => (e._tag === "Invalid" || e._tag === "Unavailable" ? e.reason : errorText(e))),
      )
      return paired.token
    }
    if (link.token !== "") return link.token
    const open = yield* callHub("public.openToken", undefined).pipe(Effect.option)
    if (open._tag === "None") return yield* Effect.fail("This board needs its token: copy its link from Settings → Network access on the board.")
    return open.value.token
  }).pipe(Effect.timeoutOrElse({ duration: ANSWER_WITHIN, orElse: () => Effect.fail(unanswered) }))
  runExit(check, (exit) => {
    if (Exit.isFailure(exit)) {
      use(before._tag === "board" ? before.link : null)
      // A socket that can't open at all may end the call without a failure of its own to tell.
      const why = Exit.findErrorOption(exit)
      const detail = exitError(exit)
      return done(
        why._tag === "Some" && typeof why.value === "string" ? why.value : detail === null || detail === "" ? unanswered : `${unanswered} (${detail})`,
      )
    }
    const kept = { url: link.url, token: exit.value }
    use(kept)
    registry.set(connectionAtom, { _tag: "board", link: kept })
    void Promise.all([save(URL_KEY, kept.url), save(TOKEN_KEY, kept.token)]).then(() => done(null))
  })
}

/**
 * Forgets the board: the connect screen shows. A phone paired with it unpairs itself first, so its token is no good
 * anywhere (a board's own token is left as it is: `Invalid`, ignored, as is a board that doesn't answer).
 */
export function disconnect(done: () => void): void {
  const unpair = callHub("hub.devices.unpair", undefined).pipe(Effect.timeout("3 seconds"), Effect.ignore)
  runExit(unpair, () => {
    use(null)
    registry.set(connectionAtom, { _tag: "none" })
    void Promise.all([save(URL_KEY, null), save(TOKEN_KEY, null)]).then(done)
  })
}
