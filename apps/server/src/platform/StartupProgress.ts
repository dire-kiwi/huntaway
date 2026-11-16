import { Context, Effect } from "effect"
import type { StartupStep } from "@huntaway/contracts"

/**
 * Where the start reports how far it has got before the server listens (docs/plan/06-server.md, Startup): `serve` prints
 * each step as a `HUNTAWAY_PROGRESS {…}` line on stdout for the desktop app. Nothing hears it otherwise (tests, the
 * read-only server).
 */
export const StartupProgress = Context.Reference<(step: StartupStep) => Effect.Effect<void>>("huntaway-server/platform/StartupProgress", {
  defaultValue: () => () => Effect.void,
})
