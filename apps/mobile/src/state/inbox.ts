import { boardAtom, boardHosts, query } from "@huntaway/client"
import { AsyncResult, Atom } from "effect/reactivity"
import { type HostPrompts, inboxItems, needsAnswer } from "../logic/inbox"

// The Inbox's items, for its screen and for the count on its tab (HE-99). Prompts are no board event, so they are read
// again every few seconds while either shows.

const PROMPTS_EVERY = "5 seconds"

const noPrompts: HostPrompts["prompts"] = []

/** Every usable host's pending prompts, as each last answered. */
const promptsAtom = Atom.make((get): ReadonlyArray<HostPrompts> =>
  boardHosts(get(boardAtom).hosts).map((h) => ({
    host_id: h.id,
    prompts: AsyncResult.getOrElse(get(query("permissions.pending", h.id, {}, { refresh: PROMPTS_EVERY })), () => noPrompts),
  })),
)

/** What waits on the user across the board's hosts, newest first. */
export const inboxAtom = Atom.make((get) => inboxItems(Object.values(get(boardAtom).tasks), get(promptsAtom)))

/** How many of them wait on an answer: the number on the Inbox's tab. */
export const inboxCountAtom = Atom.make((get) => get(inboxAtom).filter(needsAnswer).length)
