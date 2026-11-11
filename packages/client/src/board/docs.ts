import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId } from "@huntaway/contracts"
import { docsKey } from "./hostBoard.ts"
import { hostBoardAtom } from "./watch.ts"

// 6.3: what the Docs page reads its lists again on: the number of the latest board event about a profile's documents,
// one document's comments, or the profile's docs site (`docs`, `doc_comments`, `docs_site`), 0 before any.

const seqByKey = Atom.family((key: string) =>
  Atom.make((get): number => {
    const [host = "", ...rest] = key.split("\u0000")
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(HostId.make(host)))))
    return board?.docs.get(rest.join("\u0000")) ?? 0
  }),
)

/** The number of the latest event about `kind` of a host's profile (and document): changes when it's to be read again. */
export const docsSeqAtom = (host: string, kind: "docs" | "comments" | "site", profile: string, slug = ""): Atom.Atom<number> =>
  seqByKey(`${host}\u0000${docsKey(kind, profile, slug)}`)
