import { Effect, Exit } from "effect"
import { Atom } from "effect/reactivity"
import { callHub, serverUrlAtom, tokenAtom } from "@huntaway/client"
import { type BoardLink, rpcUrl } from "../logic/link"
import { exitError, runExit } from "./action"
import { registry } from "./registry"
import { load, save } from "./storage"

// The board the app shows: one, kept in the keychain (address and token), set into @huntaway/client's
// `serverUrlAtom` and `tokenAtom`, so its sessions, board and threads are the web app's own. Linked hosts come through
// that board's relay, as on the web.

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

/**
 * Connects to `link`: the board must answer `public.health` first; a link with no token takes the one a board started
 * with `--open-token` hands out. Kept in the keychain once it answers. On failure the app stays on the board it had.
 * `done` gets why it failed, or null.
 */
export function connect(link: BoardLink, done: (why: string | null) => void): void {
  const before = registry.get(connectionAtom)
  const unanswered = `${link.url} didn't answer. Is the address right, and is the phone on its network?`
  use({ url: link.url, token: link.token })
  const check = Effect.gen(function* () {
    yield* callHub("public.health", undefined)
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

/** Forgets the board: the connect screen shows. */
export function disconnect(): Promise<void> {
  use(null)
  registry.set(connectionAtom, { _tag: "none" })
  return Promise.all([save(URL_KEY, null), save(TOKEN_KEY, null)]).then(() => undefined)
}
