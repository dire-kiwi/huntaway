import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId } from "@huntaway/contracts"
import { hostBoardAtom } from "./watch.ts"

// 6.7: what a profile's approval rules and action log read again on.
const approvalByKey = Atom.family((key: string) =>
  Atom.make((get): number => {
    const [host = "", kind = "", profile = ""] = key.split("\u0000")
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(HostId.make(host)))))
    return board?.approvalRules.get(`${kind} ${profile}`) ?? 0
  }),
)

/**
 * 6.7: the number of the latest event about a host's profile's approval `rules` or action `log`: what shows them reads
 * them again when it changes.
 */
export const approvalSeqAtom = (host: string, kind: "rules" | "log", profile: string): Atom.Atom<number> =>
  approvalByKey(`${host}\u0000${kind}\u0000${profile}`)
