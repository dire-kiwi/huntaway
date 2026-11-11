import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useEffect } from "react"
import { useBoard } from "../../state/board"
import { loadedUiBuild, servedUiBuildAtom } from "../../state/uiBuild"

/**
 * True once a new UI build is deployed. An open tab keeps running the build it loaded, so it
 * checks when the window regains focus, after reconnecting to the server, and every few minutes.
 */
export function useNewUiBuild(): boolean {
  const served = useAtomValue(servedUiBuildAtom)
  const refresh = useAtomRefresh(servedUiBuildAtom)
  const found = served._tag === "Success" && served.value !== "" && served.value !== loadedUiBuild
  const connected = useBoard((s) => s.connected)
  useEffect(() => {
    if (found || !connected) return undefined
    refresh()
    const id = setInterval(refresh, 5 * 60_000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(id)
      window.removeEventListener("focus", refresh)
    }
  }, [found, connected, refresh])
  return found
}
