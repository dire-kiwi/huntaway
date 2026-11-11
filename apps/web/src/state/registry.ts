import { scheduleTask } from "@effect/atom-react"
import { AtomRegistry } from "effect/reactivity"

/**
 * The page's one atom registry. main.tsx gives it to React (`<RegistryContext.Provider value={registry}>`), so the
 * hooks and the plain reads (`board.get()`, `rpc`) see the same atoms. The component checks reset it after each check.
 */
export const registry: AtomRegistry.AtomRegistry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 })
