import { Effect } from "effect"
import { DesktopRpcs } from "@huntaway/contracts"
import { Desktop } from "../desktop/Desktop.ts"

export const DesktopHandlers = DesktopRpcs.toLayer(
  Effect.gen(function* () {
    const desktop = yield* Desktop
    return DesktopRpcs.of({
      "desktop.status": () => desktop.status,
      "desktop.setEnabled": ({ enabled }) => desktop.setEnabled(enabled),
      "desktop.install": () => desktop.install,
      "desktop.uninstall": () => desktop.uninstall,
      "desktop.stop": () => desktop.stop,
      "desktop.check": () => desktop.check,
      "desktop.frame": (q) => desktop.frame(q),
      "desktop.ops": ({ task_id }) => desktop.ops(task_id),
    })
  }),
)
