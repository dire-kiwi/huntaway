import { useAtomValue } from "@effect/atom-react"
import { boardAtom } from "@huntaway/client"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { loadedUiBuild, servedUiBuildAtom } from "../../state/uiBuild"

// "An open tab detects a new build and offers a reload" (docs/plan/09-frontend.md): an open tab keeps running the build
// it loaded, so it looks at what the server serves when the window regains focus, after reconnecting to the server,
// and every few minutes.

/** Whether the page is connected to its server. */
const connectedAtom = Atom.make((get) => get(boardAtom).connected)

/** What the server serves, looked at again every 5 minutes and when the window gets the focus back. */
const watchedUiBuildAtom = servedUiBuildAtom.pipe(Atom.withRefresh("5 minutes"), Atom.refreshOnWindowFocus)

/** True once the server serves another UI build than this page runs; it stays true, and stops looking, from then. */
const newUiBuildAtom = Atom.make((get): boolean => {
  if (Option.getOrElse(get.self<boolean>(), () => false)) return true
  // Connected again: the server may have restarted on a new build.
  get.subscribe(connectedAtom, (connected) => {
    if (connected) get.refresh(servedUiBuildAtom)
  })
  const served = get(watchedUiBuildAtom)
  return AsyncResult.isSuccess(served) && served.value !== "" && served.value !== loadedUiBuild
})

/** True once a new UI build is deployed. */
export function useNewUiBuild(): boolean {
  return useAtomValue(newUiBuildAtom)
}
