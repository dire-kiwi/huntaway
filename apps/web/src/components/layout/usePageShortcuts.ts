import { useEffect, useRef } from "react"
import { assistantHome } from "@huntaway/client"
import { navigate } from "../../state/route"
import { forPage, isShortcut } from "../../shortcuts"
import { profileNames } from "../boardHelpers"
import { board } from "../../state/board"

/**
 * The shortcuts that work on every page (HA-396): the next or previous profile's board, as clicking it in the sidebar
 * opens, and the assistant of `active`, the profile this window's sidebar is on (the one saved in the browser is
 * whichever window's moved last). Not in the Changes tab, whose keys are its own whether or not a panel has one for
 * the key, and a key the page took first (a question card's digits) stays that page's.
 */
export function usePageShortcuts(active: string | undefined) {
  const at = useRef(active)
  useEffect(() => {
    at.current = active
  }, [active])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !forPage(e) || (e.target instanceof Element && e.target.closest("[data-own-keys]"))) return
      const step = isShortcut(e, "profile.next") ? 1 : isShortcut(e, "profile.previous") ? -1 : 0
      if (!step && !isShortcut(e, "assistant")) return
      const { profiles, hosts } = board.get()
      const names = profileNames(profiles)
      const current = at.current
      if (current === undefined || !names.includes(current)) return
      if (!step) {
        // As the sidebar has no Assistant row for a profile without one.
        if (!assistantHome(profiles, hosts, current)) return
        e.preventDefault()
        return navigate({ name: "assistant", profile: current })
      }
      if (names.length < 2) return
      e.preventDefault()
      navigate({ name: "profile", profile: names[(names.indexOf(current) + step + names.length) % names.length] ?? current })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
