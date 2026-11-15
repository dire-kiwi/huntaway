import { scheduleTask } from "@effect/atom-react"
import { AtomRegistry } from "effect/reactivity"

/**
 * The app's one atom registry, as the web app's (apps/web/src/state/registry.ts): the root layout gives it to React,
 * so the hooks and the plain reads see the same atoms.
 */
export const registry: AtomRegistry.AtomRegistry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 })
