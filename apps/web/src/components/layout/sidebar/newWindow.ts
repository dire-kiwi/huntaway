import { href, type Route } from "../../../router"
import type { MenuItem } from "../../ui"

/** "Open in new window" for page `to`, in the desktop app (HA-298), which can have a window for each profile; none in a browser. */
export function newWindowItems(to: Route, divider = false): MenuItem[] {
  // The desktop shell's bridge (apps/desktop, later on this server).
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  const open: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "openWindow") : undefined
  return typeof open === "function" ? [{ label: "Open in new window", divider, onSelect: () => void Reflect.apply(open, bridge, [href(to)]) }] : []
}
